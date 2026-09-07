/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IProgress } from '../../../../platform/progress/common/progress.js';
import { deserializeSearchError, ISearchRange, ISerializedFileMatch, ISerializedSearchComplete, ISerializedSearchProgressItem, isSerializedSearchComplete, isSerializedSearchSuccess, resultIsMatch } from '../common/search.js';
import { Range, TextSearchComplete2, TextSearchContext2, TextSearchMatch2, TextSearchProvider2, TextSearchProviderOptions, TextSearchQuery2, TextSearchResult2 } from '../common/searchExtTypes.js';

/**
 * `tscode_search` standing where upstream's `RipgrepTextSearchEngine` stands:
 * the `TextSearchProvider2` that `TextSearchManager` drives.
 *
 * That is where stock's own process boundary already is — a `node/` engine
 * spawning `rg` and parsing its `--json` stream — so it is where ours is too.
 * Everything above it is stock's `common/textSearchManager.ts`: the
 * `QueryGlobTester` that re-applies the sibling `when` clauses a glob list
 * cannot express, the `maxResults` trimming, the batching and the stats.
 *
 * Rust answers in the shape `common/search.ts` already defines for a batch of
 * matched files (`ISerializedFileMatch`), and this turns each one into the
 * `TextSearchResult2` the provider contract is written in.
 */
export class ChannelTextSearchProvider implements TextSearchProvider2 {

	constructor(private readonly channel: IChannel) { }

	provideTextSearchResults(query: TextSearchQuery2, options: TextSearchProviderOptions, progress: IProgress<TextSearchResult2>, token: CancellationToken): Promise<TextSearchComplete2> {
		if (!query.pattern) {
			return Promise.resolve({ limitHit: false });
		}

		return new Promise<TextSearchComplete2>((resolve, reject) => {
			let listener: IDisposable | undefined;
			const dispose = () => {
				listener?.dispose();
				listener = undefined;
			};

			const event: Event<ISerializedSearchProgressItem | ISerializedSearchComplete> =
				this.channel.listen('textSearch', { query, options: toWireOptions(options) });

			listener = event(ev => {
				if (isSerializedSearchComplete(ev)) {
					dispose();
					if (isSerializedSearchSuccess(ev)) {
						resolve({ limitHit: ev.limitHit });
					} else {
						reject(deserializeSearchError(new Error(ev.error.message)));
					}
				} else if (Array.isArray(ev)) {
					for (const match of ev) {
						reportFileMatch(match, progress);
					}
				} else if ((<ISerializedFileMatch>ev).path) {
					reportFileMatch(<ISerializedFileMatch>ev, progress);
				}
			});

			// Disposing the subscription is what cancels the walk in Rust. The
			// manager cancels as soon as it has enough results and then awaits
			// this promise, so a cancelled search still has to settle.
			token.onCancellationRequested(() => {
				dispose();
				resolve({ limitHit: false });
			});
		});
	}
}

/**
 * A folder crosses as the path the backend addresses rather than the renderer's
 * `URI`; everything else is `TextSearchProviderOptions` verbatim — including the
 * `RelativePattern` form of an exclude, whose base URI stock's own `getRgArgs`
 * drops as well.
 */
function toWireOptions(options: TextSearchProviderOptions) {
	return {
		...options,
		folderOptions: options.folderOptions.map(folderOptions => ({
			...folderOptions,
			folder: folderOptions.folder.fsPath
		}))
	};
}

function reportFileMatch(match: ISerializedFileMatch, progress: IProgress<TextSearchResult2>): void {
	const uri = URI.file(match.path);

	for (const result of match.results ?? []) {
		progress.report(resultIsMatch(result) ?
			new TextSearchMatch2(
				uri,
				result.rangeLocations.map(location => ({
					sourceRange: searchRangeToRange(location.source),
					previewRange: searchRangeToRange(location.preview)
				})),
				result.previewText) :
			new TextSearchContext2(uri, result.text, result.lineNumber));
	}
}

/** Copy of `searchRangeToRange` in upstream's `node/ripgrepSearchUtils.ts`. */
function searchRangeToRange(range: ISearchRange): Range {
	return new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
}
