/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDecorationData, IDecorationsProvider } from '../../../services/decorations/common/decorations.js';
import { getStatusColor, getStatusText, isStrikeThrough, propagatesToParents } from './gitStatus.js';
import { GitStatus } from './scmIpc.js';
import { IHistoryItemDecorationSink } from './tauriGitHistoryProvider.js';
import { TauriGitSCMProvider } from './tauriGitProvider.js';

/**
 * The explorer's git badges and colours for one repository. A port of
 * `GitDecorationProvider` in `extensions/git/src/decorationProvider.ts`: the decoration is
 * built from `Resource.resourceDecoration`, and the three paths a resource is filed under
 * (its pre-rename path, a deleted file's right-hand URI, a rename's new path) are upstream's
 * `collectDecorationData`.
 *
 * It also serves the graph view's per-change decorations. Upstream keeps those in a second
 * provider — `GitHistoryProvider` is itself a `FileDecorationProvider` — but they are the
 * same status→badge table over disjoint URIs (a history item change carries a `ref=` query),
 * so they go through this one rather than a second registration.
 */
export class TauriGitDecorationProvider implements IDecorationsProvider, IHistoryItemDecorationSink {

	readonly label = localize('git.decorations', "Git");

	private readonly _onDidChange = new Emitter<readonly URI[]>();
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	private decorations = new Map<string, IDecorationData>();

	/**
	 * Upstream's `historyItemDecorations`, kept apart from the status ones because a status
	 * refresh replaces its whole map and a commit's changes never go stale — the URI names
	 * the commit it belongs to.
	 */
	private readonly historyItemDecorations = new Map<string, IDecorationData>();

	constructor(private readonly provider: TauriGitSCMProvider) { }

	/** Called after every status snapshot is applied to the provider. */
	update(): void {
		const decorations = new Map<string, IDecorationData>();

		for (const resource of this.provider.resources) {
			const decoration = this.toDecoration(resource.status, resource.letter);

			decorations.set(resource.originalUri.toString(), decoration);

			if (resource.status === GitStatus.Deleted && resource.rightUri) {
				decorations.set(resource.rightUri.toString(), decoration);
			}

			if (resource.status === GitStatus.IndexRenamed || resource.status === GitStatus.IntentToRename) {
				decorations.set(resource.sourceUri.toString(), decoration);
			}
		}

		// Everything that had a decoration and everything that has one now: a path that just
		// stopped being modified needs its badge cleared as much as a new one needs painting.
		const changed = new Set([...this.decorations.keys(), ...decorations.keys()]);
		this.decorations = decorations;
		this._onDidChange.fire([...changed].map(uri => URI.parse(uri)));
	}

	/** Port of `GitHistoryProvider.provideHistoryItemChanges`'s decoration half. */
	addHistoryItemChanges(changes: readonly { uri: URI; status: GitStatus; letter: string }[]): void {
		for (const change of changes) {
			this.historyItemDecorations.set(change.uri.toString(), this.toDecoration(change.status, change.letter));
		}

		this._onDidChange.fire(changes.map(change => change.uri));
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		return this.decorations.get(uri.toString()) ?? this.historyItemDecorations.get(uri.toString());
	}

	private toDecoration(status: GitStatus, letter: string): IDecorationData {
		return {
			letter,
			color: getStatusColor(status),
			tooltip: getStatusText(status),
			strikethrough: isStrikeThrough(status),
			bubble: propagatesToParents(status)
		};
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
