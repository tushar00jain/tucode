/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: none — tscode renders the smartlog as SVG tiles and has no test of a textual one.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommitInfo } from '../../src/vs/workbench/contrib/sapling/common/types.js';

import { renderToTextRows } from '../../src/vs/workbench/contrib/sapling/tauri/saplingTextRows.js';
import { commit } from './saplingCommit.js';

/**
 * `renderToTextRows` composes three things that are each tested elsewhere — `TextRenderer` by
 * `renderText.test.ts`, which is upstream's own suite, `subsetForRendering` by
 * `saplingDagModel.test.ts`, and `relativeDate` by ISL. So what is asserted here is the
 * composition: that the glyph column is the one `TextRenderer` drew, that the text beside it is
 * `Commit.tsx`'s three parts in upstream's order, and that the virtual working-copy row is not
 * drawn.
 *
 * **The expected graphs are upstream's, not this code's.** Each one is the corresponding fixture
 * in `renderText.test.ts` — `TEST_BASIC`, `TEST_RESERVED_COLUMN`'s `W`/`G` pair and
 * `TEST_TERMINATIONS`' `B` — with `o` replaced by the glyph `sl` uses for that commit's state.
 */

/** `relativeDate`'s answer for a commit made now, which is `shortFormats`' first entry. */
const NOW = 'now';

/** Every line of the graph, as the pane lays them out — one commit's block after another. */
function lines(commits: readonly CommitInfo[]): string[] {
	return renderToTextRows(commits).flatMap(row => row.lines);
}

const now = () => new Date();

describe('renderToTextRows', () => {
	// c -> b -> a, descendants first, as `sl` prints them. `TEST_BASIC` is the same chain.
	const chain = [
		commit('c', { parents: ['b'], date: now(), isDot: true }),
		commit('b', { parents: ['a'], date: now() }),
		commit('a', { date: now() })
	];

	it('draws the chain `TEST_BASIC` draws, with "@" on "."', () => {
		assert.deepEqual(lines(chain), [
			`@  c  ${NOW}`,
			'│',
			`o  b  ${NOW}`,
			'│',
			`o  a  ${NOW}`,
			''
		]);
	});

	it('does not draw the virtual working-copy row', () => {
		const rows = renderToTextRows(chain);

		assert.deepEqual(rows.map(row => row.info.hash), ['c', 'b', 'a']);
		assert.equal(rows.some(row => row.info.isYouAreHere), false);
	});

	// `x` is the glyph the CLI puts on an obsolete commit, in place of the "/" `RenderDag.tsx`
	// draws inside the circle. "." wins over it: `sl` marks the working directory parent whatever
	// else is true of it.
	it('draws "x" on an obsolete commit and "@" on an obsolete "."', () => {
		const successorInfo = { hash: 'newer', type: 'amend' };

		assert.deepEqual(lines([commit('o', { successorInfo, date: now() })]), [`x  o  ${NOW}`, '']);
		assert.deepEqual(lines([commit('o', { successorInfo, isDot: true, date: now() })]), [`@  o  ${NOW}`, '']);
	});

	// `reservedHash` reserves the first public commit's column, which is what indents the draft
	// beside it — `TEST_RESERVED_COLUMN`'s `X` and `G`, whose `reserve` is `G`: the reserved column
	// is held open and blank until the commit that owns it arrives, and the draft merges back into
	// it with "╭─╯".
	it('indents a draft beside the public commit whose column is reserved', () => {
		assert.deepEqual(lines([
			commit('d', { parents: ['p'], date: now() }),
			commit('p', { phase: 'public', bookmarks: ['main'], date: now() })
		]), [
			`  o  d  ${NOW}`,
			'  │',
			'╭─╯',
			`o  p  main  ${NOW}`,
			''
		]);
	});

	// A parent outside the fetched set is anonymous, which `TextRenderer` terminates with "~" —
	// `TEST_TERMINATIONS`' last row.
	it('terminates a parent outside the set with "~"', () => {
		assert.deepEqual(lines([commit('b', { parents: ['unfetched'], date: now() })]), [
			`o  b  ${NOW}`,
			'│',
			'│',
			'~'
		]);
	});

	// `Commit.tsx` puts the title first, then the bookmarks — local before remote, which is the one
	// list `AllBookmarksTruncated` truncates — then the date.
	it('puts the title, the bookmarks and the date on the row in upstream order', () => {
		assert.deepEqual(lines([commit('h', {
			title: 'a commit',
			bookmarks: ['local'],
			remoteBookmarks: ['remote/main'],
			date: now()
		})]), [`o  a commit  local  remote/main  ${NOW}`, '']);
	});

});
