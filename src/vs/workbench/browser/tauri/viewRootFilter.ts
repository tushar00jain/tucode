/*---------------------------------------------------------------------------------------------
 *  The **view root**'s composition half: how the ranking a pane supplies sits on top of the filter
 *  and the sorter the tree already had. The grammar it composes — the query, the path, the descent
 *  and the completion — is `viewRoot.ts`'s, and the two are one module split along the only line
 *  that matters, which is what a unit test can reach: everything here needs `TreeVisibility` and
 *  `getVisibleState` as *values*, and their closure reaches `base/browser/touch.ts`, whose
 *  decorators Node's type stripping rejects.
 *
 *  **The composition is `FindFilter`'s** (`abstractTree.ts:655`): the tree's own filter runs first and
 *  a row it hides stays hidden whatever the query says. What is added to it is the *scoping* — only
 *  the root's direct children are ranked, because a query that names one level has nothing to say
 *  about a row three of them down.
 *
 *  Upstream counterpart: `FindFilter` — the normalisation and the early return are its, the scoping is not.
 *--------------------------------------------------------------------------------------------*/

import { getVisibleState, isFilterResult } from '../../../base/browser/ui/tree/indexTreeModel.js';
import { ITreeFilter, ITreeSorter, TreeFilterResult, TreeVisibility } from '../../../base/browser/ui/tree/tree.js';

/**
 * How one pane scores its own rows against the query's last segment. **None of this is decided
 * here**: the explorer answers with `Ctrl+P`'s scorer over an `ExplorerItem`, the source control
 * pane with `FindFilter` over `SCMTreeKeyboardNavigationLabelProvider`, which is what upstream's own
 * tree find matches those six row kinds on, and the search pane with `Ctrl+P`'s scorer again over
 * the strings its own renderers draw.
 */
export interface IRanking<T, TFilterData> {

	/** The name to rank by; the empty string is no query. */
	pattern: string;

	/** Whether the last segment has anything to say about this row — the root's own children. */
	ranks(element: T): boolean;

	/** The row's own name, which is what it was matched on and what a completion writes. */
	name(element: T): string | undefined;

	/**
	 * What the row scored, or `undefined` for a row the query did not match, which hides it. `data`
	 * is what the row draws its tint from, and a row with no label to tint answers without one.
	 *
	 * **The score-to-visibility half of that is not a pane's to decide**: it is `rankOf`
	 * (`viewRoot.ts`), which every pane that reads its answer off a score asks. What a pane supplies
	 * is the score and the payload.
	 */
	rank(element: T): { data?: TFilterData } | undefined;

	/**
	 * What a row the query did not match is, which is `FindFilter`'s `_defaultFindVisibility`
	 * (`abstractTree.ts:704`) at the same place in the rule and defaulting the same way it does when
	 * nothing answers — except that upstream's default is `Recurse` and a pane ranking *one level*
	 * has no rows underneath to recurse into, so hiding is the answer here.
	 *
	 * The search pane is the one that needs the other arm: its rows are two levels deep, so a file
	 * the query did not name still has a row for as long as a match under it did.
	 */
	unmatched?(element: T): TreeVisibility;

	/**
	 * Where two ranked rows sit relative to each other, **and nothing at all for a pane whose order
	 * is its data source's rather than its tree's.** It travels with `ViewRootFilter`'s own sorter:
	 * search enumerates every level itself through `searchMatchComparer` and gives the model no
	 * sorter, so neither half is reachable there and neither is written.
	 */
	compare?(one: T, other: T): number;
}

/**
 * The tree's filter and its sorter while `/` is open, over whatever the tree already had for both.
 *
 * Only the *direct children* of the view root are ranked: everything under them is whatever the inner
 * filter said, so a folder the user had open keeps its rows. That is what makes this a ranking of one
 * level rather than a search of the tree.
 */
export class ViewRootFilter<T, TFilterData, TRanking extends IRanking<T, TFilterData> = IRanking<T, TFilterData>> implements ITreeFilter<T, TFilterData>, ITreeSorter<T> {

	private active = false;
	private resolved = true;

	constructor(
		protected readonly ranking: TRanking,
		private readonly _filter: ITreeFilter<T, TFilterData>,
		private readonly _sorter?: ITreeSorter<T>
	) { }

	/** The query as it stands: the name to rank by, and whether the path in front of it resolved. */
	protected apply(pattern: string, resolved: boolean): void {
		this.active = true;
		this.ranking.pattern = pattern;
		this.resolved = resolved;
	}

	/** No query: the tree is the tree's own filter and the tree's own sorter again. */
	clear(): void {
		this.active = false;
		this.ranking.pattern = '';
		this.resolved = true;
	}

	/**
	 * What `Tab` would write for a row, and nothing for a row it has no name to write — one the
	 * query does not rank, or one that is structure rather than a name (a commit box, a group).
	 */
	name(element: T): string | undefined {
		return this.active && this.ranking.ranks(element) ? this.ranking.name(element) : undefined;
	}

	filter(element: T, parentVisibility: TreeVisibility): TreeFilterResult<TFilterData> {
		const result = this._filter.filter(element, parentVisibility);
		if (!this.active) {
			return result;
		}

		// `FindFilter`'s own normalisation of the filter it wraps, and its own early return: a row the
		// tree's filter hides is hidden whatever the query says about it.
		const visibility = getVisibleState(isFilterResult(result) ? result.visibility : result);
		if (visibility === TreeVisibility.Hidden) {
			return false;
		}

		if (!this.ranking.ranks(element)) {
			return visibility;
		}

		if (!this.resolved) {
			return TreeVisibility.Hidden;
		}

		if (!this.ranking.pattern) {
			return visibility;
		}

		const ranked = this.ranking.rank(element);
		if (!ranked) {
			return this.ranking.unmatched?.(element) ?? TreeVisibility.Hidden;
		}

		return ranked.data === undefined ? visibility : { data: ranked.data, visibility };
	}

	compare(one: T, other: T): number {
		if (this.ranking.compare && this.ranking.pattern && this.ranking.ranks(one) && this.ranking.ranks(other)) {
			return this.ranking.compare(one, other);
		}

		return this._sorter?.compare(one, other) ?? 0;
	}
}
