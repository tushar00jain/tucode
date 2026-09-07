/*---------------------------------------------------------------------------------------------
 *  `/` in the search pane: the box, and what `Tab` and `Enter` do with the rows it ranks. The
 *  ranking is `searchFilter.ts`'s and the box is `viewRootBox.ts`'s; what is here is the wiring
 *  between them and the vendored `SearchView`, which is per-pane.
 *
 *  **There is no view root**, so there is no root to re-input and no `setInput` seam at all. What is
 *  left is three: `ITreeFilter` at tree construction, `updateChildren`/`getFocus`/`setFocus`/
 *  `navigate` for the ranked rows, and the height the box costs the tree — which `SearchView.reLayout`
 *  is the only place that can subtract, because it is the only place that knows what the widgets
 *  above the results already took.
 *
 *  **What this file has that no other pane's needed is a `TreeVisibility.Recurse` of its own.** The
 *  GUI's results tree is a `CompressibleAsyncDataTree`, which pre-filters children as it fetches them
 *  and *throws* on `Recurse` (`asyncDataTree.ts:1666–1677`, upstream's own #85193): at fetch time
 *  "visible while a descendant is" has no answer, because the descendants are not there yet. Search
 *  is the one pane whose rows are two levels deep, so it is the one pane that asks. The ranking keeps
 *  its rule — it is a decision and it is shared — and this asks the same question of the rows
 *  underneath, which upstream hands over flat (`allDownstreamFileMatches`, `matches`). Both
 *  consequences of that pre-filter are answered here and nowhere else:
 *
 *  - a row it drops is not in the model, so `refilter()` can never bring one back and **a changed
 *    query is `updateChildren`** — upstream's own re-apply, which is what `RefreshTreeController`
 *    already calls on every batch of results;
 *  - it runs on every fetch, so **the filter answers `Visible` outright while the box is shut**, and
 *    the vendored tree is byte-identical to stock with `/` closed.
 *
 *  Upstream counterpart: none. VS Code's search view has no find widget over its results.
 *--------------------------------------------------------------------------------------------*/

import { getVisibleState, isFilterResult } from '../../../../base/browser/ui/tree/indexTreeModel.js';
import { ITreeFilter, TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { registerViewRootCommand, ViewRootBox } from '../../../browser/tauri/viewRootBox.js';
import { ViewRootController } from '../../../browser/tauri/viewRootController.js';
import { VIEW_ID } from '../../../services/search/common/search.js';
import {
	isSearchTreeFileMatch, isSearchTreeFolderMatch, isTextSearchHeading,
	ISearchResult, RenderableMatch
} from '../browser/searchTreeModel/searchTreeCommon.js';
import { createSearchFilter, SearchFilter } from './searchFilter.js';

type SearchTree = WorkbenchCompressibleAsyncDataTree<ISearchResult, RenderableMatch>;

/**
 * **What the box says it takes, which is not `FILTER_PLACEHOLDER`**: every other pane's `/` takes a
 * path and this one takes a name, because there is nothing here to descend into.
 */
const PLACEHOLDER = localize('tscode.searchFilterPlaceholder', "filter results");

registerViewRootCommand('tscode.search.filter', VIEW_ID, localize('tscode.search.filter', "Filter"));

export class SearchViewRoot extends ViewRootController<RenderableMatch, ViewRootBox> {

	/** What the vendored tree is constructed with — the ranking, with `Recurse` answered. */
	readonly filter: ITreeFilter<RenderableMatch, void> = {
		filter: element => !this.box.isOpen || this.survives(element) ? TreeVisibility.Visible : TreeVisibility.Hidden
	};

	/** `/`'s one question — which rows survive the query — which is the shared ranking. */
	private readonly query: SearchFilter;

	/** What each row answered for the query as it stands, which one fetch asks of it many times. */
	private readonly survival = new Map<RenderableMatch, boolean>();

	/** The row the box was opened on, which is where `Escape` puts the cursor back. */
	private restoreFocus: RenderableMatch | undefined;

	constructor(
		private readonly treeFn: () => SearchTree,
		resultsElement: HTMLElement,
		private readonly reLayout: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService
	) {
		super(root => instantiationService.createInstance(ViewRootBox, VIEW_ID, root, PLACEHOLDER));

		this.query = createSearchFilter(labelService);

		// Under the pane's own rows rather than among the boxes that build the query, so that the box
		// sits against the rows it filters — which is also what keeps it out of the walk `I` and
		// `Ctrl+Up/Down` make over the query boxes.
		this.box.mount(resultsElement);
	}

	//#region --- `IViewRoot`, which is what the box and the keymap drive this through

	/** The box opens empty, because there is no root for it to be prefilled with the path of. */
	protected override opening(): string {
		this.restoreFocus = this.treeFn().getFocus()[0];

		return '';
	}

	/** `SearchView.reLayout` is the only place that knows what the widgets above the results took. */
	protected override relayout(): void {
		this.reLayout();
	}

	/**
	 * `Enter`: the box closes on the row the cursor is on, and **nothing opens**. That is the
	 * explorer's *file* arm, which is the only arm there is here — a result row has nothing to be
	 * re-rooted at — so the second `Enter`, with the box gone, is the one that opens the result.
	 */
	protected override commitRoot(): Promise<void> {
		return this.closeFilter(this.treeFn().getFocus()[0]);
	}

	protected override cancelRoot(): Promise<void> {
		return this.closeFilter(this.restoreFocus);
	}

	/**
	 * **Only a file row answers a name** (`searchFilter.ts`), so a query that ranked nothing but match
	 * rows has no candidate and `Tab` does nothing. That is the ranking's answer rather than an arm
	 * here: a whole line of source written into the box is not a completion.
	 */
	protected override name(row: RenderableMatch): string | undefined {
		return this.query.name(row);
	}

	//#endregion

	/**
	 * The query as it stands, applied. **`updateChildren` rather than `refilter`**, which is the
	 * explorer's `resort` question answered a third way and for the tree rather than for taste: the
	 * rank moves no row here, so ordering never changes — but the rows a query hides are pre-filtered
	 * out of the model rather than out of the view, and only a refetch puts one back.
	 */
	protected override async applyQuery(query: string): Promise<void> {
		if (!this.box.isOpen) {
			return;
		}

		this.query.set(query);
		this.survival.clear();

		await this.treeFn().updateChildren();
		this.focusTo(this.rows[0]);
	}

	/**
	 * The query goes with the box that is already shut, and the cursor lands back on `focus` — the row
	 * `Enter` was pressed on, or the row the box was opened on for `Escape`. A row the query had
	 * hidden is back by then; one the results themselves dropped is not, and the top row is where the
	 * cursor goes instead.
	 */
	private async closeFilter(focus: RenderableMatch | undefined): Promise<void> {
		this.restoreFocus = undefined;
		this.query.clear();
		this.survival.clear();
		this.relayout();

		await this.treeFn().updateChildren();

		const rows = this.rows;
		this.focusTo(focus && rows.includes(focus) ? focus : rows[0]);
		this.restoreDomFocus();
	}

	/**
	 * Whether the query leaves the row anything, with `TreeVisibility.Recurse` answered rather than
	 * returned. A folder row and a heading row are structure the query says nothing about, and an
	 * unmatched file row keeps its row while one of its matches is named — so all three are the same
	 * question asked of what is under them.
	 */
	private survives(element: RenderableMatch): boolean {
		let survives = this.survival.get(element);

		if (survives === undefined) {
			const result = this.query.filter(element, TreeVisibility.Visible);
			const visibility = getVisibleState(isFilterResult(result) ? result.visibility : result);

			survives = visibility === TreeVisibility.Recurse
				? this.beneath(element).some(row => this.survives(row))
				: visibility === TreeVisibility.Visible;
			this.survival.set(element, survives);
		}

		return survives;
	}

	/**
	 * The rows under one the query says nothing about, flat — which is what makes answering `Recurse`
	 * here cheap rather than a walk of the tree: upstream already keeps every downstream file match of
	 * a folder and of a heading on the row itself.
	 */
	private beneath(element: RenderableMatch): readonly RenderableMatch[] {
		if (isSearchTreeFileMatch(element)) {
			return element.matches();
		}

		if (isSearchTreeFolderMatch(element)) {
			return element.allDownstreamFileMatches();
		}

		return isTextSearchHeading(element) ? element.matches() : [];
	}

	/**
	 * The rows on screen, in the order they are drawn in — `Tab`'s candidates. `navigate` is the
	 * tree's own walk of its rendered list, so a collapsed file's matches are not among them for the
	 * same reason they are not on screen.
	 */
	protected override get rows(): RenderableMatch[] {
		const rows: RenderableMatch[] = [];
		const navigator = this.treeFn().navigate();

		for (let row = navigator.next(); row; row = navigator.next()) {
			rows.push(row);
		}

		return rows;
	}

	protected override get tree(): SearchTree {
		return this.treeFn();
	}
}
