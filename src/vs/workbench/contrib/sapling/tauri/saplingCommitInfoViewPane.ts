/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, reset } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { trackSlWork } from '../../../browser/tauri/settled.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { relativeDate } from '../common/relativeDate.js';
import { ChangedFile, ChangedFileType, CommitInfo } from '../common/types.js';
import { ISaplingSelection, ISaplingSelectionService } from './saplingSelection.js';
import { SL_CHANNEL_NAME, SlChannelClient } from './slIpc.js';

// The same copied stylesheets the graph imports, plus the commit-info view's own. They are
// `@scope`-confined to `.sapling-smartlog`, which is why this pane's body carries that class too.
import '../media/InlineBadge.css';
import '../media/UncommittedChanges.css';
import '../media/CommitInfoView.css';
import './sapling.css';

/**
 * `nameAndIconForFileStatus` in `addons/isl/src/ChangedFile.tsx`, for the three statuses a
 * committed file can have. The class names are what `UncommittedChanges.css` colours by, and the
 * icons are codicons upstream names by the same id.
 */
const FILE_STATUS: Record<ChangedFileType, { readonly name: string; readonly icon: ThemeIcon }> = {
	A: { name: 'added', icon: Codicon.diffAdded },
	M: { name: 'modified', icon: Codicon.diffModified },
	R: { name: 'removed', icon: Codicon.diffRemoved }
};

/**
 * The commit-info view — `CommitInfoSidebar` / `CommitInfoDetails` in
 * `addons/isl/src/CommitInfoView/CommitInfoView.tsx`, read-only.
 *
 * **Everything upstream can *edit* here is absent, and that is most of the file.** Its commit
 * message fields are click-to-edit text areas over an in-progress message store, and the bar
 * along the bottom amends, commits, submits and uncommits — none of which this port has a
 * mutation path for. What is left is the shape a commit is *displayed* in: the title, the byline,
 * the description and the changed files, each under the class name upstream gives it so that the
 * copied `CommitInfoView.css` is what lays them out.
 *
 * The changed-file list is a second `sl` read rather than a field of the smartlog fetch, exactly
 * as `ChangedFilesWithFetching` is: the main template carries a sample of the paths with no
 * statuses, so the sample paints immediately and the statuses arrive after.
 */
export class SaplingCommitInfoViewPane extends ViewPane {

	static readonly ID = 'workbench.sapling.commitInfoView';

	/** `.commit-info-view-main-content`, which is what the pane scrolls. */
	private content: HTMLElement | undefined;
	private scroller: DomScrollableElement | undefined;

	/** Built on the first render, as the graph's is: neither view may touch `sl` before it shows. */
	private client: SlChannelClient | undefined;

	/**
	 * Which render a changed-files read belongs to. The read is a channel round trip and the
	 * selection can move under it, so the answer is dropped unless the render that asked for it is
	 * still the one on screen — a late reply must never repaint a commit nobody is looking at.
	 */
	private renderGeneration = 0;

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
		@ISaplingSelectionService private readonly selectionService: ISaplingSelectionService,
		@ILogService private readonly logService: ILogService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// The scope root the copied stylesheets are confined to, and where `sapling.css` declares
		// ISL's variables. It is named after the graph because that is the view it was written
		// for; both Sapling views are inside it.
		container.classList.add('sapling-smartlog');

		const view = append(container, $('.commit-info-view'));
		this.content = $('.commit-info-view-main-content');
		// In the tab order and focusable, as the graph's scroller is and for the same reason: this
		// is the element a view cycled into gives the keyboard to.
		this.content.tabIndex = 0;

		// Upstream scrolls that element with its own `overflow-y: auto`. It cannot here, for the
		// reason `saplingViewPane.ts`'s `layoutBody` sets out: a native scroller inside a pane body
		// loses its wheel events to the split view's own scrollable element, which is an ancestor.
		this.scroller = this._register(new DomScrollableElement(this.content, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false
		}));
		append(view, this.scroller.getDomNode());

		this._register(this.selectionService.onDidChangeSelection(() => this.renderSelection()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.renderSelection();
			}
		}));

		this.renderSelection();
	}

	/**
	 * The commit's details are what the pane is for, so focusing the view focuses them — and
	 * without this the view cannot be given the keyboard at all: `ViewPane.focus()`'s fallback is
	 * `element.focus()` on the `.pane` div, which carries no `tabindex` and does nothing. That is
	 * what made `Ctrl+Tab` read as dead in the smartlog, one view along: the cycle ran, landed
	 * here, and the keyboard stayed where it was.
	 */
	override focus(): void {
		if (this.content && !this.shouldShowWelcome()) {
			this.content.focus();
			return;
		}

		super.focus();
	}

	/** Nothing to show until the graph beside it has found a repository and resolved ".". */
	override shouldShowWelcome(): boolean {
		return this.selectionService.selection === undefined;
	}

	private renderSelection(): void {
		const generation = ++this.renderGeneration;

		const content = this.content;
		const selection = this.selectionService.selection;
		if (!content) {
			return;
		}

		this._onDidChangeViewWelcomeState.fire();

		if (!selection) {
			reset(content);
			return;
		}

		const { commit } = selection;
		const files = $('.changed-file-list');

		reset(content,
			$('.commit-info-title-wrapper', undefined,
				$('.commit-info-rendered-title.non-editable', undefined, $('span', undefined, commit.title))),
			byline(commit),
			section(Codicon.note, localize('sapling.info.description', "Description"),
				commit.description
					? $('.commit-info-rendered-textarea.non-editable', undefined, commit.description)
					: $('span.empty-description.subtle', undefined, localize('sapling.info.noDescription', "No Description"))),
			section(Codicon.files, localize('sapling.info.filesChanged', "Files Changed"), files, commit.totalFileCount)
		);

		// The sample paints now; the statuses replace it when the second read lands.
		this.setChangedFiles(files, commit.filePathsSample.map(path => ({ path, status: 'M' as const })), commit.totalFileCount);
		this.fetchChangedFiles(selection, files, generation);
	}

	private setChangedFiles(target: HTMLElement, files: readonly ChangedFile[], totalFiles: number): void {
		reset(target, changedFiles(files, totalFiles));
		this.scroller?.scanDomNode();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.scroller?.scanDomNode();
	}

	private fetchChangedFiles(selection: ISaplingSelection, target: HTMLElement, generation: number): void {
		const client = this.client ??= new SlChannelClient(this.mainProcessService.getChannel(SL_CHANNEL_NAME));

		// The second read is outstanding work like the graph's own — a reading of this pane taken
		// while it is in flight is the sample the first paint put up, not the statuses.
		trackSlWork(client.changedFiles(selection.root, selection.commit.hash).then(files => {
			if (generation === this.renderGeneration) {
				this.setChangedFiles(target, files, selection.commit.totalFileCount);
			}
		}, error => {
			// The sample stays on screen: a failed statuses read is less information, not none.
			this.logService.error(`[sl] changed files failed for ${selection.commit.hash}`, error);
		}));
	}
}

/**
 * `CommitTitleByline` in `CommitInfoView/utils.tsx`: the "You are here" label for ".", the public
 * badge, who wrote it and when. Upstream hangs a tooltip off each half; the absolute date is the
 * `title` here for the same reason it is on a row's date.
 */
function byline(commit: CommitInfo): HTMLElement {
	const line = $('.commit-info-title-byline.subtle');

	if (commit.isDot) {
		append(line, $('.you-are-here-container', undefined,
			$('.inline-badge.badge-primary', undefined, localize('sapling.youAreHere', "You are here"))));
	}

	if (commit.phase === 'public') {
		append(line, $('.inline-badge', {
			title: localize('sapling.info.publicTooltip', "This commit has already been pushed to an append-only remote branch and can't be modified locally.")
		}, localize('sapling.info.public', "Public")));
	}

	append(line,
		$('.overflow-ellipsis.overflow-shrink', { title: commit.author },
			localize('sapling.info.createdBy', "Created by {0}", commit.author)),
		$('.overflow-ellipsis', { title: commit.date.toLocaleString() }, relativeDate(commit.date, {})));

	return line;
}

/** `Section` + `SmallCapsTitle` in `CommitInfoView/utils.tsx`, with the `Badge` upstream puts in one. */
function section(icon: ThemeIcon, title: string, body: HTMLElement, count?: number): HTMLElement {
	const smallTitle = $('.commit-info-small-title', undefined, $(`span${ThemeIcon.asCSSSelector(icon)}`), title);
	if (count !== undefined) {
		append(smallTitle, $('span.sapling-badge', undefined, String(count)));
	}

	return $('section.commit-info-section', undefined, smallTitle, body);
}

/**
 * `ChangedFiles` and `File` in `UncommittedChanges.tsx` / `ChangedFile.tsx`, without the selection
 * checkboxes, the per-file actions and the tree/fish path renderings — each of those is a control
 * rather than a display, and the tree mode is a picker this port has nowhere to put.
 *
 * Upstream's pagination is kept in the one form that matters without a control behind it: the
 * banner that says how many of the total are being shown.
 */
function changedFiles(files: readonly ChangedFile[], totalFiles: number): HTMLElement {
	const list = $('.changed-files-list', undefined, ...files.map(file => {
		const { name, icon } = FILE_STATUS[file.status];
		return $(`.changed-file.file-${name}`, { 'data-testid': `changed-file-${file.path}` },
			$('span.changed-file-path', { title: file.path },
				$(`span${ThemeIcon.asCSSSelector(icon)}`),
				$('span.changed-file-path-text', undefined, file.path)));
	}));

	const container = $('.changed-files', undefined, $('.changed-files-list-container', undefined, list));

	if (totalFiles > files.length) {
		container.insertBefore($('.banner', undefined,
			localize('sapling.info.someFiles', "Showing {0} of {1} files", files.length, totalFiles)), container.firstChild);
	}

	return container;
}
