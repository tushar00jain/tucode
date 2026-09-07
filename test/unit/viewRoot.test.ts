/*---------------------------------------------------------------------------------------------
 *  The `/` grammar, asserted without a tree.
 *
 *  `viewRoot.ts` is the half of `/` that names no widget and the half no pane decides anything in:
 *  how a query splits into a path and a name, where a path prefix lands, what `Tab` completes the
 *  last segment to, and how a scorer's `IMatch[]` becomes the `FuzzyScore` a renderer tints from.
 *  Every pane-specific answer — what a segment descends over, what a row is named — arrives as a
 *  parameter, so a fixture is the whole test rig.
 *
 *  This is the file the composition half (`viewRootFilter.ts`) was split away from: it needs
 *  `TreeVisibility` and `getVisibleState` as values, and their closure reaches a decorator Node's
 *  type stripping rejects. Nothing here imports a tree.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	completeQuery, descend, nameAccessor, pathQuery, rankOf, splitQuery, toFuzzyScore,
	type INodes
} from '../../src/vs/workbench/browser/tauri/viewRoot.js';

describe('viewRoot · splitQuery', () => {

	it('reads an empty query as no path and no name, which is what `/` opens the top level with', () => {
		assert.deepEqual(splitQuery(''), { path: [], pattern: '' });
	});

	it('reads a bare name as a name at the top level', () => {
		assert.deepEqual(splitQuery('foo'), { path: [], pattern: 'foo' });
	});

	it('splits at the last separator: everything before it is where to look', () => {
		assert.deepEqual(splitQuery('src/tui'), { path: ['src'], pattern: 'tui' });
		assert.deepEqual(splitQuery('src/tui/views'), { path: ['src', 'tui'], pattern: 'views' });
	});

	it('reads a trailing separator as a complete path with nothing named yet', () => {
		assert.deepEqual(splitQuery('src/'), { path: ['src'], pattern: '' });
	});

	it('drops empty segments, so a doubled separator names the same folder', () => {
		assert.deepEqual(splitQuery('src//tui'), { path: ['src'], pattern: 'tui' });
	});

	it('has no absolute form — a leading separator is not a root', () => {
		assert.deepEqual(splitQuery('/src/tui'), splitQuery('src/tui'));
	});
});

describe('viewRoot · pathQuery', () => {

	it('answers the empty query for the top level, which is the query that shows everything', () => {
		assert.equal(pathQuery([]), '');
	});

	it('ends on the separator, so the first thing typed is a name inside the root', () => {
		assert.equal(pathQuery(['src']), 'src/');
		assert.equal(pathQuery(['src', 'tui']), 'src/tui/');
	});

	it('is `splitQuery`\'s inverse: what it writes reads back as the same path and no name', () => {
		for (const path of [[], ['src'], ['src', 'tui', 'views']]) {
			assert.deepEqual(splitQuery(pathQuery(path)), { path, pattern: '' });
		}
	});
});

describe('viewRoot · toFuzzyScore', () => {

	it('answers a score and a word start with no offsets when nothing matched', () => {
		assert.deepEqual(toFuzzyScore(7, undefined), [7, 0]);
		assert.deepEqual(toFuzzyScore(7, []), [7, 0]);
	});

	it('expands a half-open range to its own indices — the end is not one of them', () => {
		assert.deepEqual(toFuzzyScore(1, [{ start: 1, end: 3 }]), [1, 0, 2, 1]);
	});

	it('writes the offsets in descending order, which is the order `createMatches` reads them', () => {
		const score = toFuzzyScore(1, [{ start: 0, end: 2 }, { start: 5, end: 7 }]);

		assert.deepEqual(score, [1, 0, 6, 5, 1, 0]);
		assert.deepEqual(score.slice(2), [...score.slice(2)].sort((a, b) => b - a));
	});

	it('contributes nothing for an empty range', () => {
		assert.deepEqual(toFuzzyScore(3, [{ start: 2, end: 2 }]), [3, 0]);
	});
});

/**
 * The score-to-visibility rule, which was written once in each of the three panes and is now written
 * here. Every assertion below is chosen so the copies it replaced would fail it:
 *
 * - the source control pane's read `return {}` — ranked and never hidden — so *hides on a zero
 *   score* is the sentence that has to be asserted rather than *keeps on a match*;
 * - the explorer's tested the score for truthiness, so a **negative** score — `FuzzyScore.Default`
 *   is `-100` — is where a truthy test and the rule diverge;
 * - the payload arm was written as `data ? { data } : undefined`, so a scored-at-nothing row that
 *   was handed a payload anyway is where reading the score and reading the payload diverge.
 */
describe('viewRoot · rankOf', () => {

	/** A payload of the shape a pane that tints actually hands over, built by its own sibling. */
	const tint = toFuzzyScore(9, [{ start: 0, end: 2 }]);

	it('hides a row the query scored at nothing', () => {
		assert.equal(rankOf(0), undefined);
	});

	it('keeps a row the query scored, at the first score above nothing', () => {
		assert.ok(rankOf(1), 'the smallest score above zero is a match');
	});

	it('hides a row the query scored at nothing even when it was handed a payload', () => {
		assert.equal(rankOf(0, tint), undefined);
	});

	it('hides a row scored below nothing, which is what an unmatched row is scored', () => {
		// `FuzzyScore.Default`'s own score, which a truthiness test on the score would keep.
		assert.equal(rankOf(-100), undefined);
	});

	it('ranks a row that has no label to tint without a payload', () => {
		const ranked = rankOf(7);

		assert.ok(ranked);
		assert.equal(ranked.data, undefined, 'a pane with nothing to tint answered a payload');
	});

	it('carries the payload through for a pane that has one', () => {
		assert.deepEqual(rankOf(7, tint), { data: tint });
	});
});

describe('viewRoot · completeQuery', () => {

	/** Three rows of which the middle one has no name — a match row, a group, a commit box. */
	const rows = ['alpha', undefined, 'beta'];
	const name = (row: string | undefined) => row;

	it('has nothing to complete to when no row answers a name', () => {
		assert.equal(completeQuery('a', [undefined, undefined], name, -1, 1), undefined);
	});

	it('lands the first `Tab` on the top-ranked row rather than past it', () => {
		assert.deepEqual(completeQuery('a', rows, name, -1, 1), { query: 'alpha', index: 0 });
	});

	it('lands the first `Shift+Tab` on the last row, which is the same wrap one step earlier', () => {
		assert.deepEqual(completeQuery('a', rows, name, -1, -1), { query: 'beta', index: 2 });
	});

	it('steps over a row with no name and reports where that row is, not where the candidate is', () => {
		assert.deepEqual(completeQuery('alpha', rows, name, 0, 1), { query: 'beta', index: 2 });
	});

	it('wraps round in both directions', () => {
		assert.deepEqual(completeQuery('beta', rows, name, 2, 1), { query: 'alpha', index: 0 });
		assert.deepEqual(completeQuery('alpha', rows, name, 0, -1), { query: 'beta', index: 2 });
	});

	it('keeps the path in front of the last segment and rewrites only the segment', () => {
		assert.deepEqual(completeQuery('src/tui/al', rows, name, -1, 1), { query: 'src/tui/alpha', index: 0 });
	});

	it('writes the name alone in a pane whose query is one pattern rather than a path', () => {
		assert.deepEqual(completeQuery('al', rows, name, -1, 1), { query: 'alpha', index: 0 });
	});

	it('starts the cycle over from a `from` no row carries, which is what an edit puts it back to', () => {
		assert.deepEqual(completeQuery('a', rows, name, 1, 1), { query: 'alpha', index: 0 });
	});
});

describe('viewRoot · nameAccessor', () => {

	it('scores a segment against the name and never against a description', () => {
		const accessor = nameAccessor((node: { label: string }) => node.label);
		const node = { label: 'src' };

		assert.equal(accessor.getItemLabel!(node), 'src');
		assert.equal(accessor.getItemDescription!(node), undefined);
		assert.equal(accessor.getItemPath!(node), 'src');
	});
});

describe('viewRoot · descend', () => {

	interface IFixtureNode {
		name: string;
		children?: IFixtureNode[];
	}

	const tree: IFixtureNode[] = [
		{ name: 'source', children: [{ name: 'inner' }] },
		{ name: 'src', children: [{ name: 'tui', children: [{ name: 'views' }] }, { name: 'test' }] }
	];

	/** The roots and their children, handed over asynchronously as a real pane's are. */
	const nodes: INodes<IFixtureNode> = {
		children: async node => node ? node.children ?? [] : tree,
		name: node => node.name
	};

	it('lands the empty path on the top level itself, which is no node at all', async () => {
		assert.deepEqual(await descend(nodes, []), { root: undefined, resolved: true });
	});

	it('lands a segment on the best-scoring child rather than on the first one that matches', async () => {
		// `source` contains `s`, `r` and `c` in order, so a first-match walk would stop there — and
		// it is deliberately in front of `src` in the fixture so that walk would be visible.
		const { root, resolved } = await descend(nodes, ['src']);

		assert.equal(root?.name, 'src');
		assert.equal(resolved, true);
	});

	it('walks one segment at a time, asking each landing for its own children', async () => {
		assert.equal((await descend(nodes, ['src', 'tui'])).root?.name, 'tui');
		assert.equal((await descend(nodes, ['src', 'tui', 'vie'])).root?.name, 'views');
	});

	it('stops where a segment scores against nothing, and says the path did not resolve', async () => {
		const { root, resolved } = await descend(nodes, ['src', 'zzz']);

		assert.equal(root?.name, 'src');
		assert.equal(resolved, false);
	});

	it('does not carry on past an unresolved segment', async () => {
		const { root, resolved } = await descend(nodes, ['src', 'zzz', 'tui']);

		assert.equal(root?.name, 'src');
		assert.equal(resolved, false);
	});

	it('answers no root and no resolution when the first segment names nothing at the top', async () => {
		assert.deepEqual(await descend(nodes, ['zzz']), { root: undefined, resolved: false });
	});

	it('scores a segment against a sibling set that has no match under a node with no children', async () => {
		const { root, resolved } = await descend(nodes, ['src', 'test', 'anything']);

		assert.equal(root?.name, 'test');
		assert.equal(resolved, false);
	});
});
