/*---------------------------------------------------------------------------------------------
 *  `/` in the explorer: the box, the view root it moves, and what `Tab` and `Enter` do with the
 *  rows it ranks. The grammar is `viewRoot.ts`'s and the box is `viewRootBox.ts`'s; what is here is
 *  the wiring between them and the vendored `ExplorerView`, which is per-pane.
 *
 *  **It meets the vendored tree at four seams, all of them upstream's own**: `ITreeFilter` and
 *  `ITreeSorter` at tree construction, `AsyncDataTree.setInput` for the root — reached through
 *  `ExplorerView.setTreeInput`, so the roots, the view state and the progress reporting stay
 *  upstream's — and `resort`/`getNode`/`setFocus` for the ranked rows. Nothing is threaded through
 *  `explorerViewer.ts` and no body of it is rewritten.
 *
 *  Upstream counterpart: none. VS Code's explorer has a *find* widget, which narrows a whole tree
 *  and never moves the item the tree is displayed from.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ITreeFilter, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { descend, FILTER_PLACEHOLDER, splitQuery } from '../../../browser/tauri/viewRoot.js';
import { registerViewRootCommand, ViewRootBox } from '../../../browser/tauri/viewRootBox.js';
import { ViewRootController } from '../../../browser/tauri/viewRootController.js';
import { ExplorerItem } from '../common/explorerModel.js';
import { VIEW_ID } from '../common/files.js';
import { IExplorerService } from '../browser/files.js';
import { ExplorerFilter, explorerNodes, queryFor } from './explorerFilter.js';

type ExplorerTree = WorkbenchCompressibleAsyncDataTree<ExplorerItem | ExplorerItem[], ExplorerItem, FuzzyScore>;

/**
 * What the vendored `ExplorerView` supplies. Structural rather than the class itself, so this file
 * imports nothing from `explorerView.ts` and the edit there stays an import line and a splice.
 */
export interface IExplorerViewRootHost {

	/** Re-roots the tree at whatever `rootInput` below answers, over upstream's own view state. */
	setTreeInput(): Promise<void>;

	/** Where the cursor goes when `Enter` commits a file rather than a folder. */
	selectResource(resource: URI | undefined, reveal?: boolean | 'force' | 'focusNoScroll'): Promise<void>;
}

registerViewRootCommand('tscode.filterExplorer', VIEW_ID, localize('tscode.filterExplorer', "Filter"));

export class ExplorerViewRoot extends ViewRootController<ExplorerItem, ViewRootBox> {

	/** `/`'s two questions — which rows survive the query, and in what order — as one object. */
	readonly filter: ExplorerFilter;

	/**
	 * The item whose children sit at the tree's root while `/` has moved it. `Enter` commits it and
	 * `Escape` puts it back; `explorerService.roots` never changes with it, so the file-event
	 * refresh, the decorations and `FilesFilter` are all untouched.
	 */
	private viewRoot: ExplorerItem | undefined;

	/** What `ExplorerView.setTreeInput` computed on its own, which is the root with no `/` open. */
	private ownRoot: ExplorerItem | ExplorerItem[] | undefined;

	/** Whichever item's children are on screen, which is what the pattern ranks. */
	private displayRoot: ExplorerItem | undefined;

	/** The view root to go back to on `Escape`. */
	private restoreRoot: ExplorerItem | undefined;

	constructor(
		private readonly view: IExplorerViewRootHost,
		private readonly treeFn: () => ExplorerTree,
		private readonly treeContainer: HTMLElement,
		private readonly isCompressionEnabled: () => boolean,
		filter: ITreeFilter<ExplorerItem, FuzzyScore>,
		sorter: ITreeSorter<ExplorerItem>,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExplorerService private readonly explorerService: IExplorerService
	) {
		super(root => instantiationService.createInstance(ViewRootBox, VIEW_ID, root, FILTER_PLACEHOLDER));

		this.filter = new ExplorerFilter(filter, sorter);
		this.box.mount(treeContainer);
	}

	/**
	 * What the tree is rooted at, over what `ExplorerView.setTreeInput` computed: the view root
	 * while `/` has moved it, and upstream's own answer otherwise. Recording both here is what lets
	 * the ranking ask which item's children are on screen without a second copy of that rule.
	 */
	rootInput(input: ExplorerItem | ExplorerItem[]): ExplorerItem | ExplorerItem[] {
		this.ownRoot = input;

		const rooted = this.viewRoot ?? input;
		this.displayRoot = rooted instanceof ExplorerItem ? rooted : undefined;

		return rooted;
	}

	//#region --- `IViewRoot`, which is what the box and the keymap drive this through

	/**
	 * **`/` prefills the folder being looked at — the view root — and so never moves the pane.** The
	 * rows on screen are the rows the box opens on, with the folder the cursor is on among them
	 * rather than dived into; descending stays the explicit gesture it already was, which is typing
	 * `foo/` or pressing `Enter` on `foo`.
	 *
	 * The path is `queryFor`'s, from the **workspace** rather than from a root — so the roots are a
	 * query's first segment and one query can span them. At the top there is no path, so the box is
	 * empty, which is the query that already means *show everything*.
	 */
	protected override opening(): string {
		this.restoreRoot = this.viewRoot;

		// `viewRootController.ts` says why a filtered tree is never compressed.
		this.treeFn().updateOptions({ compressionEnabled: false });
		this.treeContainer.style.height = `calc(100% - ${ViewRootBox.HEIGHT}px)`;

		return queryFor(this.displayRoot);
	}

	protected override cancelRoot(): Promise<void> {
		return this.closeFilter(this.restoreRoot);
	}

	//#endregion

	/**
	 * The query as it stands, applied. Everything but the last segment resolves to a chain of
	 * folders and the end of that chain is the view root; the last segment filters and ranks that
	 * root's direct children.
	 *
	 * **A moved root is a re-input and a standing root is `updateChildren`**, and both leave the tree
	 * ranked by the query it now holds: `updateChildren` re-sets the root's children through
	 * `_setChildren` (`objectTreeModel.ts:190`), so the filter *and* the sorter run again over the
	 * rows the tree already has — `refilter` alone would leave the ranking on the previous query's
	 * order, which is the order `Enter` reads its answer off.
	 *
	 * **It is `updateChildren` rather than `resort` because the root is not an element of this
	 * tree.** `AsyncDataTree.resort` hands `getDataNode(element)` straight to the object tree
	 * (`asyncDataTree.ts:835`) without the `node === this.root ? null` translation `getNode` and
	 * `collapse` make, so resorting the *root* looks the root data node up among the elements, finds
	 * nothing and throws `TreeError [FileExplorer] Tree element not found` — which is every keystroke
	 * of a query that does not move the root. `updateChildren()` is what `ExplorerView.refresh`
	 * already rebuilds this tree with, and it takes the root; the children come back from
	 * `ExplorerItem.fetchChildren`'s cache, so it is a re-set rather than a directory read.
	 */
	protected override async applyQuery(query: string): Promise<void> {
		if (!this.box.isOpen) {
			return;
		}

		const { path, pattern } = splitQuery(query);
		const nodes = explorerNodes(this.explorerService.roots, this.explorerService.sortOrderConfiguration.sortOrder);
		const { root, resolved } = await descend(nodes, path);
		const displayed = this.displayRoot;

		this.viewRoot = root;

		// **What the pattern ranks is what the pane draws**, which is the tree's root rather than the
		// view root: a one-folder workspace displays that folder's *contents* at the top, so the two
		// differ there and the rows would otherwise be ranked against an item that has no row.
		this.filter.set(this.rootFor(root), pattern, resolved);

		if (this.rootFor(root) !== displayed) {
			await this.view.setTreeInput();
		} else {
			await this.treeFn().updateChildren(undefined, false);
		}

		this.focusTo(this.rows[0]);
	}

	/**
	 * `Enter`: the focused row, which the ranking puts the best match on. A folder becomes the view
	 * root and the box closes on its contents; a file closes the box and takes the cursor with it.
	 *
	 * **A query with no name to rank by has no answer to commit**, so it commits where it is. The
	 * path already named a folder — by construction, since the box opens on one — and taking the
	 * focused row there would descend on the strength of a row's position rather than of anything
	 * typed, which is `/` moving the pane again by another route.
	 */
	protected override async commitRoot(): Promise<void> {
		const item = splitQuery(this.box.value).pattern ? this.treeFn().getFocus()[0] : undefined;

		await this.closeFilter(item?.isDirectory ? item : this.viewRoot);

		if (item && !item.isDirectory) {
			await this.view.selectResource(item.resource, true);
		}
	}

	/** The query goes with the box that is already shut, and the tree is displayed from `root`. */
	private async closeFilter(root: ExplorerItem | undefined): Promise<void> {
		this.viewRoot = root;
		this.filter.clear();
		this.treeContainer.style.height = '';
		this.treeFn().updateOptions({ compressionEnabled: this.isCompressionEnabled() });
		this.relayout();

		await this.view.setTreeInput();
		this.restoreDomFocus();
	}

	/** The tree's own top-level rows, in the order the ranking put them — `Tab`'s candidates. */
	protected override get rows(): ExplorerItem[] {
		return this.treeFn().getNode().children
			.filter(child => child.visible)
			.map(child => child.element as ExplorerItem);
	}

	protected override name(item: ExplorerItem): string | undefined {
		return this.filter.name(item);
	}

	protected override get tree(): ExplorerTree {
		return this.treeFn();
	}

	/** Which item's children the tree would show for a given view root — upstream's own otherwise. */
	private rootFor(viewRoot: ExplorerItem | undefined): ExplorerItem | undefined {
		const rooted = viewRoot ?? this.ownRoot;

		return rooted instanceof ExplorerItem ? rooted : undefined;
	}

	protected override relayout(): void {
		const body = this.treeContainer.parentElement;
		if (body) {
			this.treeFn().layout(body.clientHeight - this.box.height, body.clientWidth);
		}
	}
}
