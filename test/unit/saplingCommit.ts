/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: test/unit/saplingDagModel.test.ts
 *--------------------------------------------------------------------------------------------*/

import type { CommitInfo, Hash } from '../../src/vs/workbench/contrib/sapling/common/types.js';

/**
 * One commit, with the fields a test sets and defaults for the rest. Shared by the two suites over
 * `saplingDagModel.ts` and `saplingTextRows.ts`, which walk the same `CommitInfo` list.
 *
 * The title defaults to the hash so that a rendered row names the commit it came from.
 */
export function commit(hash: Hash, options: Partial<CommitInfo> = {}): CommitInfo {
	return {
		hash,
		title: hash,
		parents: [],
		grandparents: [],
		phase: 'draft',
		isDot: false,
		author: '',
		date: new Date(0),
		description: '',
		bookmarks: [],
		remoteBookmarks: [],
		filePathsSample: [],
		totalFileCount: 0,
		closestPredecessors: [],
		...options
	};
}
