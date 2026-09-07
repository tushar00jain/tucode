/*---------------------------------------------------------------------------------------------
 * Shared result-filter interaction for browser, terminal and native Search surfaces.
 * Upstream counterpart: none. VS Code has no `/` filter over its search results.
 *--------------------------------------------------------------------------------------------*/

import { getVisibleState, isFilterResult } from '../../../../base/browser/ui/tree/indexTreeModel.js';
import { ITreeFilter, TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import type { ILabelService } from '../../../../platform/label/common/label.js';
import { ViewRootController, IViewRoot, IViewRootBox, IViewRootTree, ViewRootQueued } from '../../../browser/tauri/viewRootController.js';
import { isSearchTreeFileMatch, isSearchTreeFolderMatch, isTextSearchHeading, RenderableMatch } from '../browser/searchTreeModel/searchTreeCommon.js';
import { createSearchFilter, SearchFilter } from './searchFilter.js';

export interface ISearchRootTree extends IViewRootTree<RenderableMatch> {
	updateChildren(element?: undefined, recursive?: boolean): Promise<void>;
	getFocus(): RenderableMatch[];
	navigate(): { next(): RenderableMatch | null };
}

export class SearchRootController<TBox extends IViewRootBox> extends ViewRootController<RenderableMatch, TBox> {
	private readonly ranking: SearchFilter;
	private restoreFocus: RenderableMatch | undefined;
	private restoring = 0;
	private pattern = '';
	get input(): TBox { return this.box; }
	get query(): string | undefined { return this.box.isOpen ? this.box.value : undefined; }
	readonly rootPath = '';
	whenSettled(): Promise<void> { return new Promise(resolve => this.queued(async () => resolve())); }

	/** AsyncDataTree prefilters fetched children: resolve Recurse against the live search model.
	 * Do not cache survival across streams: the same file can acquire a new matching line. */
	readonly filter: ITreeFilter<RenderableMatch, void> = {
		filter: element => {
			if (!this.box.isOpen) { return TreeVisibility.Visible; }
			const result = this.ranking.filter(element, TreeVisibility.Visible);
			const visibility = getVisibleState(isFilterResult(result) ? result.visibility : result);
			if (visibility !== TreeVisibility.Recurse) { return visibility; }
			return this.beneath(element).some(row => {
				const child = this.filter.filter(row, TreeVisibility.Visible);
				return getVisibleState(isFilterResult(child) ? child.visibility : child) === TreeVisibility.Visible;
			})
				? TreeVisibility.Visible : TreeVisibility.Hidden;
		}
	};

	constructor(private readonly treeFn: () => ISearchRootTree, labelService: ILabelService,
		createBox: (root: IViewRoot) => TBox, private readonly layout: () => void, queued?: ViewRootQueued) {
		super(createBox, queued);
		this.ranking = createSearchFilter(labelService);
	}

	/** Invalidate scorer caches when existing model objects receive streamed or edited text. */
	invalidate(): void { this.ranking.set(this.pattern); }
	protected opening(): string {
		if (!this.restoring) { this.restoreFocus = this.treeFn().getFocus()[0]; }
		return '';
	}
	protected relayout(): void { this.layout(); }
	protected name(row: RenderableMatch): string | undefined { return this.ranking.name(row); }
	protected commitRoot(): Promise<void> { return this.closeFilter(this.treeFn().getFocus()[0]); }
	protected cancelRoot(): Promise<void> { return this.closeFilter(this.restoreFocus); }
	protected override captureCancel(): () => Promise<void> {
		const focus = this.restoreFocus;
		this.restoring++;
		return async () => { try { await this.closeFilter(focus); } finally { this.restoring--; } };
	}
	protected async applyQuery(query: string): Promise<void> {
		const session = this.sessionVersion;
		this.pattern = query;
		this.ranking.set(query);
		await this.treeFn().updateChildren(undefined, true);
		if (!this._store.isDisposed && this.box.isOpen && session === this.sessionVersion) { this.focusTo(this.rows[0]); }
	}
	private async closeFilter(focus: RenderableMatch | undefined): Promise<void> {
		if (this._store.isDisposed || this.box.isOpen) { return; }
		const session = this.sessionVersion;
		this.pattern = '';
		this.ranking.clear();
		this.relayout();
		await this.treeFn().updateChildren(undefined, true);
		if (this._store.isDisposed || this.box.isOpen || session !== this.sessionVersion) { return; }
		const rows = this.rows;
		this.focusTo(rows.find(row => row.id() === focus?.id()) ?? rows[0]);
		this.restoreDomFocus();
	}
	private beneath(element: RenderableMatch): readonly RenderableMatch[] {
		if (isSearchTreeFileMatch(element)) { return element.matches(); }
		if (isSearchTreeFolderMatch(element)) { return element.allDownstreamFileMatches(); }
		return isTextSearchHeading(element) ? element.matches() : [];
	}
	protected get rows(): RenderableMatch[] {
		const rows: RenderableMatch[] = [];
		const navigator = this.treeFn().navigate();
		for (let row = navigator.next(); row; row = navigator.next()) { rows.push(row); }
		return rows;
	}
	protected get tree(): ISearchRootTree { return this.treeFn(); }
}
