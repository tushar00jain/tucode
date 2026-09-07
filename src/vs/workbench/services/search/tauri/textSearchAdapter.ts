/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileMatch, ISerializedFileMatch, ISerializedSearchSuccess, ITextQuery, ITextSearchMatch, resultIsMatch } from '../common/search.js';
import { TextSearchProvider2 } from '../common/searchExtTypes.js';
import { TauriTextSearchManager } from './textSearchManager.js';

/**
 * Copy of upstream's `node/textSearchAdapter.ts` with the engine replaced.
 * Upstream builds a `RipgrepTextSearchEngine` over a "pretend output channel";
 * ours is the `search` channel, which has nothing to log, so the `onMessage`
 * callback that channel exists for is not taken.
 */
export class TextSearchEngineAdapter {

	constructor(private query: ITextQuery, private provider: TextSearchProvider2, private fileService: IFileService) { }

	search(token: CancellationToken, onResult: (matches: ISerializedFileMatch[]) => void): Promise<ISerializedSearchSuccess> {
		if ((!this.query.folderQueries || !this.query.folderQueries.length) && (!this.query.extraFileResources || !this.query.extraFileResources.length)) {
			return Promise.resolve({
				type: 'success',
				limitHit: false,
				stats: {
					type: 'searchProcess'
				},
				messages: []
			});
		}

		const textSearchManager = new TauriTextSearchManager(this.query, this.provider, this.fileService);
		return new Promise((resolve, reject) => {
			return textSearchManager
				.search(
					matches => {
						onResult(matches.map(fileMatchToSerialized));
					},
					token)
				.then(
					c => resolve({ limitHit: c.limitHit ?? false, type: 'success', stats: c.stats, messages: [] }),
					reject);
		});
	}
}

function fileMatchToSerialized(match: IFileMatch): ISerializedFileMatch {
	return {
		path: match.resource && match.resource.fsPath,
		results: match.results,
		numMatches: (match.results || []).reduce((sum, r) => {
			if (resultIsMatch(r)) {
				const m = <ITextSearchMatch>r;
				return sum + m.rangeLocations.length;
			} else {
				return sum + 1;
			}
		}, 0)
	};
}
