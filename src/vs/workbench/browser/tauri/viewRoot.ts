/*---------------------------------------------------------------------------------------------
 *  The **view root**, as one file for the panes that have one: a path prefix that moves which
 *  item's children are on screen, and a last segment that filters and ranks that root's children.
 *
 *  **This is the home of the grammar, and it holds nothing but the grammar.** So nothing
 *  GUI-specific may be added here: the box, the widget and the pane wiring live beside it, in
 *  `viewRootBox.ts` and in each pane's own `tauri/` file.
 *
 *  Each pane answers three questions differently — what a segment descends over, what a row is
 *  matched on, and how two matched rows are ordered — and every one of those answers is upstream's,
 *  in the pane's own file. What is the same in all of them, and therefore lives in these two files,
 *  is the grammar and the composition: how a query splits into a path and a name, how the path walks one
 *  segment at a time, what a score makes of the row that scored it, how the ranking sits on top of
 *  the filter and the sorter the tree already had, and what `Tab` completes the last segment to.
 *
 *  **A pane can have the box without having a view root.** The search pane's `/` takes the box, the
 *  ranking and the completion and touches `splitQuery`/`pathQuery`/`descend` not at all, because a
 *  result list is two levels deep and there is nothing under a match row to descend into.
 *
 *  **The grammar is here and the composition is in `viewRootFilter.ts`**, which is one module split
 *  in two rather than two homes for one thing: everything here is a function over strings and nodes
 *  with no tree type anywhere in it, so it loads under `node --test` and is the half that carries the
 *  suite. `ViewRootFilter` needs `TreeVisibility` and `getVisibleState` as *values*, and their
 *  closure reaches `base/browser/touch.ts`, whose decorators Node's type stripping rejects — so the
 *  line the file is cut along is the line the test harness can reach. Two import paths are not two
 *  copies.
 *
 *  Upstream counterpart: none — VS Code has no view root in any pane; its tree find (`FindFilter`, `TreeFindMode.Filter`) filters a whole tree rather than one level of one, and nothing there moves the item a tree is displayed from.
 *--------------------------------------------------------------------------------------------*/

import type { FuzzyScore, IMatch } from '../../../base/common/filters.js';
import { prepareQuery, scoreItemFuzzy, type FuzzyScorerCache, type IItemAccessor } from '../../../base/common/fuzzyScorer.js';
import { localize } from '../../../nls.js';

/** What an empty box says it takes, which is the same sentence in every pane that takes a path. */
export const FILTER_PLACEHOLDER = localize('tscode.filterPlaceholder', "path to filter");

/**
 * A query split at its separators: the segments that name where to look, and the name to look for.
 *
 * An empty segment says nothing about which folder is meant, so `src//tui` and `src/tui` are one
 * query and a leading `/` is not a root — **every path is relative to the pane's own top level**,
 * whose children are the roots (a workspace's folders, or the repositories), so a root is named by
 * its first segment and there is no absolute form.
 */
export function splitQuery(query: string): { path: string[]; pattern: string } {
	const segments = query.split('/');
	const pattern = segments.pop() ?? '';

	return { path: segments.filter(segment => segment.length > 0), pattern };
}

/**
 * `splitQuery`'s inverse: the query that names a root and filters nothing out of it, which is what
 * `/` opens with. Every segment, then the separator that makes the last one complete — so the first
 * thing typed is a name *inside* the root.
 *
 * **The top level has no path, so it is the empty query**, and an empty query already means *show
 * everything*. There is no token for the top and no arm here that produces one.
 */
export function pathQuery(path: readonly string[]): string {
	return path.length ? `${path.join('/')}/` : '';
}

/**
 * The one bridge that has to be written for a pane scored by `scoreItemFuzzy`: it answers with
 * `IMatch[]` while a renderer draws `createMatches(node.filterData)`, which reads a `FuzzyScore`.
 *
 * `FuzzyScore` is `[score, wordStart, ...matchedIndices]`, so each `[start, end)` expands to its
 * indices. **They are written in descending order**, because `createMatches` walks the array from
 * the back and coalesces a run only when the next index continues the last one.
 */
export function toFuzzyScore(score: number, matches: readonly IMatch[] | undefined): FuzzyScore {
	const offsets: number[] = [];

	for (const match of matches ?? []) {
		for (let at = match.start; at < match.end; at++) {
			offsets.push(at);
		}
	}

	return [score, 0, ...offsets.reverse()];
}

/**
 * **What a score makes of the row that scored it, which is one decision for every pane: a row the
 * query scored at nothing is a row the query hides.** It is `IRanking.rank`'s answer wherever that
 * answer is read off a score, and it is here rather than beside the interface in `viewRootFilter.ts`
 * for the reason that file is cut from this one — a rule three panes were each restating is a rule a
 * test has to be able to reach, and this is the half `node --test` loads.
 *
 * `data` is the payload the row draws its tint from, and it is the one thing the panes genuinely
 * differ on: the explorer answers a `FuzzyScore` built from the score it just computed, while a
 * repository row and a search row have no label to tint and answer without one. A row with no
 * payload reads the same to `ViewRootFilter.filter` either way, since it tests `data === undefined`.
 */
export function rankOf<TFilterData>(score: number, data?: TFilterData): { data?: TFilterData } | undefined {
	return score > 0 ? { data } : undefined;
}

/**
 * `Tab`: the ranked row `delta` on from the one the box already reads, and the query that names it —
 * the path in front of the last segment, then that row's own name. So the box always says what the
 * cursor is on, and `Enter` commits a row the user can see. In a pane whose query is one pattern
 * rather than a path there is nothing in front of the last segment, so it writes the name alone.
 *
 * **The rows are the candidate list, and they are frozen while cycling**, because a completion is
 * not a query: after the first `Tab` the box holds a whole name, and re-running the query on it
 * would leave one row to move to. `from` is where the last completion landed and `-1` is what any
 * edit puts it back to, which is what makes the first `Tab` land *on* the top-ranked row rather than
 * past it — and the first `Shift+Tab` on the last, which is the same wrap one step earlier.
 */
export function completeQuery<T>(
	query: string,
	rows: readonly T[],
	name: (row: T) => string | undefined,
	from: number,
	delta: number
): { query: string; index: number } | undefined {
	const candidates: { index: number; name: string }[] = [];

	for (const [index, row] of rows.entries()) {
		const candidate = name(row);
		if (candidate !== undefined) {
			candidates.push({ index, name: candidate });
		}
	}

	if (!candidates.length) {
		return undefined;
	}

	const at = candidates.findIndex(candidate => candidate.index === from);
	const next = at === -1
		? (delta > 0 ? 0 : candidates.length - 1)
		: (at + delta + candidates.length) % candidates.length;
	const { index, name: completed } = candidates[next];

	return { query: [...splitQuery(query).path, completed].join('/'), index };
}

/**
 * What a path segment is scored against — a node's name and nothing else.
 *
 * **The description is deliberately absent**: `doScoreItemFuzzySingle` falls back to it when the
 * label misses, and every child of one folder has the same one, so a description match would keep
 * every candidate. A segment never carries a separator either (`splitQuery` is what makes a
 * segment), so `containsPathSeparator` is false and the path is never consulted; it is answered
 * anyway because the interface asks for it.
 */
export function nameAccessor<T>(name: (node: T) => string): IItemAccessor<T> {
	return { getItemLabel: name, getItemDescription: () => undefined, getItemPath: name };
}

/** What a path walks over: the children one segment may name, and what a segment is scored against. */
export interface INodes<T> {
	/** The nodes a segment chooses between — the roots when there is no node yet. */
	children(node: T | undefined): Promise<readonly T[]> | readonly T[];
	name(node: T): string;
}

function bestChild<T>(children: readonly T[], segment: string, nodes: INodes<T>, cache: FuzzyScorerCache): T | undefined {
	const query = prepareQuery(segment);
	const accessor = nameAccessor(nodes.name);
	let best: T | undefined;
	let bestScore = 0;

	for (const child of children) {
		const { score } = scoreItemFuzzy(child, query, true, accessor, cache);
		if (score > bestScore) {
			bestScore = score;
			best = child;
		}
	}

	return best;
}

/**
 * The same descent over a source whose relevant children are already loaded. `undefined` means a
 * child lookup is asynchronous, so the caller must use `descend` and its owned effect queue.
 */
export function descendLoaded<T>(nodes: INodes<T>, path: readonly string[]): { root: T | undefined; resolved: boolean } | undefined {
	const cache: FuzzyScorerCache = Object.create(null);
	let root: T | undefined;

	for (const segment of path) {
		const children = nodes.children(root);
		if (children instanceof Promise || (children && typeof (children as unknown as { then?: unknown }).then === 'function')) {
			return undefined;
		}
		const best = bestChild(children as readonly T[], segment, nodes, cache);
		if (!best) {
			return { root, resolved: false };
		}
		root = best;
	}

	return { root, resolved: true };
}

/**
 * Where a path prefix lands, descending one segment at a time from the pane's top level — so the
 * first segment names one of `children(undefined)` and `undefined` is the top itself, which is where
 * the empty path lands.
 *
 * **The matching is `Ctrl+P`'s scorer**, so which child a segment lands on is upstream's answer asked
 * of whatever node type the pane walks.
 *
 * **A segment that scores against nothing stops the walk and answers `resolved: false`.** Carrying on
 * from where it stopped would list a node the query does not name; and since the caret is always at
 * the end of the box, a prefix segment is only ever *completed* by typing `/`, so this is not a state
 * a half-typed name passes through.
 */
export async function descend<T>(nodes: INodes<T>, path: readonly string[]): Promise<{ root: T | undefined; resolved: boolean }> {
	const cache: FuzzyScorerCache = Object.create(null);
	let root: T | undefined;

	for (const segment of path) {
		const best = bestChild(await nodes.children(root), segment, nodes, cache);

		if (!best) {
			return { root, resolved: false };
		}

		root = best;
	}

	return { root, resolved: true };
}
