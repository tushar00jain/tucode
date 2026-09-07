/*---------------------------------------------------------------------------------------------
 *  The Sapling smartlog, in a terminal.
 *
 *  **No glyph is computed here.** The graph is `TextRenderer`'s output — Sapling's own
 *  translation of `renderdag`'s `box_drawing.rs`, the renderer behind the ASCII smartlog `sl`
 *  itself prints — reached through `saplingTextRows.ts`. `subsetForRendering` decides which
 *  commits are drawn and `walkForRendering` decides their edges, both in
 *  `contrib/sapling/tauri/saplingDagModel.ts`. This file finds the repository, keeps the commit
 *  list current, and turns lines of text into rows.
 *
 *  A commit occupies several lines, so **a row of this pane is one line and the cursor moves by
 *  commit**: `Up`/`Down` step to the next commit's first line, and the whole of a commit's block
 *  carries the selection colour. That is what lets the pane sit behind `pane.ts` unchanged —
 *  `RangeMap` indexes one-line rows, which is what a terminal viewport scrolls by.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/sapling/tauri/saplingViewPane.ts
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../vs/base/common/codicons.js';
import { Color } from '../../vs/base/common/color.js';
import { Schemas } from '../../vs/base/common/network.js';
import { KeyCode } from '../../vs/base/common/keyCodes.js';
import { equals } from '../../vs/base/common/objects.js';
import { autorun, derived, derivedObservableWithCache, latestChangedValue, observableValue, runOnChange } from '../../vs/base/common/observable.js';
import { basename } from '../../vs/base/common/resources.js';
import { ThemeIcon } from '../../vs/base/common/themables.js';
import { URI } from '../../vs/base/common/uri.js';
import { localize } from '../../vs/nls.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../vs/platform/files/common/files.js';
import { IMainProcessService } from '../../vs/platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../vs/platform/quickinput/common/quickInput.js';
import { descriptionForeground, foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { listActiveSelectionBackground, listActiveSelectionForeground } from '../../vs/platform/theme/common/colors/listColors.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../vs/platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { ISCMRepository, ISCMViewService } from '../../vs/workbench/contrib/scm/common/scm.js';
import { CommitInfo } from '../../vs/workbench/contrib/sapling/common/types.js';
import { subsetForRendering, toCommitInfo } from '../../vs/workbench/contrib/sapling/tauri/saplingDagModel.js';
import { ISaplingSelectionService } from '../../vs/workbench/contrib/sapling/tauri/saplingSelection.js';
import { ISaplingTextRow, renderToTextRows } from '../../vs/workbench/contrib/sapling/tauri/saplingTextRows.js';
import { ISlCommit, ISlRepositoryInfo, SL_CHANNEL_NAME, SlChannelClient } from '../../vs/workbench/contrib/sapling/tauri/slIpc.js';
import { registerPaneCommand } from '../workbench/commands.js';
import { IKey } from '../terminal/input.js';
import { Pane } from '../workbench/pane.js';
import { ILine } from '../terminal/screen.js';

/** One row of the pane: a line of the graph, and the commit whose block it belongs to. */
interface ILineEntry {
	readonly text: string;
	/** Unset on the status line the pane shows instead of a graph. */
	readonly row?: ISaplingTextRow;
}

/**
 * `'auto'` is the Source Control Graph's own sentinel, and it is what keeps the pane in step
 * with the rest of the workbench: the picker offers it, and it is what a pane that has never
 * been picked in sits on.
 */
type SelectedRepository = 'auto' | string;

type RepositoryQuickPickItem = IQuickPickItem & { readonly repository: SelectedRepository };

export class SaplingPane extends Pane {

	/**
	 * `SaplingViewPane.ID`, as a literal: that file is the DOM view pane and is dormant here, so
	 * importing it for the constant would pull the whole view into the closure. A static, as
	 * upstream's is, so `views.ts` names it rather than repeating it.
	 */
	static readonly ID = 'workbench.sapling.smartlogView';

	readonly viewId = SaplingPane.ID;
	readonly title = localize('saplingPane', "Smartlog");

	/** Built on the first refresh, as `SaplingViewPane` builds it on its first show. */
	private client: SlChannelClient | undefined;

	/** The repository being drawn — `selectedRoot` as the last refresh read it. */
	private root: string | undefined;

	//#region Repositories — `SaplingViewPane`'s own chain, unchanged

	/** Every Sapling root under the workspace folders. */
	private readonly repositories = observableValue<readonly ISlRepositoryInfo[]>(this, []);

	/** What the picker last chose, and the whole of what this pane decides for itself. */
	private readonly selectedRepository = observableValue<SelectedRepository>(this, 'auto');

	/**
	 * The active repository as a Sapling root, cached at upstream's step: an SCM repository `sl`
	 * has never touched has no answer here, and most workspaces hold more of those than Sapling
	 * ones — so without the cache the graph jumps away on every ordinary repository.
	 */
	private readonly activeRoot = derivedObservableWithCache<string | undefined>(this, (reader, lastValue) => {
		const repositories = this.repositories.read(reader);
		const active = this.scmViewService.activeRepository.read(reader)?.repository;

		return this.rootFor(repositories, active) ?? lastValue;
	});

	/** `firstRepository`, which this reads from discovery because that is where repositories arrive. */
	private readonly firstRoot = derived(this, reader => this.repositories.read(reader).at(0)?.root);

	/** `graphRepository`: the pick, or the active repository while the pick is `'auto'`. */
	private readonly graphRoot = derived(this, reader => {
		const selected = this.selectedRepository.read(reader);

		return selected !== 'auto' ? selected : this.activeRoot.read(reader);
	});

	/**
	 * The root the graph draws. `latestChangedValue` is upstream's own composition and it is what
	 * makes the first repository a *seed* rather than a fallback: it wins only while nothing else
	 * has moved, so a workspace that has never had an active Sapling repository still draws
	 * something, and one that has is never dragged back to it.
	 */
	private readonly selectedRoot = latestChangedValue(this, [this.firstRoot, this.graphRoot]);

	//#endregion

	/** The last smartlog as it came off the wire, which is what says a refresh changed nothing. */
	private wireCommits: readonly ISlCommit[] | undefined;

	private commits: readonly CommitInfo[] = [];
	private lines: readonly ILineEntry[] = [{ text: localize('sapling.loading', "Loading…") }];

	/** The row each commit's first line is at, which is what `Up` and `Down` move between. */
	private commitLines: readonly number[] = [];

	/**
	 * One reload at a time. `refreshAgain` is set when a trigger arrives while one is in flight, so
	 * the pane never settles on the state from before the trigger.
	 */
	private refreshRunning: Promise<void> | undefined;
	private refreshAgain = false;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISaplingSelectionService private readonly selectionService: ISaplingSelectionService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IThemeService themeService: IThemeService,
		@ILogService private readonly logService: ILogService
	) {
		super(themeService);

		this._register(registerPaneCommand(this.viewId, {
			id: 'tscode.sapling.refresh',
			title: localize('tscode.sapling.refresh', "Refresh"),
			primary: KeyCode.KeyR,
			handler: () => this.track(this.refresh())
		}));

		// `sapling.pickRepository`, at upstream's own command id. Upstream reaches it from a
		// `MenuId.ViewTitle` toolbar item, which is a click on a view title; a terminal has no title
		// bar to click, so it is a key — the same one the Graph view's picker takes.
		this._register(registerPaneCommand(this.viewId, {
			id: 'sapling.pickRepository',
			title: localize('sapling.command.pickRepository', "Repository Picker"),
			primary: KeyCode.KeyP,
			handler: () => this.track(this.pickRepository())
		}));

		// Upstream's closed-repository cleanup, which is why the pick is not checked for existence
		// where it is read: a selection whose repository has gone away is dropped here, once,
		// rather than being second-guessed on every read.
		this._register(autorun(reader => {
			const repositories = this.repositories.read(reader);
			const selected = this.selectedRepository.read(reader);
			if (selected !== 'auto' && !repositories.some(repository => repository.root === selected)) {
				this.selectedRepository.set(repositories.at(0)?.root ?? 'auto', undefined);
			}
		}));

		// Everything that moves the selection — a pick, the active repository, a repository
		// appearing or going away — arrives here as one changed value, because they are all inputs
		// to the same chain. **Subscribing is also what makes `latestChangedValue` answer**: an
		// unobserved one reports its *last* input, which is `graphRoot`, so the seed would never win.
		this._register(runOnChange(this.selectedRoot, () => this.track(this.refresh())));
	}

	get rowCount(): number {
		return this.lines.length;
	}

	override get hint(): string {
		return localize('sapling.hint', "↑↓ commit");
	}

	/**
	 * **The first fetch is awaited, which tscode's view deliberately does not do.** There, nothing
	 * touches the `sl` channel until the view is first shown, because a view container exists from
	 * boot and a workspace with no Sapling repository must not pay for one. A pane is added at boot
	 * either way, so deferring here only moves the same two `sl` invocations later — and it costs
	 * the property `Input.start()` exists for: a keystroke that arrives during boot must act on the
	 * pane it was meant for, and there is nothing to act on until the graph is there.
	 */
	override async open(): Promise<void> {
		await this.refresh();
	}

	/**
	 * `Up` and `Down` move by commit rather than by line, which is what
	 * `useArrowKeysToChangeSelection` in ISL's `selection.ts` moves. Everything else — page, home,
	 * end, the wheel and a click — moves by line, because those are viewport movements.
	 */
	override handleKey(key: IKey): boolean {
		switch (key.name) {
			case 'up': return this.focusByCommit(-1);
			case 'down': return this.focusByCommit(1);
		}

		return super.handleKey(key);
	}

	/**
	 * The focused commit is the selection the Sapling views share, so the cursor is what
	 * `ISaplingSelectionService` publishes. Upstream moves it on a click instead — its
	 * `onClickToSelect` also clears the selection back to "." when the selected commit is clicked
	 * again, which has no counterpart when the selection follows a cursor.
	 */
	protected override focusTo(index: number): boolean {
		const handled = super.focusTo(index);

		const info = this.lines[this.focus]?.row?.info;
		if (this.root && info) {
			this.selectionService.select({ root: this.root, commit: info, explicit: true });
		}

		return handled;
	}

	/**
	 * A commit's block is one selection, not one line per line: the cursor is on a commit and the
	 * lines its graph needed are part of it. `focused` is therefore unused — it marks the one line
	 * the cursor is on, and the block is wider than that.
	 */
	protected renderRow(index: number): ILine {
		const theme = this.themeService.getColorTheme();
		const entry = this.lines[index];

		if (!entry.row) {
			return [{ text: ` ${entry.text}`, fg: theme.getColor(descriptionForeground) }];
		}

		return [{
			text: entry.text,
			fg: this.selected(index) ? theme.getColor(listActiveSelectionForeground) : theme.getColor(foreground),
			bg: this.rowBackground(index)
		}];
	}

	/** Which of the block's lines carry its selection, which is every line of the commit's own. */
	private selected(index: number): boolean {
		const row = this.lines[index]?.row;

		return row !== undefined && row === this.lines[this.focus]?.row;
	}

	protected override rowBackground(index: number): Color | undefined {
		return this.selected(index) ? this.themeService.getColorTheme().getColor(listActiveSelectionBackground) : undefined;
	}

	//#region Refresh

	refresh(): Promise<void> {
		if (this.refreshRunning) {
			this.refreshAgain = true;
			return this.refreshRunning;
		}

		this.refreshRunning = this.doRefresh().finally(() => { this.refreshRunning = undefined; });
		return this.refreshRunning;
	}

	/** `SaplingViewPane.doRefresh`, without the watch — see `§7.4` of the architecture doc. */
	private async doRefresh(): Promise<void> {
		const client = this.client ??= new SlChannelClient(this.mainProcessService.getChannel(SL_CHANNEL_NAME));

		let stale: boolean;

		do {
			try {
				await this.updateRepositories(client);
			} catch (error) {
				this.logService.error('[sl] repository discovery failed', error);
				// `Unavailable` is the channel's spelling of `SlError::Spawn`: the walk found
				// candidates and `sl` never started, which is a different thing to tell the user
				// than a repository that could not be read.
				this.setStatus(toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.Unavailable
					? localize('sapling.slUnavailable', "Running sl failed. Check that Sapling is installed and allowed to run. See the log for details.")
					: localize('sapling.discoveryFailed', "Discovering Sapling repositories failed. See the log for details."));
				return;
			}

			// **The flag is cleared here rather than at the top of the loop**, because discovery
			// moves `selectedRoot` itself and the read below is where that lands: the trigger it
			// fired is not a reason to go round again. A pick that arrives after this read still is.
			this.refreshAgain = false;

			// Which root is drawn is `selectedRoot`'s to decide, from the pick, the active SCM
			// repository and discovery's own first entry as the seed.
			const root = this.root = this.selectedRoot.get();
			if (!root) {
				// The two empty states upstream registers as welcome content, and the distinction it
				// draws with `saplingRepositoryCount`: none were found, or none of the ones found is
				// being drawn. A pick of `Auto` in a workspace whose active repository is not a
				// Sapling one is the second.
				this.setStatus(this.repositories.get().length === 0
					? localize('sapling.noRepository', "No Sapling repository was found in the open folders.")
					: localize('sapling.noSelection', "No repository is selected.\nOpen a file in a Sapling repository, or choose one from the repository picker."));
				return;
			}

			let result;
			try {
				result = await client.smartlog(root);
			} catch (error) {
				this.logService.error(`[sl] smartlog failed for ${root}`, error);
				this.setStatus(localize('sapling.smartlogFailed', "Reading the smartlog failed. See the log for details."));
				return;
			}

			if (result.kind === 'failed') {
				this.logService.warn(`[sl] ${result.root}: ${result.message}`);
				this.setStatus(result.message);
				return;
			}

			// A mutation interleaved with the read, so the snapshot describes neither state. Poll
			// again rather than paint it: stale is a miss, never a wrong answer.
			stale = result.stale;
			if (!stale) {
				this.setCommits(root, result.commits);
			}
		} while (stale || this.refreshAgain);
	}

	/**
	 * `SaplingViewPane.updateRepositories`. Which repositories exist is a walk of the workspace
	 * folders, because a Sapling root can be nested inside one or sit beside another; which of them
	 * is drawn is `selectedRoot`'s to decide, and it derives that from this list.
	 */
	private async updateRepositories(client: SlChannelClient): Promise<void> {
		const repositories: ISlRepositoryInfo[] = [];

		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}

			repositories.push(...await client.discover(folder.uri.fsPath));
		}

		this.repositories.set(repositories, undefined);
	}

	/**
	 * The repository picker's action, and the reason `sl` has one: nested and sibling roots.
	 * `SaplingViewPane.pickRepository`, body unchanged — the Auto item first, a separator, then the
	 * repositories, because Auto is the whole of how the pane stays in step with the status bar and
	 * a picker without it can only opt out of that, never back in.
	 */
	async pickRepository(): Promise<void> {
		const picks: (RepositoryQuickPickItem | IQuickPickSeparator)[] = [
			{
				label: localize('sapling.auto', "Auto"),
				description: localize('sapling.activeRepository', "Show the smartlog for the active repository"),
				repository: 'auto'
			},
			{ type: 'separator' }
		];

		picks.push(...this.repositories.get().map<RepositoryQuickPickItem>(repository => ({
			label: basename(URI.file(repository.root)),
			description: repository.root,
			iconClass: ThemeIcon.asClassName(Codicon.repo),
			repository: repository.root
		})));

		const pick = await this.quickInputService.pick(picks, {
			placeHolder: localize('sapling.pickRepository', "Select the repository to show the smartlog for")
		});

		if (pick) {
			// The pick changes this view and nothing else, as it does upstream: the Graph view never
			// writes to `activeRepository` either, and the two agree again the moment `'auto'` is
			// picked back.
			this.selectedRepository.set(pick.repository, undefined);

			// The refresh the line above triggered, awaited here because a keystroke's command is
			// not — `AbstractKeybindingService._doDispatch` drops the promise, so a pick whose whole
			// effect is an `sl` invocation away would otherwise finish before it did anything.
			await this.refresh();
		}
	}

	/** The discovered Sapling root an SCM repository stands for, if it is one of them. */
	private rootFor(repositories: readonly ISlRepositoryInfo[], repository: ISCMRepository | undefined): string | undefined {
		const rootUri = repository?.provider.rootUri;
		if (!rootUri) {
			return undefined;
		}

		return repositories.find(candidate =>
			this.uriIdentityService.extUri.isEqual(URI.file(candidate.root), rootUri))?.root;
	}

	/**
	 * `subsetForRendering` decides what is drawn, then `renderToTextRows` draws it — upstream's own
	 * order, and it has to be: hiding a row changes which columns the rows below it claim.
	 *
	 * **A refresh that read the same smartlog paints nothing**, as it paints nothing in tscode: the
	 * rows are rebuilt wholesale, so a repaint would move the cursor and the scroll position, and
	 * refreshes read a repository that has not necessarily changed.
	 */
	private setCommits(root: string, commits: readonly ISlCommit[]): void {
		if (this.wireCommits && equals(this.wireCommits, commits)) {
			return;
		}

		this.wireCommits = commits;
		this.commits = subsetForRendering(commits.map(toCommitInfo));

		const lines: ILineEntry[] = [];
		const commitLines: number[] = [];
		for (const row of renderToTextRows(this.commits)) {
			commitLines.push(lines.length);
			lines.push(...row.lines.map(text => ({ text, row })));
		}

		this.commitLines = commitLines;
		this.lines = lines.length > 0 ? lines : [{ text: localize('sapling.noCommits', "No commits found.") }];
		this.didChangeRows();

		// The selection follows the fetch, so a rebase or an amend leaves the cursor on the commit
		// that is still there rather than on whatever row took its index.
		this.selectionService.reconcile(root, this.commits);
		this.focusSelected();
	}

	/**
	 * A failure the pane cannot draw around, and the state before the first fetch answers. Welcome
	 * content is written as paragraphs, so a `\n` in one becomes a row here — a span carrying it
	 * would scroll the whole frame instead.
	 */
	private setStatus(text: string): void {
		this.wireCommits = undefined;
		this.commits = [];
		this.commitLines = [];
		this.lines = text.split('\n').map(line => ({ text: line }));
		this.didChangeRows();
	}

	//#endregion

	/** The line `reconcile` left the selection on, so a refetch does not move the cursor. */
	private focusSelected(): void {
		const hash = this.selectionService.selection?.commit.hash;
		const index = this.lines.findIndex(line => line.row?.info.hash === hash);
		if (index !== -1) {
			this.focusTo(index);
		}
	}

	private focusByCommit(delta: number): boolean {
		const current = this.commitLines.findLastIndex(line => line <= this.focus);
		if (current === -1) {
			return true;
		}

		return this.focusTo(this.commitLines[Math.max(0, Math.min(current + delta, this.commitLines.length - 1))]);
	}
}
