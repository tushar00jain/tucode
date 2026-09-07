/*---------------------------------------------------------------------------------------------
 *  What `/` in the search pane answers, over the ranking and the composition `viewRoot.ts` holds
 *  for the three panes that have the box.
 *
 *  **This is the home of the search pane's ranking** — what a search row is matched on, what `Tab`
 *  writes and what a row the query did not name is are decisions rather than paint. Nothing
 *  GUI-specific may be added here: the box and the wiring to the vendored tree live beside it, in
 *  `searchViewRoot.ts`.
 *
 *  **There is no view root here**, and that is the whole of what this file does not have: a result
 *  list is two levels deep — a file row, then the match rows under it — and there is nothing under a
 *  match to descend into, so `splitQuery`, `pathQuery` and `descend` have no work and the query is
 *  one pattern rather than a path.
 *
 *  **A row is matched on the strings its own renderer draws**, which is what keeps this from being a
 *  label assembled here:
 *
 *  - a **file row** is `FileMatchRenderer`'s `label.setFile(fileMatch.resource, …)`, and that widget
 *    resolves to the name, the folder it is in and the resource — so the accessor is
 *    `createPick`'s triple in `filesQuickAccess.ts` (`basename`, `getUriLabel(dirname, relative)`,
 *    `fsPath`) asked of a file match. **This is `Ctrl+P`'s scorer**, so a query with a `/` in it
 *    scores the path and one without scores the name, both by upstream's rule rather than by an arm
 *    here;
 *  - a **match row** is `MatchRenderer`'s `preview()`, whose one-line text is `MatchImpl.text()`.
 *
 *  **The description is present here where the explorer's accessor drops it**, and for the explorer's
 *  own reason read the other way: `doScoreItemFuzzySingle` falls back to the description when the
 *  label misses, and search results are files from all over the workspace rather than the children of
 *  one folder — so it discriminates instead of keeping everything.
 *
 *  Upstream counterpart: none — VS Code's search view has no find widget over its results at all (`searchView.ts` builds its tree with no `keyboardNavigationLabelProvider`), and the box this fork opens is the explorer's.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { FuzzyScorerCache, IItemAccessor, IPreparedQuery, prepareQuery, scoreItemFuzzy } from '../../../../base/common/fuzzyScorer.js';
import { dirname } from '../../../../base/common/resources.js';
import { ITreeFilter, TreeFilterResult, TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import {
	isSearchTreeFileMatch, isSearchTreeMatch,
	ISearchTreeFileMatch, ISearchTreeMatch, RenderableMatch
} from '../browser/searchTreeModel/searchTreeCommon.js';
import { nameAccessor, rankOf } from '../../../browser/tauri/viewRoot.js';
import { IRanking, ViewRootFilter } from '../../../browser/tauri/viewRootFilter.js';

/**
 * A match row is matched on its own line and on nothing else, which is `MatchImpl.text()`.
 *
 * **It is scored contiguously**, which is the one thing here `scoreItemFuzzy`'s callers usually
 * answer the other way — and the parameter exists to be answered: a line of source is not a name,
 * and a non-contiguous match over 200 characters keeps almost every row, which is a filter that
 * filters nothing. Driving `Ranking` over this repo's own `src/tui` is where that showed: `pane`
 * fuzzily matched every import line that had a `p`, an `a`, an `n` and an `e` left to right.
 */
const matchAccessor = nameAccessor<ISearchTreeMatch>(match => match.text());

/**
 * The tree's own filter, which it had none of until `/` needed one: **a row that stands for others
 * is on screen for as long as one of them is.** `TreeVisibility.Recurse` says exactly that, and it
 * costs nothing while the box is shut, since a folder match with no file and a file match with no
 * match are both rows the model never builds.
 *
 * It is where a *folder* row's answer comes from — folder rows are structure the query says nothing
 * about, the way a resource group is in the source control pane — while a file row's is
 * `SearchRanking.unmatched`, because a file the query *did* name has to keep its row whatever its
 * matches say.
 */
const searchTreeFilter: ITreeFilter<RenderableMatch, FuzzyScore> = {
	filter(element: RenderableMatch): TreeFilterResult<FuzzyScore> {
		return isSearchTreeMatch(element) ? TreeVisibility.Visible : TreeVisibility.Recurse;
	}
};

/** What a search row is matched on, which is the string the row's own renderer draws. */
class SearchRanking implements IRanking<RenderableMatch, FuzzyScore> {

	/** Where each row scored, so the filter and `Tab`'s candidate list ask the scorer once between them. */
	private readonly scores = new Map<RenderableMatch, number>();

	private query: IPreparedQuery | undefined;
	private cache: FuzzyScorerCache = Object.create(null);
	private _pattern = '';

	constructor(private readonly files: IItemAccessor<ISearchTreeFileMatch>) { }

	get pattern(): string {
		return this._pattern;
	}

	set pattern(pattern: string) {
		this._pattern = pattern;
		this.query = pattern ? prepareQuery(pattern) : undefined;
		this.scores.clear();
		this.cache = Object.create(null);
	}

	/** Both row kinds the query has something to say about; a folder row is structure, like a group. */
	ranks(element: RenderableMatch): boolean {
		return isSearchTreeFileMatch(element) || isSearchTreeMatch(element);
	}

	/**
	 * **What `Tab` writes, which is a file row's name and nothing else.** A match row is a line of
	 * source, and completing the box to one is not a completion anybody asked for — so it answers
	 * `undefined` here rather than being an arm of the key handler.
	 *
	 * A file row only answers while the query *named* it: one that is on screen because a match under
	 * it matched is not a candidate either, which is what makes `Tab` do nothing on a query only match
	 * rows survive.
	 */
	name(element: RenderableMatch): string | undefined {
		return isSearchTreeFileMatch(element) && this.matched(element) ? element.name() : undefined;
	}

	/**
	 * The shared rule over this pane's own score, and no tint: a row here is drawn by its own
	 * renderer — `label.setFile` and `preview()` — and neither reads `filterData`, so there is no
	 * `FuzzyScore` to carry. `scoreFor` is asked directly rather than through `matched` because
	 * `ViewRootFilter.filter` returns on an empty pattern before it reaches here, which is the same
	 * invariant `ExplorerRanking` asserts with `this.query!`.
	 */
	rank(element: RenderableMatch): { data?: FuzzyScore } | undefined {
		return rankOf(this.scoreFor(element));
	}

	/**
	 * A file the query did not name keeps its row for as long as a match under it did, which is
	 * `FindFilter`'s own default in `TreeFindMode.Filter`. A match row has nothing beneath it, so
	 * there is nothing for it to recurse into and it goes.
	 */
	unmatched(element: RenderableMatch): TreeVisibility {
		return isSearchTreeMatch(element) ? TreeVisibility.Hidden : TreeVisibility.Recurse;
	}

	/** With no query every row is named; otherwise it is what `scoreItemFuzzy` said about the row. */
	private matched(element: RenderableMatch): boolean {
		return !this.query || this.scoreFor(element) > 0;
	}

	private scoreFor(element: RenderableMatch): number {
		let score = this.scores.get(element);

		if (score === undefined) {
			// A match under a file the query named is one of that file's matches, so it stays with it:
			// the tree hands a matched parent's children a `Visible` parent visibility for the same
			// reason, and here the parent's own score is the answer already computed.
			score = isSearchTreeMatch(element)
				? scoreItemFuzzy(element, this.query!, false, matchAccessor, this.cache).score || this.scoreFor(element.parent())
				: scoreItemFuzzy(element as ISearchTreeFileMatch, this.query!, true, this.files, this.cache).score;
			this.scores.set(element, score);
		}

		return score;
	}
}

/** The search pane's `/`, which is the shared composition over the ranking above. */
export class SearchFilter extends ViewRootFilter<RenderableMatch, FuzzyScore, SearchRanking> {

	/** No path walks in front of this one, so there is nothing that can fail to resolve. */
	set(pattern: string): void {
		this.apply(pattern, true);
	}
}

/**
 * **No sorter, and that is the pane rather than an omission**: search enumerates its own rows level
 * by level through `searchMatchComparer`, so the model is given no `ITreeSorter` and the ranking has
 * no ordering to state. Ranking a match row above its sibling would put a file's matches in
 * fuzzy-score order rather than in the order they are in the file.
 */
export function createSearchFilter(labelService: ILabelService): SearchFilter {
	const files: IItemAccessor<ISearchTreeFileMatch> = {
		getItemLabel: file => file.name(),
		getItemDescription: file => labelService.getUriLabel(dirname(file.resource), { relative: true }),
		getItemPath: file => file.resource.fsPath
	};

	return new SearchFilter(new SearchRanking(files), searchTreeFilter);
}
