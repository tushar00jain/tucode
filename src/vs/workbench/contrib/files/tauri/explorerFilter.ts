/*---------------------------------------------------------------------------------------------
 *  What `/` in the explorer answers, over the grammar and the composition `viewRoot.ts` holds for
 *  every pane that has a view root: which nodes a path segment descends over, what a row is matched
 *  on, and how two matched rows are ordered.
 *
 *  **The matching is not ours.** It is `Ctrl+P`'s own scorer — `prepareQuery`, `scoreItemFuzzy`
 *  and `compareItemsByFuzzyScore` over an `IItemAccessor<ExplorerItem>`, which is the extension
 *  point `fuzzyScorer.ts` exports for exactly this. So which child a segment lands on, which rows
 *  survive the last segment, in what order they sit and where the tint falls are all upstream's
 *  answers, asked of a different item type.
 *
 *  **What has no upstream counterpart is the view root.** It meets the vendored tree only at
 *  `ITreeFilter`/`ITreeSorter`, `ExplorerItem.fetchChildren` and the tree's own input — seams
 *  upstream already exposes — so a future upgrade has this file, `explorerViewRoot.ts` and
 *  `viewRoot.ts` to move rather than a change threaded through `explorerViewer.ts`'s callers.
 *
 *  Upstream counterpart: none — VS Code's explorer has no view root, and its tree find (`FindFilter`, `TreeFindMode.Filter`) filters the whole tree rather than one level of it.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { compareItemsByFuzzyScore, FuzzyScorerCache, IItemAccessor, IPreparedQuery, prepareQuery, scoreItemFuzzy } from '../../../../base/common/fuzzyScorer.js';
import { relativePath } from '../../../../base/common/resources.js';
import { ITreeFilter, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { ExplorerItem } from '../common/explorerModel.js';
import { SortOrder } from '../common/files.js';
import { INodes, pathQuery, rankOf, toFuzzyScore } from '../../../browser/tauri/viewRoot.js';
import { IRanking, ViewRootFilter } from '../../../browser/tauri/viewRootFilter.js';

/**
 * What `scoreItemFuzzy` reads an `ExplorerItem` through — `quickPickItemScorerAccessor`'s
 * counterpart for this item type.
 *
 * **The description is deliberately absent**, and that is the one place this differs from the
 * accessor `filesQuickAccess.ts` uses: `doScoreItemFuzzySingle` falls back to the description when
 * the label does not match, and every direct child of one folder has the *same* description — so a
 * query matching it would keep every row and tint none of them.
 */
export const explorerItemAccessor: IItemAccessor<ExplorerItem> = {
	getItemLabel: item => item.name,
	getItemDescription: () => undefined,
	getItemPath: item => item.resource.fsPath
};

/**
 * What a path segment descends over: the folders inside one, and the workspace's roots at the top.
 * `fetchChildren` is the explorer model's own directory read, so exactly the folders being looked at
 * are loaded — which is the whole reason `/` re-roots rather than expanding a tree whose deeper rows
 * are not there yet.
 */
export function explorerNodes(roots: readonly ExplorerItem[], sortOrder: SortOrder): INodes<ExplorerItem> {
	return {
		children: async item => item ? (await item.fetchChildren(sortOrder)).filter(child => child.isDirectory) : roots,
		name: item => item.name
	};
}

/**
 * The query that names `item` and filters nothing out of it, which is what `/` opens with — every
 * segment of the path from the workspace, whose own children are the roots.
 */
export function queryFor(item: ExplorerItem | undefined): string {
	if (!item) {
		return '';
	}

	const inside = relativePath(item.root.resource, item.resource);

	return pathQuery(inside ? [item.root.name, ...inside.split('/')] : [item.root.name]);
}

/** What an explorer row is matched on, and where two matched rows sit — both `Ctrl+P`'s answers. */
class ExplorerRanking implements IRanking<ExplorerItem, FuzzyScore> {

	/**
	 * **Whichever item's children are on screen** — the item the tree is rooted at, so the rows the
	 * pattern ranks are the rows the pane is drawing. `undefined` is the roots of a multi-root
	 * workspace, which are the items whose `parent` is `undefined`, so the one comparison below
	 * answers that too.
	 */
	root: ExplorerItem | undefined;

	private query: IPreparedQuery | undefined;
	private cache: FuzzyScorerCache = Object.create(null);
	private _pattern = '';

	get pattern(): string {
		return this._pattern;
	}

	set pattern(pattern: string) {
		this._pattern = pattern;
		this.query = pattern ? prepareQuery(pattern) : undefined;
		this.cache = Object.create(null);
	}

	ranks(element: ExplorerItem): boolean {
		return element.parent === this.root;
	}

	name(element: ExplorerItem): string {
		return explorerItemAccessor.getItemLabel(element)!;
	}

	rank(element: ExplorerItem): { data?: FuzzyScore } | undefined {
		const { score, labelMatch } = scoreItemFuzzy(element, this.query!, true, explorerItemAccessor, this.cache);

		return rankOf(score, toFuzzyScore(score, labelMatch));
	}

	compare(one: ExplorerItem, other: ExplorerItem): number {
		return compareItemsByFuzzyScore(one, other, this.query!, true, explorerItemAccessor, this.cache);
	}
}

/** The explorer's `/`, which is the shared composition over the ranking above. */
export class ExplorerFilter extends ViewRootFilter<ExplorerItem, FuzzyScore, ExplorerRanking> {

	constructor(_filter: ITreeFilter<ExplorerItem, FuzzyScore>, _sorter: ITreeSorter<ExplorerItem>) {
		super(new ExplorerRanking(), _filter, _sorter);
	}

	set(root: ExplorerItem | undefined, pattern: string, resolved: boolean): void {
		this.ranking.root = root;
		this.apply(pattern, resolved);
	}

	override clear(): void {
		this.ranking.root = undefined;
		super.clear();
	}
}
