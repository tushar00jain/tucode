/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CommitInfo } from '../common/types.js';

/**
 * Which commit the Sapling views are pointed at, shared by the two of them.
 *
 * ISL keeps this in a jotai atom (`selectedCommits` in `selection.ts`, read through
 * `commitInfoViewCurrentCommits`) that both the smartlog and the commit-info drawer subscribe to.
 * The two halves are separate view panes here rather than two components of one tree, so the
 * shared atom becomes a workbench service — the same relationship, spelled the way the workbench
 * spells it.
 *
 * **The selection is a single commit.** Upstream's is a set, because a multi-selection drives bulk
 * operations — submit a stack, copy N hashes, fold — and this port has no mutations to drive. What
 * upstream does with an *empty* selection is reproduced exactly: it falls back to ".", so the
 * commit-info view opens on the working directory parent rather than on nothing
 * (`commitInfoViewCurrentCommits`, `CommitInfoState.tsx`).
 */
export interface ISaplingSelection {
	/** The repository the commit belongs to — what a per-commit read has to be run in. */
	readonly root: string;
	readonly commit: CommitInfo;
	/** False when the commit is the fallback to "." rather than something the user clicked. */
	readonly explicit: boolean;
}

export const ISaplingSelectionService = createDecorator<ISaplingSelectionService>('saplingSelectionService');

export interface ISaplingSelectionService {

	readonly _serviceBrand: undefined;

	/** The commit the commit-info view draws, or nothing while no repository has loaded. */
	readonly selection: ISaplingSelection | undefined;

	readonly onDidChangeSelection: Event<void>;

	/**
	 * Point the views at a commit the user picked. Clicking the selected commit again clears the
	 * selection back to ".", which is what upstream's `onClickToSelect` does with a plain click.
	 */
	select(selection: ISaplingSelection | undefined): void;

	/**
	 * Reconcile the selection with a smartlog that has just been refetched: the same commit if it
	 * is still there, otherwise "." — a rebase or an amend replaces a hash rather than moving it,
	 * so a selection that survived only by hash would be pointing at a commit nobody can see.
	 */
	reconcile(root: string, commits: readonly CommitInfo[]): void;
}

export class SaplingSelectionService extends Disposable implements ISaplingSelectionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<void>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private _selection: ISaplingSelection | undefined;

	get selection(): ISaplingSelection | undefined {
		return this._selection;
	}

	select(selection: ISaplingSelection | undefined): void {
		this.set(selection);
	}

	reconcile(root: string, commits: readonly CommitInfo[]): void {
		const previous = this._selection;
		const kept = previous?.explicit && previous.root === root
			? commits.find(commit => commit.hash === previous.commit.hash)
			: undefined;

		if (kept) {
			// The same commit, but the object off a newer fetch — a bookmark can have moved onto
			// it, and the view below is reading these fields.
			this.set({ root, commit: kept, explicit: true });
			return;
		}

		const dot = commits.find(commit => commit.isDot);
		this.set(dot ? { root, commit: dot, explicit: false } : undefined);
	}

	private set(selection: ISaplingSelection | undefined): void {
		if (selection?.root === this._selection?.root && selection?.commit === this._selection?.commit) {
			return;
		}

		this._selection = selection;
		this._onDidChangeSelection.fire();
	}
}

registerSingleton(ISaplingSelectionService, SaplingSelectionService, InstantiationType.Delayed);
