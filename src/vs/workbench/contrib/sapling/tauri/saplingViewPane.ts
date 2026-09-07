/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, EventType, reset } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { equals } from '../../../../base/common/objects.js';
import { autorun, derived, derivedObservableWithCache, latestChangedValue, observableValue, runOnChange } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { trackSlWork } from '../../../browser/tauri/settled.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ISCMRepository, ISCMViewService } from '../../scm/common/scm.js';
import { CoalescingRefresh } from '../../scm/tauri/coalescingRefresh.js';
import { watcherExcludes } from '../../scm/tauri/watcherExcludes.js';
import { NARROW_COMMIT_TREE_WIDTH } from '../common/responsive.js';
import { CommitInfo } from '../common/types.js';
import { renderToRows, subsetForRendering, toCommitInfo } from './saplingDagModel.js';
import { renderDagRows } from './saplingRowRenderer.js';
import { ISaplingSelectionService } from './saplingSelection.js';
import { clickSelection, stepSelection } from './saplingSelectionModel.js';
import { ISlCommit, ISlRepositoryInfo, SL_CHANNEL_NAME, SlChannelClient } from './slIpc.js';

// ISL's own stylesheets, copied and `@scope`-confined by `scripts/copy-from-sapling.ps1`,
// then the pane's own — which resolves their variables and states the divergences, so it
// has to come after them.
import '../media/RenderDag.css';
import '../media/CommitTreeList.css';
import '../media/InlineBadge.css';
import '../media/UncommittedChanges.css';
import '../media/Tag.css';
import '../media/Bookmark.css';
import './sapling.css';

/**
 * `'auto'` is the Source Control Graph's own sentinel, and it is what keeps the pane in step
 * with the rest of the workbench: the picker offers it, and it is what a pane that has never
 * been picked in sits on.
 */
type SelectedRepository = 'auto' | string;

/**
 * How many Sapling repositories discovery found, which is what the welcome content branches on —
 * `scm.providerCount`'s counterpart, and registered against for the same reason: "none were
 * found" and "none is selected" are different things to say, and only a context key can tell the
 * views registry which one applies.
 */
export const SaplingRepositoryCount = new RawContextKey<number>('saplingRepositoryCount', 0);

type RepositoryQuickPickItem = IQuickPickItem & { readonly repository: SelectedRepository };

/**
 * The smartlog. The graph column is drawn by Sapling's own `render.ts`, so this pane's job is the
 * three things around it: find the repositories, keep the commit list current, and put the rows
 * in the document.
 *
 * Nothing here touches the `sl` channel until the pane is first shown — the view container exists
 * from boot, but a workspace with no Sapling repository must not pay for it.
 */
export class SaplingViewPane extends ViewPane {

	static readonly ID = 'workbench.sapling.smartlogView';

	/** `.commit-tree-root`, holding every row, and the scroller ISL puts above it. */
	private dagContainer: HTMLElement | undefined;
	private scrollContainer: HTMLElement | undefined;
	private scroller: DomScrollableElement | undefined;
	private messageContainer: HTMLElement | undefined;

	/** Built on the first show, which is what keeps the channel out of the boot path. */
	private client: SlChannelClient | undefined;

	/** Every Sapling root under the workspace folders. */
	private readonly repositories = observableValue<readonly ISlRepositoryInfo[]>(this, []);

	/**
	 * What the picker last chose, and the whole of what this pane decides for itself.
	 *
	 * **Ported from `SCMHistoryViewModel` in `scmHistoryViewPane.ts`**, which is the same view
	 * of the same thing: one repository, a picker in the title, and an expectation that it agrees
	 * with the status bar. Its model is a selection that is `'auto'` until picked and a derived
	 * repository that falls back to `ISCMViewService.activeRepository` — so the sync is a value
	 * this reads, never an event it has to catch. The imperative version of this pane followed
	 * change events instead and lost the ones that arrived while it was hidden.
	 */
	private readonly selectedRepository = observableValue<SelectedRepository>(this, 'auto');

	/**
	 * The active repository as a Sapling root, and `_activeEditorRepositoryObs`'s counterpart.
	 *
	 * **It is a cached derived for upstream's reason, at upstream's step.** There, an active
	 * editor whose resource belongs to no repository returns `lastValue` rather than moving the
	 * view somewhere nobody asked for; here the same thing happens one step later, because
	 * `scmService.getRepository` has already answered and it is *this* mapping — an SCM
	 * repository to one of the discovered Sapling roots — that has no answer for a git checkout
	 * `sl` has never touched. Most workspaces hold more of those than Sapling ones, so without
	 * the cache the graph jumps away on every ordinary editor and reads as not following at all.
	 */
	private readonly activeRoot = derivedObservableWithCache<string | undefined>(this, (reader, lastValue) => {
		const repositories = this.repositories.read(reader);
		const active = this.scmViewService.activeRepository.read(reader)?.repository;
		return this.rootFor(repositories, active) ?? lastValue;
	});

	/**
	 * `firstRepository`, which upstream reads once from `ISCMService` and this reads from
	 * discovery, because discovery is what this pane's repositories arrive through.
	 */
	private readonly firstRoot = derived(this, reader => this.repositories.read(reader).at(0)?.root);

	/**
	 * `graphRepository`: the pick, or the active repository while the pick is `'auto'`.
	 *
	 * It is undefined until something is active, exactly as upstream's is — and, as upstream
	 * does, the view has an empty state to show for that rather than a value invented to avoid
	 * it. `latestChangedValue` reports whichever input changed *last*, so an undefined here is
	 * the answer until something moves, and `shouldShowWelcome` is what says so on screen.
	 */
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

	/** Set while discovery is failing — see `shouldShowWelcome`. */
	private discoveryFailed = false;

	/** Bound in the constructor, because the context key service arrives with it. */
	private readonly repositoryCount: IContextKey<number>;

	/** The commits currently drawn — what a click resolves a hash against. */
	private commits: readonly CommitInfo[] = [];

	/** The last smartlog as it came off the wire, which is what says a refresh changed nothing. */
	private wireCommits: readonly ISlCommit[] | undefined;

	/** The watch on the selected repository, which is what makes its smartlog stale. */
	private readonly repositoryDisposables = this._register(new DisposableStore());

	/** Set by the paths that can change which repositories exist; cleared by the walk itself. */
	private rediscover = true;

	private readonly refresher = this._register(new CoalescingRefresh(() => this.doRefresh()));

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ISaplingSelectionService private readonly selectionService: ISaplingSelectionService,
		@ILogService private readonly logService: ILogService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.repositoryCount = SaplingRepositoryCount.bindTo(contextKeyService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('sapling-smartlog');

		this.messageContainer = append(container, $('.sapling-message.sapling-hidden'));

		// ISL's own shape: `.main-content-area` holds `.commit-tree-root`, and every row is in it.
		// Nothing is virtualised, because a smartlog is bounded by construction — so the rows are
		// ordinary DOM, and the buttons and drag targets ISL nests in them own their own pointer
		// events.
		//
		// The scroller around it is the workbench's rather than upstream's plain `overflow: auto`,
		// and it has to be: see `layoutBody` and the architecture doc.
		const scrollContainer = this.scrollContainer = $('.sapling-scroll');
		// The graph is a keyboard surface, not only a click target, so it is in the tab order and
		// takes focus — which is also what publishes `focusedView` for the pane's own keybindings:
		// `ViewPane.render` tracks focus over the whole element, descendants included.
		scrollContainer.tabIndex = 0;
		this.dagContainer = append(scrollContainer, $('.render-dag.commit-tree-root'));
		this.scroller = this._register(new DomScrollableElement(scrollContainer, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false
		}));
		append(container, this.scroller.getDomNode());

		// `useExtraCommitRowProps` in `CommitTreeList.tsx` puts the click on each commit row. One
		// delegated listener stands in for the per-row handlers a React tree gets for free — the
		// rows are rebuilt on every refresh, and a listener per row would have to be too.
		this._register(addDisposableListener(this.dagContainer, EventType.CLICK, event => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('.render-dag-row-commit');
			this.selectRow(row?.dataset.commitHash);
		}));

		// The keyboard's half of the same gesture. It is a listener on the widget rather than a
		// keybinding rule because the arrows are the workbench's — the keybinding service dispatches
		// on the window in the bubble phase, so a handler here answers first, which is the precedence
		// every other widget that consumes arrows already has.
		this._register(addDisposableListener(scrollContainer, EventType.KEY_DOWN, event => {
			const keyCode = new StandardKeyboardEvent(event).keyCode;
			if (keyCode !== KeyCode.UpArrow && keyCode !== KeyCode.DownArrow) {
				return;
			}

			EventHelper.stop(event, true);
			this.stepSelection(keyCode === KeyCode.UpArrow ? -1 : 1);
		}));

		this._register(this.selectionService.onDidChangeSelection(() => this.updateSelectedRow()));

		// A workspace folder change can add or remove repositories, so it is the same path as the
		// first load rather than a separate one.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			if (this.client) {
				this.refresh();
			}
		}));

		// Upstream's closed-repository cleanup, which is why the pick is not checked for existence
		// where it is read: a selection whose repository has gone away is dropped here, once,
		// rather than being second-guessed on every read. `SCMHistoryViewModel` does the same on
		// `onDidRemoveRepository`; discovery's list is where a Sapling root goes away.
		this._register(autorun(reader => {
			const repositories = this.repositories.read(reader);
			const selected = this.selectedRepository.read(reader);
			if (selected !== 'auto' && !repositories.some(repository => repository.root === selected)) {
				this.selectedRepository.set(repositories.at(0)?.root ?? 'auto', undefined);
			}
		}));

		// Everything that moves the selection — a pick, the active repository, a repository
		// appearing or going away — arrives here as one changed value, because they are all
		// inputs to the same chain.
		this._register(runOnChange(this.selectedRoot, root => this.onDidChangeSelectedRoot(root)));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.refresh();
			}
		}));

		if (this.isBodyVisible()) {
			this.refresh();
		}
	}

	/**
	 * **The scroller is a `DomScrollableElement`, not upstream's plain `overflow: auto` div.**
	 *
	 * It is the shape every stock sidebar view has, and inside a pane body a bare `overflow: auto`
	 * has something competing for its wheel events: the split view that stacks the panes wraps
	 * them in a `SmoothScrollableElement` with `scrollPredominantAxis` on (`splitview.ts`), and a
	 * trackpad gesture is never purely horizontal. An inner scrollable element handles the event
	 * before that ancestor does, so the competition cannot arise. It is the one place the graph
	 * deliberately does not reproduce ISL's DOM — ISL's document holds nothing but ISL, and has no
	 * outer scroller to lose a gesture to.
	 *
	 * Its dimensions are not observed, so `scanDomNode` has to be called wherever the content or
	 * the pane changes size — and the element it wraps has to be the one that *clips*, or it
	 * measures its own content as its viewport and finds nothing to scroll. `sapling.css` says
	 * more.
	 */
	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.scroller?.scanDomNode();
		// `isNarrowCommitTree` in `responsive.tsx`: below 800px ISL wraps `.commit-details` onto
		// a second line, drops `.commit-tree-root`'s 450px minimum and hides the wide drag
		// target. A sidebar is narrow by upstream's own rule almost always. Upstream compares a
		// `ResizeObserver` on its main content area; the pane's own width is the same measurement.
		this.dagContainer?.classList.toggle('commit-tree-narrow', width < NARROW_COMMIT_TREE_WIDTH);
	}

	//#region Selection

	/**
	 * The graph is what the pane is for, so focusing the view focuses it — and that is what makes
	 * the arrows and the pane's own commands reachable, since both need the keyboard here.
	 */
	override focus(): void {
		// `trackFocus` in `ViewPane.render` watches the whole element, so focusing the graph is what
		// announces the view as focused; there is nothing to fire by hand. The welcome content is
		// the other thing that can be in the body, and it is `super.focus`'s to place.
		if (this.scrollContainer && !this.shouldShowWelcome()) {
			this.scrollContainer.focus();
			return;
		}

		super.focus();
	}

	/** `onClickToSelect`: clicking the selected commit again clears the selection back to ".". */
	private selectRow(hash: string | undefined): void {
		const root = this.selectedRoot.get();
		if (root) {
			clickSelection(this.selectionService, root, this.commits, hash);
		}
	}

	/** The arrow keys' step, which moves the selection by one commit rather than by one row. */
	private stepSelection(delta: number): void {
		const root = this.selectedRoot.get();
		if (root) {
			stepSelection(this.selectionService, root, this.commits, delta);
		}
	}

	/** `commit-row-selected` in `CommitTreeList.css`, moved rather than re-rendered. */
	private updateSelectedRow(): void {
		if (!this.dagContainer) {
			return;
		}

		const selection = this.selectionService.selection;
		const hash = selection?.explicit ? selection.commit.hash : undefined;

		for (const row of this.dagContainer.querySelectorAll<HTMLElement>('.render-dag-row-commit')) {
			const selected = hash !== undefined && row.dataset.commitHash === hash;
			row.classList.toggle('commit-row-selected', selected);
			if (selected) {
				this.reveal(row);
			}
		}
	}

	/**
	 * `IconSelectBox.reveal`: bring the row into the scroller's viewport by the shortest move, and
	 * leave it alone when it is already there. The offset is measured against the content rather
	 * than read off `offsetTop`, because the rows nest inside groups whose positioning is ISL's.
	 */
	private reveal(row: HTMLElement): void {
		if (!this.scroller || !this.dagContainer) {
			return;
		}

		const top = row.getBoundingClientRect().top - this.dagContainer.getBoundingClientRect().top;
		const { height } = this.scroller.getScrollDimensions();
		const { scrollTop } = this.scroller.getScrollPosition();

		if (top + row.clientHeight > scrollTop + height) {
			this.scroller.setScrollPosition({ scrollTop: top + row.clientHeight - height });
		} else if (top < scrollTop) {
			this.scroller.setScrollPosition({ scrollTop: top });
		}
	}

	//#endregion

	/**
	 * The welcome content stands in for the empty state, so "no repository" is a state of the view
	 * rather than an error in it. It is only shown once discovery has answered.
	 *
	 * **A failed discovery has not answered.** The welcome content replaces the whole body, so
	 * showing it after a failure would both hide the message explaining the failure and assert
	 * the one thing that is not known — that the workspace holds no repository.
	 *
	 * Nothing selected is the other empty state, and `saplingRepositoryCount` is what tells the
	 * two apart: no repository was found, or none of the ones found is being drawn. There is one
	 * condition here because there is one question — is there a root to draw — and `selectedRoot`
	 * is the whole answer to it.
	 */
	override shouldShowWelcome(): boolean {
		return this.client !== undefined && !this.discoveryFailed && this.selectedRoot.get() === undefined;
	}

	//#region Repositories

	/**
	 * The repository picker's action, and the reason `sl` has one: nested and sibling roots.
	 *
	 * `RepositoryPicker` in `scmHistoryViewPane.ts` is what this reproduces — the Auto item first,
	 * a separator, then the repositories — because Auto is the whole of how the graph stays in
	 * step with the status bar, and a picker without it can only opt out of that, never back in.
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
			// **The pick changes this view and nothing else.** `SCMHistoryViewPane.pickRepository`
			// does exactly this — `_treeViewModel.setRepository(result.repository)` and no more —
			// and the Graph view never writes to `activeRepository`: its own `focus` override is
			// DOM focus of its tree. So a pick here does not move the status bar either, and the
			// two agree again the moment `'auto'` is picked back.
			this.selectedRepository.set(pick.repository, undefined);
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
	 * The root being drawn moved: re-aim the watch and redraw. A pick, the active repository, a
	 * repository appearing or going away are all inputs to `selectedRoot`, so this is the one
	 * place any of them arrives.
	 */
	private onDidChangeSelectedRoot(root: string | undefined): void {
		this.watchSelected();
		this.updateTitleForSelection(root);
		// Losing the root is an empty state rather than a redraw, and the welcome content is
		// what draws it — see `shouldShowWelcome`.
		this._onDidChangeViewWelcomeState.fire();
		this.refresh();
	}

	/** Which repository is being shown only needs saying when there is more than one. */
	private updateTitleForSelection(root: string | undefined): void {
		this.updateTitleDescription(root && this.repositories.get().length > 1 ? basename(URI.file(root)) : undefined);
	}

	/**
	 * Reconcile the known repositories with what the workspace folders contain. Which of them is
	 * drawn is `selectedRoot`'s to decide, and it derives that from this list — so a repository
	 * appearing or going away moves the selection without anything here saying so.
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
		this.repositoryCount.set(repositories.length);
		this.discoveryFailed = false;
		this._onDidChangeViewWelcomeState.fire();
		this.updateTitleForSelection(this.selectedRoot.get());
	}

	/** The repository's own working tree is what makes its smartlog stale. */
	private watchSelected(): void {
		this.repositoryDisposables.clear();

		const root = this.selectedRoot.get();
		if (!root) {
			return;
		}

		const rootUri = URI.file(root);
		this.repositoryDisposables.add(this.fileService.watch(rootUri, { recursive: true, excludes: watcherExcludes(this.configurationService, rootUri) }));
		this.repositoryDisposables.add(this.fileService.onDidFilesChange(event => {
			if (event.affects(rootUri)) {
				this.refresher.schedule();
			}
		}));
	}

	//#endregion

	//#region Refresh

	/**
	 * Registered as outstanding work, because it is the one thing in this window that repaints a
	 * whole view off a channel round trip: `whenSettled` covers the trees and the searches, and
	 * without this a reading taken after a pick is a reading of the graph the pick replaced.
	 */
	refresh(): Promise<void> {
		this.rediscover = true;
		return trackSlWork(this.refresher.refresh());
	}

	/** One reload. Answers whether the smartlog it read was stale, which is `refresher`'s cue. */
	private async doRefresh(): Promise<boolean> {
		const client = this.client ??= new SlChannelClient(this.mainProcessService.getChannel(SL_CHANNEL_NAME));

		try {
			// Discovery walks every workspace folder looking for repositories, so it answers to the
			// things that can change the answer — the folders, and a person asking — and not to the
			// working-tree watch. A poll per file change that re-walks the tree first costs the walk
			// at the rate of the changes, which for a tree something writes into is continuous.
			if (this.rediscover) {
				this.rediscover = false;
				await this.updateRepositories(client);
			}
		} catch (error) {
			this.rediscover = true;
			this.logService.error('[sl] repository discovery failed', error);
			this.discoveryFailed = true;
			this._onDidChangeViewWelcomeState.fire();
			// `Unavailable` is the channel's spelling of `SlError::Spawn`: the walk found
			// candidates and `sl` never started, which is a different thing to tell the user
			// than a repository that could not be read.
			this.setMessage(toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.Unavailable
				? localize('sapling.slUnavailable', "Running sl failed. Check that Sapling is installed and allowed to run. See the log for details.")
				: localize('sapling.discoveryFailed', "Discovering Sapling repositories failed. See the log for details."));
			return false;
		}

		const root = this.selectedRoot.get();
		if (!root) {
			this.setCommits(undefined, []);
			return false;
		}

		let result;
		try {
			result = await client.smartlog(root);
		} catch (error) {
			this.logService.error(`[sl] smartlog failed for ${root}`, error);
			this.setMessage(localize('sapling.smartlogFailed', "Reading the smartlog failed. See the log for details."));
			return false;
		}

		if (result.kind === 'failed') {
			this.logService.warn(`[sl] ${result.root}: ${result.message}`);
			this.setMessage(result.message);
			return false;
		}

		// A mutation interleaved with the read, so the snapshot describes neither state. Poll
		// again rather than paint it: stale is a miss, never a wrong answer.
		if (!result.stale) {
			this.setCommits(root, result.commits);
		}

		return result.stale;
	}

	/**
	 * `subsetForRendering` decides what is drawn, then `renderToRows` lays it out — upstream's own
	 * order, and it has to be: hiding a row changes which columns the rows below it claim.
	 *
	 * **A refresh that read the same smartlog paints nothing.** The rows are torn down and rebuilt
	 * wholesale, so repainting an unchanged graph would drop the scroll position, the selection
	 * class and any focus in it — and refreshes are frequent, because the watch is on the
	 * repository's own working tree. The wire commits are plain JSON, which is what makes "the
	 * same smartlog" a structural comparison rather than a hash of anything.
	 */
	private setCommits(root: string | undefined, commits: readonly ISlCommit[]): void {
		this.setMessage(undefined);

		if (this.wireCommits && equals(this.wireCommits, commits)) {
			return;
		}
		this.wireCommits = commits;
		this.commits = subsetForRendering(commits.map(toCommitInfo));

		if (this.dagContainer) {
			reset(this.dagContainer, ...renderDagRows(renderToRows(this.commits)));
			this.scroller?.scanDomNode();
		}

		// The selection follows the fetch: the commit-info view below must never be left drawing a
		// commit the graph no longer has.
		if (root) {
			this.selectionService.reconcile(root, this.commits);
		} else {
			this.selectionService.select(undefined);
		}
		this.updateSelectedRow();
	}

	/** A failure the view cannot draw around. An empty workspace is the welcome content, not this. */
	private setMessage(message: string | undefined): void {
		if (!this.messageContainer || !this.scroller || !this.dagContainer) {
			return;
		}

		if (message !== undefined) {
			reset(this.dagContainer);
		}

		this.messageContainer.textContent = message ?? '';
		this.messageContainer.classList.toggle('sapling-hidden', message === undefined);
		// The scroller's own node, not the content inside it: hiding the content would leave the
		// wrapper holding the pane's height with nothing in it.
		this.scroller.getDomNode().classList.toggle('sapling-hidden', message !== undefined);
	}

	//#endregion
}
