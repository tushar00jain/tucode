/*---------------------------------------------------------------------------------------------
 *  The Sapling commit-info drawer, in a terminal.
 *
 *  `SaplingCommitInfoViewPane` is vendored and dormant — a `ViewPane` whose stylesheets T01 deleted —
 *  and this is the same view over the same reads: the selection comes from `ISaplingSelectionService`,
 *  which the smartlog pane already publishes, and the changed files come from the `sl` channel's
 *  `changedFiles`, which is a second `sl log` template rather than an `sl status --change`. What is
 *  ported from that file is what decides the *content*: the byline's order, the sample painting first
 *  with the statuses replacing it, and the render generation that drops a late reply.
 *
 *  Everything upstream can edit here is absent for the same reason it is absent there — the fields
 *  are click-to-edit text areas over an in-progress message store, and this port has no mutation
 *  path — so the pane is the shape a commit is *displayed* in.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/sapling/tauri/saplingCommitInfoViewPane.ts
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../vs/nls.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IMainProcessService } from '../../vs/platform/ipc/common/mainProcessService.js';
import { descriptionForeground, foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { listActiveSelectionForeground } from '../../vs/platform/theme/common/colors/listColors.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { relativeDate } from '../../vs/workbench/contrib/sapling/common/relativeDate.js';
import { ChangedFile, CommitInfo } from '../../vs/workbench/contrib/sapling/common/types.js';
import { ISaplingSelection, ISaplingSelectionService } from '../../vs/workbench/contrib/sapling/tauri/saplingSelection.js';
import { SL_CHANNEL_NAME, SlChannelClient } from '../../vs/workbench/contrib/sapling/tauri/slIpc.js';
import { Pane } from '../workbench/pane.js';
import { ILine } from '../terminal/screen.js';

/** One row of the pane: its text, and whether it is a section title rather than content. */
interface IInfoRow {
	readonly text: string;
	readonly title?: boolean;
	readonly dim?: boolean;
}

export class SaplingCommitInfoPane extends Pane {

	/** `SaplingCommitInfoViewPane.ID`, as a literal for `saplingPane.ts`'s reason. */
	static readonly ID = 'workbench.sapling.commitInfoView';

	readonly viewId = SaplingCommitInfoPane.ID;
	readonly title = localize('saplingCommitInfoPane', "Commit Info");

	/** Built on the first read, as the view builds it on its first render. */
	private client: SlChannelClient | undefined;

	/**
	 * Which render a changed-files read belongs to. The read is a channel round trip and the
	 * selection can move under it, so the answer is dropped unless the render that asked for it is
	 * still the one on screen — a late reply must never repaint a commit nobody is looking at.
	 */
	private renderGeneration = 0;

	private rows: readonly IInfoRow[] = [];

	/** What is being drawn: the selected commit, and the statuses once the second read has landed. */
	private selection: ISaplingSelection | undefined;
	private files: readonly ChangedFile[] | undefined;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@ISaplingSelectionService private readonly selectionService: ISaplingSelectionService,
		@IThemeService themeService: IThemeService,
		@ILogService private readonly logService: ILogService
	) {
		super(themeService);

		this._register(this.selectionService.onDidChangeSelection(() => this.renderSelection()));
	}

	get rowCount(): number {
		return this.rows.length;
	}

	/** The smartlog above has usually published a selection before this pane opens; if not, it will. */
	override async open(): Promise<void> {
		if (this.renderGeneration === 0) {
			this.renderSelection();
		}
	}

	/** `SaplingCommitInfoViewPane.renderSelection`: the sample paints now, the statuses replace it. */
	private renderSelection(): void {
		const generation = ++this.renderGeneration;

		this.selection = this.selectionService.selection;
		this.files = undefined;
		this.render();

		if (this.selection) {
			this.track(this.fetchChangedFiles(this.selection, generation));
		}
	}

	/** `SaplingCommitInfoViewPane.fetchChangedFiles`: the statuses, and the sample left alone if it fails. */
	private async fetchChangedFiles(selection: ISaplingSelection, generation: number): Promise<void> {
		const client = this.client ??= new SlChannelClient(this.mainProcessService.getChannel(SL_CHANNEL_NAME));

		try {
			const files = await client.changedFiles(selection.root, selection.commit.hash);
			if (generation === this.renderGeneration) {
				this.files = files;
				this.render();
			}
		} catch (error) {
			// The sample stays on screen: a failed statuses read is less information, not none.
			this.logService.error(`[sl] changed files failed for ${selection.commit.hash}`, error);
		}
	}

	/** The four sections `CommitInfoDetails` renders, in its order. */
	private render(): void {
		const commit = this.selection?.commit;
		if (!commit) {
			// `shouldShowWelcome` upstream: nothing to show until the graph above has resolved ".".
			this.rows = [{ text: localize('sapling.noCommit', "Select a commit in the smartlog above."), dim: true }];
			this.didChangeRows();

			return;
		}

		// The sample carries paths and no statuses, which is why the second read exists.
		const files = this.files ?? commit.filePathsSample.map(path => ({ path, status: 'M' as const }));

		this.rows = [
			{ text: commit.title },
			{ text: byline(commit), dim: true },
			{ text: localize('sapling.info.description', "Description"), title: true },
			...describe(commit),
			{ text: localize('sapling.info.filesChanged', "Files Changed"), title: true },
			...changedFiles(files, commit.totalFileCount)
		];
		this.didChangeRows();
	}

	protected renderRow(index: number, focused: boolean): ILine {
		const theme = this.themeService.getColorTheme();
		const row = this.rows[index];
		const fg = focused ? theme.getColor(listActiveSelectionForeground) : theme.getColor(row.dim ? descriptionForeground : foreground);

		return [{
			text: ` ${row.text}`,
			fg,
			bg: this.rowBackground(index, focused),
			bold: row.title
		}];
	}
}

/**
 * `CommitTitleByline` in `CommitInfoView/utils.tsx`: the "You are here" label for ".", the public
 * badge, who wrote it and when. A badge is its own text here — there is no background to draw one on.
 */
function byline(commit: CommitInfo): string {
	const parts: string[] = [];

	if (commit.isDot) {
		parts.push(localize('sapling.youAreHere', "You are here"));
	}

	if (commit.phase === 'public') {
		parts.push(localize('sapling.info.public', "Public"));
	}

	parts.push(localize('sapling.info.createdBy', "Created by {0}", commit.author), relativeDate(commit.date, {}));

	return parts.join(' · ');
}

/** The description, as its own rows — `.commit-info-rendered-textarea`, or the empty state. */
function describe(commit: CommitInfo): IInfoRow[] {
	if (!commit.description) {
		return [{ text: localize('sapling.info.noDescription', "No Description"), dim: true }];
	}

	return commit.description.split('\n').map(text => ({ text }));
}

/**
 * `ChangedFiles` and `File` in `UncommittedChanges.tsx` / `ChangedFile.tsx`, without the selection
 * checkboxes, the per-file actions and the tree/fish path renderings — each of those is a control
 * rather than a display. Upstream's pagination is kept in the one form that survives without a
 * control behind it: the banner saying how many of the total are shown.
 */
function changedFiles(files: readonly ChangedFile[], totalFiles: number): IInfoRow[] {
	// `nameAndIconForFileStatus` gives a status a class name and a codicon; a terminal has neither, and
	// `ChangedFileType` is already the letter — the same substitution the SCM pane's rows make.
	const rows: IInfoRow[] = files.map(file => ({ text: `${file.status} ${file.path}` }));

	if (totalFiles > files.length) {
		rows.unshift({ text: localize('sapling.info.someFiles', "Showing {0} of {1} files", files.length, totalFiles), dim: true });
	}

	return rows;
}
