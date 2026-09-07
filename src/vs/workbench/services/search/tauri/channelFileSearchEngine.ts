/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualOrParent } from '../../../../base/common/extpath.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { relative } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { deserializeSearchError, IFileQuery, IProgressMessage, IRawFileMatch, ISearchEngine, ISearchEngineStats, ISearchEngineSuccess, ISerializedFileMatch, ISerializedSearchSuccess, isSerializedSearchComplete, isSerializedSearchSuccess } from '../common/search.js';
import { IFileSearchChannel } from './searchIpc.js';

const NO_STATS: ISearchEngineStats = { fileWalkTime: 0, directoriesWalked: 0, filesWalked: 0, cmdTime: 0 };

/**
 * The channel stands exactly where stock puts the `ISearchEngine` boundary, so
 * it reports the walk's own `ISearchEngineStats` — not the `IFileSearchStats`
 * that `rawSearchService` wraps them in one layer up, which is what
 * `ISerializedSearchSuccess` declares. Recognised by shape rather than asserted,
 * so a backend that stopped sending them degrades to zeroes instead of lying.
 */
function engineStats(stats: ISerializedSearchSuccess['stats']): ISearchEngineStats {
	const candidate = <Partial<ISearchEngineStats> | undefined>stats;

	return typeof candidate?.fileWalkTime === 'number' ? <ISearchEngineStats>candidate : NO_STATS;
}

/**
 * `rawSearchService`'s file engine, backed by the `search` channel.
 *
 * Stock's `ISearchEngine` is an in-process, callback-driven walker
 * (`node/fileSearch.ts`); ours is `tscode_search`, a process away. That is the
 * only seam the copy of `rawSearchService` needed replacing at — everything
 * above it, the ranking and the cache, is stock's own code.
 *
 * The class comes from a factory because `doFileSearchWithEngine` takes an
 * engine *class* and constructs it per query, so the channel has to be bound
 * before that point rather than passed through it.
 */
export function createChannelFileSearchEngine(raw: IFileSearchChannel): { new(config: IFileQuery): ISearchEngine<IRawFileMatch> } {
	return class ChannelFileSearchEngine implements ISearchEngine<IRawFileMatch> {

		private listener: IDisposable | undefined;

		constructor(private readonly config: IFileQuery) { }

		search(onResult: (match: IRawFileMatch) => void, onProgress: (progress: IProgressMessage) => void, done: (error: Error | null, complete: ISearchEngineSuccess) => void): void {
			this.listener = raw.fileSearch(this.config)(ev => {
				if (isSerializedSearchComplete(ev)) {
					this.cancel();

					if (isSerializedSearchSuccess(ev)) {
						done(null, { limitHit: ev.limitHit, messages: ev.messages, stats: engineStats(ev.stats) });
					} else {
						done(deserializeSearchError(new Error(ev.error.message)), { limitHit: false, messages: [], stats: NO_STATS });
					}
				} else if (Array.isArray(ev)) {
					for (const match of ev) {
						onResult(this.toRawMatch(match));
					}
				} else if ((<ISerializedFileMatch>ev).path) {
					onResult(this.toRawMatch(<ISerializedFileMatch>ev));
				} else {
					onProgress(<IProgressMessage>ev);
				}
			});
		}

		/**
		 * The inverse of `rawSearchService.rawMatchToSearchItem`. Stock puts its
		 * process boundary in the same place, and `ISerializedFileMatch` — an
		 * absolute path — is the wire type it defines for that boundary;
		 * `IRawFileMatch` is in-process only. So the split back into base plus
		 * relative path happens here, on the reader's side.
		 */
		private toRawMatch(match: ISerializedFileMatch): IRawFileMatch {
			for (const folderQuery of this.config.folderQueries) {
				const base = folderQuery.folder.fsPath;
				if (isEqualOrParent(match.path, base, !isLinux)) {
					return { base, relativePath: relative(base, match.path), searchPath: undefined };
				}
			}

			return { relativePath: match.path, searchPath: undefined };
		}

		cancel(): void {
			this.listener?.dispose();
			this.listener = undefined;
		}
	};
}
