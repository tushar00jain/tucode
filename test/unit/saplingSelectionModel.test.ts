/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommitInfo, Hash } from '../../src/vs/workbench/contrib/sapling/common/types.js';
import type { ISaplingSelection, ISaplingSelectionService } from '../../src/vs/workbench/contrib/sapling/tauri/saplingSelection.js';

import { clickSelection, selectedIndex, stepSelection } from '../../src/vs/workbench/contrib/sapling/tauri/saplingSelectionModel.js';

/**
 * The two gestures ISL has for the selection — stepping with the arrows and clicking a row.
 *
 * The service is a recording stand-in rather than `SaplingSelectionService`, and deliberately:
 * what a *reconcile* leaves behind is that class's contract and has its own answer, while this
 * module's contract is which of the two calls a gesture makes. It is also what the harness
 * allows — the real class reaches the instantiation tree, which these tests cannot load (see
 * `saplingDagModel.ts`, and the `.d.ts` gap in `tsResolve.mjs`).
 */

const ROOT = '/repo';
const OTHER = '/other';

/** The model reads a hash. Nothing else on a commit is in play. */
function commit(hash: Hash): CommitInfo {
	return { hash } as CommitInfo;
}

/** "." at the top, as `sl` prints a smartlog: descendants first. */
const commits = [commit('c2'), commit('c1'), commit('c0')];

type Reconciled = { readonly root: string; readonly commits: readonly CommitInfo[] };

class RecordingSelectionService implements ISaplingSelectionService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChangeSelection = () => ({ dispose() { } });

	readonly reconciled: Reconciled[] = [];

	constructor(public selection: ISaplingSelection | undefined) { }

	select(selection: ISaplingSelection | undefined): void {
		this.selection = selection;
	}

	reconcile(root: string, commits: readonly CommitInfo[]): void {
		this.reconciled.push({ root, commits });
	}
}

/** A service holding the selection a fetch or a click would have left, or nothing. */
function selectionOn(hash: Hash | undefined, options: { explicit?: boolean; root?: string } = {}): RecordingSelectionService {
	const commit = commits.find(candidate => candidate.hash === hash);

	return new RecordingSelectionService(commit
		? { root: options.root ?? ROOT, commit, explicit: options.explicit ?? true }
		: undefined);
}

describe('selectedIndex', () => {
	it('finds the published selection in the drawn commits', () => {
		assert.equal(selectedIndex(selectionOn('c1'), ROOT, commits), 1);
	});

	it('answers -1 while nothing is selected', () => {
		assert.equal(selectedIndex(selectionOn(undefined), ROOT, commits), -1);
	});

	it('answers -1 for a selection published for another repository', () => {
		assert.equal(selectedIndex(selectionOn('c1', { root: OTHER }), ROOT, commits), -1);
	});
});

describe('stepSelection', () => {
	it('moves one commit down and publishes it as picked', () => {
		const service = selectionOn('c1');
		assert.equal(stepSelection(service, ROOT, commits, 1)?.hash, 'c0');
		assert.deepEqual(service.selection, { root: ROOT, commit: commits[2], explicit: true });
	});

	it('moves one commit up', () => {
		assert.equal(stepSelection(selectionOn('c1'), ROOT, commits, -1)?.hash, 'c2');
	});

	it('stops at the top rather than wrapping', () => {
		assert.equal(stepSelection(selectionOn('c2'), ROOT, commits, -1)?.hash, 'c2');
	});

	it('stops at the bottom rather than wrapping', () => {
		assert.equal(stepSelection(selectionOn('c0'), ROOT, commits, 1)?.hash, 'c0');
	});

	it('steps from the "." a fetch reconciled to, which is not an explicit selection', () => {
		const service = selectionOn('c1', { explicit: false });
		assert.equal(stepSelection(service, ROOT, commits, 1)?.hash, 'c0');
		assert.equal(service.selection?.explicit, true);
	});

	it('does nothing while the selection is not one of the drawn commits', () => {
		const service = selectionOn(undefined);
		assert.equal(stepSelection(service, ROOT, commits, 1), undefined);
		assert.equal(service.selection, undefined);
	});

	it('does nothing while the selection belongs to another repository', () => {
		const service = selectionOn('c1', { root: OTHER });
		assert.equal(stepSelection(service, ROOT, commits, 1), undefined);
		assert.equal(service.selection?.root, OTHER);
	});
});

describe('clickSelection', () => {
	it('picks the clicked commit', () => {
		const service = selectionOn(undefined);
		clickSelection(service, ROOT, commits, 'c0');
		assert.deepEqual(service.selection, { root: ROOT, commit: commits[2], explicit: true });
	});

	it('clicking the picked commit again clears back to "." by reconciling', () => {
		const service = selectionOn('c0');
		clickSelection(service, ROOT, commits, 'c0');
		assert.deepEqual(service.reconciled, [{ root: ROOT, commits }]);
	});

	it('clicking a commit picked by a fetch rather than by the user picks it', () => {
		const service = selectionOn('c0', { explicit: false });
		clickSelection(service, ROOT, commits, 'c0');
		assert.equal(service.reconciled.length, 0);
		assert.equal(service.selection?.explicit, true);
	});

	it('leaves the selection alone for a hash that is not drawn, and for no hash at all', () => {
		const service = selectionOn('c1');
		clickSelection(service, ROOT, commits, 'gone');
		clickSelection(service, ROOT, commits, undefined);
		assert.equal(service.selection?.commit.hash, 'c1');
		assert.equal(service.reconciled.length, 0);
	});
});
