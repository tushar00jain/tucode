/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UriComponents } from '../../../../base/common/uri.js';
import { RepositoryChannelClient } from '../../scm/tauri/repositoryIpc.js';
import { ChangedFile, CommitPhaseType, Hash, SuccessorInfo } from '../common/types.js';

/**
 * The name `channels/sl.rs` is registered under.
 */
export const SL_CHANNEL_NAME = 'sl';

export interface ISlRepositoryInfo {
	readonly root: string;
	/** The repository's `.sl` directory. */
	readonly dotDir: string;
}

/**
 * One commit of a smartlog. The wire spelling of the subset of `CommitInfo` in
 * `addons/isl/src/types.ts` that this slice renders; `saplingDagModel.ts` turns it into the
 * `CommitInfo` the copied renderer consumes.
 */
export interface ISlCommit {
	readonly hash: Hash;
	readonly title: string;
	readonly description: string;
	readonly author: string;
	/** Commit date, seconds since the epoch. */
	readonly date: number;
	readonly phase: CommitPhaseType;
	/** Whether this is the "." commit — the working directory parent. */
	readonly isDot: boolean;
	readonly parents: Hash[];
	/** Closest ancestors present in the smartlog whose direct parents are not. */
	readonly grandparents: Hash[];
	readonly bookmarks: string[];
	readonly remoteBookmarks: string[];
	/** Capped at `MAX_FETCHED_FILES_PER_COMMIT`, and empty for a public commit. Paths only. */
	readonly filePathsSample: string[];
	readonly totalFileCount: number;
	readonly successorInfo?: SuccessorInfo;
	readonly closestPredecessors: Hash[];
}

export interface ISlSmartlog {
	readonly kind: 'ok';
	readonly root: string;
	readonly rootUri: UriComponents;
	readonly epoch: number;
	/** A mutation landed while this snapshot was being computed; poll again. */
	readonly stale: boolean;
	readonly commits: ISlCommit[];
}

export interface ISlSmartlogFailure {
	readonly kind: 'failed';
	readonly root: string;
	readonly message: string;
}

export type ISlSmartlogResult = ISlSmartlog | ISlSmartlogFailure;

/**
 * The `sl` channel's client half. It mirrors `ScmChannelClient` — the command names are the
 * Rust service's own and each takes a single object argument — because Sapling has no
 * extension to inherit a protocol from either. The repository lifecycle the mirroring is
 * exact over is [`RepositoryChannelClient`]'s, which both clients extend.
 */
export class SlChannelClient extends RepositoryChannelClient<ISlRepositoryInfo> {

	/** The smartlog set, in the order `sl` itself renders it — descendants first. */
	smartlog(root: string, limit?: number): Promise<ISlSmartlogResult> {
		return this.channel.call('smartlog', { root, limit });
	}

	/**
	 * Every file one commit changed, with its status — a second `sl log`, as upstream's
	 * `getAllChangedFiles` is. The smartlog's own `filePathsSample` has no statuses, which is
	 * what this is for.
	 */
	changedFiles(root: string, hash: Hash): Promise<ChangedFile[]> {
		return this.channel.call('changedFiles', { root, hash });
	}
}
