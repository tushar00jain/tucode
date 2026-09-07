/*---------------------------------------------------------------------------------------------
 *  `/` in the source control pane: the box, the view root it moves, and what `Tab` and `Enter` do
 *  with the rows it ranks. The grammar is `viewRoot.ts`'s, the box is `viewRootBox.ts`'s, and every
 *  answer about what a query matches, which rows it ranks and where a moved root re-points the data
 *  source is `scmFilter.ts`'s. What is here is the wiring between them and the vendored
 *  `SCMViewPane`, which is per-pane.
 *
 *  **It meets the vendored tree at four seams, all of them upstream's own**: `ITreeFilter` and
 *  `ITreeSorter` at tree construction, the `IAsyncDataSource` and the `ITreeCompressionDelegate`
 *  beside them, and `updateChildren`/`getNode`/`setFocus` for the rows. Nothing is threaded through
 *  `SCMTreeDataSource` and no body of it is rewritten — the wrapper delegates to the instance the
 *  pane already built.
 *
 *  **The rebuild is `updateChildren` rather than `resort`**, which is where this pane parts company
 *  with the explorer's. A moved root changes which rows *exist* rather than only which of them are
 *  visible; and the rows the last segment ranks are not one level of the tree but two — the
 *  repositories at the top, or a group's own rows one level under a group — so re-sorting the root's
 *  direct children would leave the ranked rows in the previous query's order, which is the order
 *  `Enter` reads its answer off. `updateChildren` is the call every provider event already goes
 *  through, and it re-runs the filter and the sorter at every level.
 *
 *  Upstream counterpart: none. VS Code's source control pane has a *find* widget, which narrows a whole tree and never moves the item the tree is displayed from.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { localize } from '../../../../nls.js';
import { ITreeCompressionDelegate } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { IAsyncDataSource, ITreeFilter, ITreeNode, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { descend, FILTER_PLACEHOLDER, splitQuery } from '../../../browser/tauri/viewRoot.js';
import { registerViewRootCommand, ViewRootBox } from '../../../browser/tauri/viewRootBox.js';
import { ViewRootController } from '../../../browser/tauri/viewRootController.js';
import { ISCMViewService, ISCMViewVisibleRepositoryChangeEvent, VIEW_PANE_ID, ViewMode } from '../common/scm.js';
import { TreeElement } from '../browser/scmViewPane.js';
import { createSCMFilter, ISCMViewRoot, queryFor, rootCompression, rootFor, scmNodes, SCMFilter, SCMViewRootDataSource } from './scmFilter.js';

type SCMTree = WorkbenchCompressibleAsyncDataTree<ISCMViewService, TreeElement, FuzzyScore>;

registerViewRootCommand('tscode.scm.filter', VIEW_PANE_ID, localize('tscode.scm.filter', "Filter"));

export class SCMViewRoot extends ViewRootController<TreeElement, ViewRootBox> {

	/** `/`'s two questions — which rows survive the query, and in what order — as one object. */
	readonly filter: SCMFilter;

	/** The pane's own data source, re-pointed at whatever the view root names. */
	readonly dataSource: SCMViewRootDataSource;

	/** The pane's own compression delegate, plus the rows a chain may not start at. */
	readonly compression: ITreeCompressionDelegate<TreeElement>;

	/**
	 * The repository, and the changed folder inside it, whose rows are on screen. `Enter` commits it
	 * and `Escape` puts it back; `ISCMViewService.visibleRepositories` never changes with it, so the
	 * provider events, the decorations and `SCMTreeFilter` are all untouched.
	 */
	private viewRoot: ISCMViewRoot | undefined;

	/** The view root to go back to on `Escape`, and the row the box was opened on. */
	private restoreRoot: ISCMViewRoot | undefined;
	private restoreFocus: TreeElement | undefined;

	constructor(
		private readonly treeContainer: HTMLElement,
		private readonly treeFn: () => SCMTree,
		private readonly isCompressionEnabled: () => boolean,
		viewMode: () => ViewMode,
		dataSource: IAsyncDataSource<ISCMViewService, TreeElement>,
		filter: ITreeFilter<TreeElement, FuzzyScore>,
		sorter: ITreeSorter<TreeElement>,
		compression: ITreeCompressionDelegate<TreeElement>,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISCMViewService private readonly scmViewService: ISCMViewService
	) {
		super(root => instantiationService.createInstance(ViewRootBox, VIEW_PANE_ID, root, FILTER_PLACEHOLDER));

		this.filter = this._register(createSCMFilter(instantiationService, viewMode, filter, sorter));
		this.dataSource = new SCMViewRootDataSource(dataSource, viewMode, this.filter);
		this.compression = rootCompression(compression, this.filter);
		this.box.mount(treeContainer);

		this._register(this.scmViewService.onDidChangeVisibleRepositories(event => this.onDidChangeVisibleRepositories(event)));
	}

	//#region --- `IViewRoot`, which is what the box and the keymap drive this through

	/**
	 * **`/` prefills the root being looked at, and so never moves the pane.** At the top level there
	 * is no path, so the box is empty — which is the query that already means *show everything*, and
	 * where the last segment names a repository.
	 */
	protected override opening(): string {
		this.restoreRoot = this.viewRoot;
		this.restoreFocus = this.treeFn().getFocus()[0];

		// `viewRootController.ts` says why a filtered tree is never compressed.
		this.treeFn().updateOptions({ compressionEnabled: false });

		return queryFor(this.viewRoot);
	}

	protected override cancelRoot(): Promise<void> {
		return this.closeFilter(this.restoreRoot, this.restoreFocus);
	}

	//#endregion

	/**
	 * The query as it stands, applied. Everything but the last segment resolves to a repository and a
	 * chain of changed folders inside it — that is the view root — and the last segment filters and
	 * ranks the rows the root's groups put on screen.
	 */
	protected override async applyQuery(query: string): Promise<void> {
		if (!this.box.isOpen) {
			return;
		}

		const { path, pattern } = splitQuery(query);
		const { root, resolved } = await descend(scmNodes(this.scmViewService), path);

		this.dataSource.root = this.viewRoot = root;
		this.filter.set(pattern, resolved);

		await this.rebuild();

		const rows = this.rows;
		this.focusTo(rows.find(row => this.filter.ranks(row)) ?? rows[0]);
	}

	/**
	 * `Enter`: the focused row, which the ranking puts the best match on. A repository or a folder
	 * becomes the view root and the box closes on its rows; anything else closes the box and takes
	 * the cursor with it, which is the explorer's *file* arm.
	 *
	 * **A query with no name to rank by has no answer to commit**, so it commits where it is — taking
	 * the focused row there would re-root on the strength of a cursor's position rather than of
	 * anything typed.
	 */
	protected override async commitRoot(): Promise<void> {
		const element = splitQuery(this.box.value).pattern ? this.treeFn().getFocus()[0] : undefined;
		const root = rootFor(this.scmViewService, element);

		await this.closeFilter(root ?? this.viewRoot, root ? undefined : element);
	}

	/**
	 * The query goes with the box that is already shut, the tree is rebuilt from `root`, and the
	 * cursor lands back on `focus` — the row `Enter` was pressed on, or the row the box was opened on
	 * for `Escape`. A row the rebuild took away is not one the tree can be focused on, so the cursor
	 * falls back to the top rather than to an element the tree no longer holds.
	 */
	private async closeFilter(root: ISCMViewRoot | undefined, focus: TreeElement | undefined): Promise<void> {
		this.restoreRoot = undefined;
		this.restoreFocus = undefined;
		this.dataSource.root = this.viewRoot = root;
		this.filter.clear();
		this.treeFn().updateOptions({ compressionEnabled: this.isCompressionEnabled() });
		this.relayout();

		await this.rebuild();

		const rows = this.rows;
		this.focusTo(focus && rows.includes(focus) ? focus : rows[0]);
		this.restoreDomFocus();
	}

	/** The rows the tree has, rebuilt from the data source the view root re-points. */
	private async rebuild(): Promise<void> {
		this.filter.clearRanked();

		await this.treeFn().updateChildren();
	}

	/** The tree's visible rows, in the order they are drawn — `Tab`'s candidates. */
	protected override get rows(): TreeElement[] {
		const rows: TreeElement[] = [];

		const visit = (node: ITreeNode<ISCMViewService | TreeElement, FuzzyScore>): void => {
			for (const child of node.children) {
				if (!child.visible) {
					continue;
				}

				rows.push(child.element as TreeElement);

				if (!child.collapsed) {
					visit(child);
				}
			}
		};

		visit(this.treeFn().getNode());

		return rows;
	}

	protected override name(element: TreeElement): string | undefined {
		return this.filter.name(element);
	}

	protected override get tree(): SCMTree {
		return this.treeFn();
	}

	/**
	 * A root whose repository is gone has no rows to stand for, so the pane goes back to the top
	 * level rather than to a repository `ISCMViewService` no longer lists.
	 */
	private onDidChangeVisibleRepositories({ removed }: ISCMViewVisibleRepositoryChangeEvent): void {
		const gone = new Set(removed);

		if (this.viewRoot && gone.has(this.viewRoot.repository)) {
			this.dataSource.root = this.viewRoot = undefined;
		}

		if (this.restoreRoot && gone.has(this.restoreRoot.repository)) {
			this.restoreRoot = undefined;
		}
	}

	/** Both lines of it, because this pane's tree reads its height off the container as well. */
	protected override relayout(): void {
		const body = this.treeContainer.parentElement;
		if (!body) {
			return;
		}

		const height = body.clientHeight - this.box.height;
		this.treeContainer.style.height = `${height}px`;
		this.treeFn().layout(height, body.clientWidth);
	}
}
