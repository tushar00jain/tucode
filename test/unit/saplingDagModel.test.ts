/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommitInfo, Hash } from '../../src/vs/workbench/contrib/sapling/common/types.js';

import { subsetForRendering } from '../../src/vs/workbench/contrib/sapling/tauri/saplingDagModel.js';
import { commit } from './saplingCommit.js';

/**
 * `subsetForRendering` is a port of `Dag.subsetForRenderingImpl`, and upstream has no test for
 * it — its own suite exercises the dag through the renderer instead. So these are written
 * against the two rules the implementation states rather than converted from anything: what it
 * hides is *unnamed public commits with no draft hanging off them*, and *the middle of an
 * obsolete stack*.
 *
 * The e2e fixture cannot reach either: its repositories have no obsolete commits and no public
 * ones, because `sl` in a git checkout with no remote calls everything draft. So this is the
 * only coverage the filter has.
 */

const drawn = (commits: readonly CommitInfo[]) => subsetForRendering(commits).map(info => info.hash);

describe('subsetForRendering', () => {
	// Descendants first, as `sl` prints them: d3 -> p2 -> p1 -> p0.
	const publicChain = [
		commit('p3', { phase: 'public', parents: ['p2'] }),
		commit('p2', { phase: 'public', parents: ['p1'] }),
		commit('p1', { phase: 'public', parents: ['p0'] }),
		commit('p0', { phase: 'public' })
	];

	it('hides a public commit that carries no bookmark and no draft child', () => {
		assert.deepEqual(drawn(publicChain), []);
	});

	it('keeps a public commit a draft hangs directly off', () => {
		const draft = commit('d0', { parents: ['p2'] });
		assert.deepEqual(drawn([draft, ...publicChain]), ['d0', 'p2']);
	});

	it('keeps a public commit that carries a bookmark of either kind, and "."', () => {
		assert.deepEqual(drawn([
			commit('local', { phase: 'public', bookmarks: ['main'] }),
			commit('remote', { phase: 'public', remoteBookmarks: ['origin/main'] }),
			commit('dot', { phase: 'public', isDot: true }),
			commit('bare', { phase: 'public' })
		]), ['local', 'remote', 'dot']);
	});

	it('draws a draft commit whatever it carries', () => {
		assert.deepEqual(drawn([commit('a', { parents: ['b'] }), commit('b')]), ['a', 'b']);
	});

	// The stack is o3 -> o2 -> o1 -> o0, every one of them rewritten. Upstream keeps the roots
	// and the heads of that set and drops what is between them, which here is o1 and o2.
	it('condenses an obsolete stack to its head and its root', () => {
		const obsolete = (hash: Hash, parents: Hash[]) =>
			commit(hash, { parents, successorInfo: { hash: 'new', type: 'amend' } });

		assert.deepEqual(drawn([
			obsolete('o3', ['o2']),
			obsolete('o2', ['o1']),
			obsolete('o1', ['o0']),
			obsolete('o0', [])
		]), ['o3', 'o0']);
	});

	it('keeps an obsolete commit a live draft is sitting on', () => {
		const obsolete = (hash: Hash, parents: Hash[]) =>
			commit(hash, { parents, successorInfo: { hash: 'new', type: 'rebase' } });

		// `d0` is a draft that is not obsolete, so its parent `o2` survives the condensing even
		// though it is neither the head nor the root of the obsolete set.
		assert.deepEqual(drawn([
			obsolete('o3', ['o2']),
			commit('d0', { parents: ['o2'] }),
			obsolete('o2', ['o1']),
			obsolete('o1', ['o0']),
			obsolete('o0', [])
		]), ['o3', 'd0', 'o2', 'o0']);
	});

	// A single obsolete commit is both the root and the head of its own set, so nothing about
	// the condensing may drop it.
	it('keeps a lone obsolete commit', () => {
		assert.deepEqual(drawn([commit('o', { successorInfo: { hash: 'new', type: 'fold' } })]), ['o']);
	});

	// `grandparents` is the second half of the edge set — `Dag.add` folds it into `parents` — so
	// a draft whose only connection to a public commit is indirect must still protect it.
	it('follows a grandparent edge when it decides what a draft hangs off', () => {
		assert.deepEqual(drawn([
			commit('d0', { grandparents: ['p0'] }),
			commit('p0', { phase: 'public' })
		]), ['d0', 'p0']);
	});

	it('preserves the order it was given', () => {
		const commits = [commit('c'), commit('b'), commit('a')];
		assert.deepEqual(drawn(commits), ['c', 'b', 'a']);
	});
});
