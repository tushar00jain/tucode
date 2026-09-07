/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Type-only, and it has to say so, for `saplingDagModel.ts`'s reason: `saplingSelection.ts`
// registers a singleton, so a plain import would drag the instantiation tree into the unit tests,
// which run on Node's type stripping rather than through a bundler.
import type { CommitInfo } from '../common/types.js';
import type { ISaplingSelectionService } from './saplingSelection.js';

/**
 * How a smartlog's selection *moves*, with no opinion about how the smartlog is drawn.
 *
 * `saplingSelection.ts` holds what the selection **is** and who hears about it; this holds what
 * the two gestures ISL has for it do — stepping with the arrow keys
 * (`useArrowKeysToChangeSelection` in `selection.ts`) and clicking a row (`onClickToSelect`). Both
 * are questions about the commit list `subsetForRendering` produces, so neither belongs to the
 * view that draws it: the tiles are a paint over this model.
 *
 * The functions are stateless over `(root, commits)` on purpose. The view already keeps the drawn
 * root and the drawn commits — it has to, to paint — so a model object holding its own copy would
 * be a second version of the same two values, and the two would drift on exactly the refresh that
 * matters.
 */

/** Where the published selection sits in `commits`, or `-1` while it is not one of them. */
export function selectedIndex(selectionService: ISaplingSelectionService, root: string, commits: readonly CommitInfo[]): number {
	const selection = selectionService.selection;
	if (!selection || selection.root !== root) {
		return -1;
	}

	return commits.findIndex(commit => commit.hash === selection.commit.hash);
}

/**
 * `useArrowKeysToChangeSelection`: one commit up or down, and stop at the ends rather than wrap.
 *
 * A selection that is not in the list is not moved — there is no commit to move *from*, and after
 * every fetch `reconcile` has already put one there or answered that the list is empty.
 */
export function stepSelection(selectionService: ISaplingSelectionService, root: string, commits: readonly CommitInfo[], delta: number): CommitInfo | undefined {
	const current = selectedIndex(selectionService, root, commits);
	if (current === -1) {
		return undefined;
	}

	const commit = commits[Math.max(0, Math.min(current + delta, commits.length - 1))];
	selectionService.select({ root, commit, explicit: true });

	return commit;
}

/**
 * `onClickToSelect`: clicking the selected commit again clears the selection back to ".", which is
 * `reconcile`'s answer for a selection nobody picked.
 */
export function clickSelection(selectionService: ISaplingSelectionService, root: string, commits: readonly CommitInfo[], hash: string | undefined): void {
	if (!hash) {
		return;
	}

	const selection = selectionService.selection;
	if (selection?.explicit && selection.commit.hash === hash) {
		selectionService.reconcile(root, commits);
		return;
	}

	const commit = commits.find(candidate => candidate.hash === hash);
	if (commit) {
		selectionService.select({ root, commit, explicit: true });
	}
}
