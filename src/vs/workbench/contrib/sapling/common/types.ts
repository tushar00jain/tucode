/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Meta Platforms, Inc. and affiliates.
 *  Licensed under the MIT License. See LICENSE in the Sapling repository root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Port of the `CommitInfo` family in `addons/isl/src/types.ts`, narrowed to the fields this
 * port's wire contract carries. `render.ts` and `renderText.ts` are copied from Sapling and
 * import `Hash` from here, so the names are ISL's rather than ours.
 */

export type Hash = string;

export type CommitPhaseType = 'public' | 'draft';

export interface SuccessorInfo {
	readonly hash: Hash;
	readonly type: string;
}

export interface CommitInfo {
	readonly title: string;
	readonly hash: Hash;
	/**
	 * This matches the "parents" information from source control without the
	 * "null" hash. Most of the time a commit has 1 parent. For merges there
	 * could be 2 or more parents. The initial commit (and initial commits of
	 * other merged-in repos) have no parents.
	 */
	readonly parents: readonly Hash[];
	/**
	 * Grandparents are the closest but indirect ancestors in a set of commits.
	 * In ISL, this is used for connecting nodes whose direct parents are NOT present.
	 * Note that this field will be empty by design when direct parents are already present in
	 * the set.
	 */
	readonly grandparents: readonly Hash[];
	readonly phase: CommitPhaseType;
	/**
	 * Whether this commit is the "." (working directory parent).
	 * It is the parent of "wdir()" or the "You are here" virtual commit.
	 */
	readonly isDot: boolean;
	readonly author: string;
	readonly date: Date;
	readonly description: string;
	readonly bookmarks: readonly string[];
	readonly remoteBookmarks: readonly string[];
	/**
	 * The first `MAX_FETCHED_FILES_PER_COMMIT` paths the commit changed, and empty for a public
	 * commit — the main fetch skips the field there. Paths only, with no statuses, which is why
	 * the commit-info view fetches the list again for the commit it is showing.
	 */
	readonly filePathsSample: readonly string[];
	/** How many files the commit changed, counted even where the sample is skipped. */
	readonly totalFileCount: number;
	/** If this commit is obsolete, it is succeeded by another commit. */
	readonly successorInfo?: SuccessorInfo;
	/**
	 * Closest predecessors (not all recursive predecessors, which can be a long
	 * chain and hurt performance).
	 */
	readonly closestPredecessors: readonly Hash[];
	/**
	 * Set on the virtual commit that stands for the working copy — `isYouAreHere` on ISL's
	 * `DagCommitInfo`, which this port has no equivalent of, so the flag lives here instead.
	 * It never comes off the wire: `renderToRows` is what adds the commit carrying it.
	 */
	readonly isYouAreHere?: boolean;
}

/**
 * Port of `ChangedFileType`, restricted to the three states a *committed* file can be in.
 * Upstream's union also carries the working-copy states, which only `sl status` produces and
 * nothing here reads.
 */
export type ChangedFileType = 'A' | 'M' | 'R';

/** Port of `ChangedFile`, without the `copy` field `sl status` is what fills. */
export interface ChangedFile {
	/** Repository-relative, as `sl` prints it. */
	readonly path: string;
	readonly status: ChangedFileType;
}
