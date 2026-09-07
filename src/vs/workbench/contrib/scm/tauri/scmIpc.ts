/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { UriComponents } from '../../../../base/common/uri.js';
import { RepositoryChannelClient } from './repositoryIpc.js';

/**
 * The name `channels/scm.rs` is registered under.
 */
export const SCM_CHANNEL_NAME = 'scm';

/**
 * Per-file change kind. These are the wire spellings of `tscode_git`'s `Status`, which is
 * itself a port of `Status` in `extensions/git/src/api/git.d.ts` — so the nineteen names
 * below are upstream's, not ours.
 */
export const enum GitStatus {
	IndexModified = 'INDEX_MODIFIED',
	IndexAdded = 'INDEX_ADDED',
	IndexDeleted = 'INDEX_DELETED',
	IndexRenamed = 'INDEX_RENAMED',
	IndexCopied = 'INDEX_COPIED',

	Modified = 'MODIFIED',
	Deleted = 'DELETED',
	Untracked = 'UNTRACKED',
	Ignored = 'IGNORED',
	IntentToAdd = 'INTENT_TO_ADD',
	IntentToRename = 'INTENT_TO_RENAME',
	TypeChanged = 'TYPE_CHANGED',

	AddedByUs = 'ADDED_BY_US',
	AddedByThem = 'ADDED_BY_THEM',
	DeletedByUs = 'DELETED_BY_US',
	DeletedByThem = 'DELETED_BY_THEM',
	BothAdded = 'BOTH_ADDED',
	BothDeleted = 'BOTH_DELETED',
	BothModified = 'BOTH_MODIFIED'
}

/**
 * Which resource group a change belongs to. The four ids are also the `scmResourceGroup`
 * context key values the menu contributions match on, exactly as in the git extension.
 */
export const enum GitResourceGroupType {
	Merge = 'merge',
	Index = 'index',
	WorkingTree = 'workingTree',
	Untracked = 'untracked'
}

export interface IGitChange {
	/** Repository-relative, forward slashes. */
	readonly path: string;
	/** For renames and copies, the repository-relative path it came from. */
	readonly originalPath?: string;
	readonly status: GitStatus;
	readonly group: GitResourceGroupType;
	/** The status letter, from the crate's port of `Resource.getStatusLetter`. */
	readonly letter: string;
	readonly conflict: boolean;
	/** Absolute `file:` URI of the resource as it exists now. */
	readonly resource: UriComponents;
	/** Absolute `file:` URI of the rename or copy source. */
	readonly originalResource?: UriComponents;
}

export interface IGitHead {
	readonly name?: string;
	readonly commit?: string;
	readonly detached: boolean;
	readonly upstream?: string;
	readonly ahead?: number;
	readonly behind?: number;
}

export interface IGitRepositoryStatus {
	readonly kind: 'ok';
	readonly root: string;
	readonly rootUri: UriComponents;
	readonly head: IGitHead;
	readonly epoch: number;
	/** A mutation landed while this snapshot was being computed; poll again. */
	readonly stale: boolean;
	readonly merge: readonly IGitChange[];
	readonly index: readonly IGitChange[];
	readonly workingTree: readonly IGitChange[];
	readonly untracked: readonly IGitChange[];
}

export interface IGitRepositoryFailure {
	readonly kind: 'failed';
	readonly root: string;
	readonly message: string;
}

export type IGitRepositoryStatusResult = IGitRepositoryStatus | IGitRepositoryFailure;

export interface IGitRepositoryInfo {
	readonly root: string;
	readonly gitDir: string;
}

/** The `git.untrackedChanges` setting, as `tscode_git` spells it. */
export const enum GitUntrackedChanges {
	Mixed = 'mixed',
	Separate = 'separate',
	Hidden = 'hidden'
}

export interface IGitStatusOptions {
	readonly untrackedChanges?: GitUntrackedChanges;
	readonly showIgnored?: boolean;
	readonly detectRenames?: boolean;
}

export interface IGitCommitOptions {
	/** Stage every tracked modification first (`git commit --all`). */
	readonly all?: boolean;
	readonly amend?: boolean;
	readonly signoff?: boolean;
	/** Allow a commit with no staged changes. */
	readonly empty?: boolean;
	readonly noVerify?: boolean;
}

/**
 * One commit. The wire spelling of `tscode_git`'s `Commit`, itself a port of `Commit` in
 * `extensions/git/src/git.ts`.
 */
export interface IGitCommit {
	readonly hash: string;
	readonly parents: string[];
	readonly authorName: string;
	readonly authorEmail: string;
	/** Author date, seconds since the epoch — git's `%at`. */
	readonly authorDate: number;
	/** The full message, subject line included. */
	readonly message: string;
	/**
	 * The decorating ref names, in `git log --decorate=full`'s `%D` spellings:
	 * `HEAD -> refs/heads/x`, `refs/heads/x`, `refs/remotes/o/x`, `tag: refs/tags/x`.
	 */
	readonly refNames: string[];
}

/** Which namespace a ref lives in. The wire spelling of upstream's `RefType`. */
export const enum GitRefKind {
	Head = 'head',
	RemoteHead = 'remoteHead',
	Tag = 'tag'
}

/**
 * One ref. `name` is the short spelling upstream's `Ref` carries — `main` for a local
 * branch, `origin/main` for a remote one, the tag name for a tag.
 */
export interface IGitRef {
	readonly kind: GitRefKind;
	readonly name: string;
	/** Hex object id of the commit the ref resolves to, tags peeled. */
	readonly commit?: string;
}

/** The wire spelling of `LogOptions` in `extensions/git/src/api/git.d.ts`. */
export interface IGitLogOptions {
	readonly maxEntries?: number;
	readonly skip?: number;
	/** A commit range. The graph's only spelling is `<parent>..`. */
	readonly range?: string;
	/** The tips to walk from; HEAD when absent. */
	readonly refNames?: readonly string[];
	/** git's `--max-parents`: keep commits with at most this many parents. */
	readonly maxParents?: number;
	readonly author?: string;
	readonly grep?: string;
}

/** The wire spelling of `CommitShortStat` in `extensions/git/src/git.ts`. */
export interface IGitCommitStats {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
}

/**
 * The `scm` channel's client half. Unlike the file and search channels this has no stock
 * counterpart to extend — VS Code's git is an extension talking to its own process — so the
 * command names are `GitService`'s own and each takes a single object argument. The
 * repository lifecycle it shares with the `sl` channel is [`RepositoryChannelClient`]'s.
 */
export class ScmChannelClient extends RepositoryChannelClient<IGitRepositoryInfo> {

	status(root: string, options?: IGitStatusOptions): Promise<IGitRepositoryStatus> {
		return this.channel.call('status', { root, options });
	}

	statusAll(options?: IGitStatusOptions): Promise<IGitRepositoryStatusResult[]> {
		return this.channel.call('statusAll', { options });
	}

	show(root: string, rev: string, path: string): Promise<VSBuffer> {
		return this.channel.call('show', { root, rev, path });
	}

	stage(root: string, paths: string[]): Promise<void> {
		return this.channel.call('stage', { root, paths });
	}

	unstage(root: string, paths: string[]): Promise<void> {
		return this.channel.call('unstage', { root, paths });
	}

	/**
	 * `discard` classifies each path by index membership, so a directory would be taken for
	 * an untracked file and deleted wholesale. Pass files only.
	 */
	discard(root: string, paths: string[]): Promise<void> {
		return this.channel.call('discard', { root, paths });
	}

	commit(root: string, message: string, options?: IGitCommitOptions): Promise<void> {
		return this.channel.call('commit', { root, message, options });
	}

	//#region History

	log(root: string, options?: IGitLogOptions): Promise<IGitCommit[]> {
		return this.channel.call('log', { root, options });
	}

	/** `pattern` entries are `for-each-ref` patterns; every ref when omitted. */
	refs(root: string, pattern?: readonly string[]): Promise<IGitRef[]> {
		return this.channel.call('refs', { root, pattern });
	}

	/** The common ancestor of two or more revisions, or `null` when there is none. */
	mergeBase(root: string, revs: readonly string[]): Promise<string | null> {
		return this.channel.call('mergeBase', { root, revs });
	}

	/** Name-status changes between two tree-ish revisions, as `git diff rev1...rev2` has them. */
	diffBetween(root: string, rev1: string, rev2: string): Promise<IGitChange[]> {
		return this.channel.call('diffBetween', { root, rev1, rev2 });
	}

	getCommit(root: string, rev: string): Promise<IGitCommit> {
		return this.channel.call('getCommit', { root, rev });
	}

	/**
	 * The empty-tree hash, which is a root commit's parent. It is a constant of the
	 * repository's object hash, not of git, so it is read rather than spelled out.
	 */
	emptyTree(root: string): Promise<string> {
		return this.channel.call('emptyTree', { root });
	}

	/**
	 * Files changed, insertions and deletions for a set of commits — git's `--shortstat`,
	 * which the crate computes separately because it costs a tree diff per commit. One call
	 * per page, never one per commit.
	 */
	commitStats(root: string, hashes: readonly string[]): Promise<Record<string, IGitCommitStats>> {
		return this.channel.call('commitStats', { root, hashes });
	}

	//#endregion
}
