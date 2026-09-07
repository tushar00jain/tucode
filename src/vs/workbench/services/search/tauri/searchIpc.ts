/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IRawFileQuery, IRawSearchService, ISerializedSearchComplete, ISerializedSearchProgressItem } from '../common/search.js';

/**
 * The half of stock's `IRawSearchService` that still crosses as a raw query.
 * Text search crosses one layer lower, as a `TextSearchProvider2` — that is
 * where stock's own engine boundary is — so it has no method here.
 */
export type IFileSearchChannel = Pick<IRawSearchService, 'fileSearch' | 'clearCache'>;

export class SearchChannelClient implements IFileSearchChannel {

	constructor(private channel: IChannel) { }

	fileSearch(search: IRawFileQuery): Event<ISerializedSearchProgressItem | ISerializedSearchComplete> {
		return this.channel.listen('fileSearch', search);
	}

	clearCache(cacheKey: string): Promise<void> {
		return this.channel.call('clearCache', cacheKey);
	}
}
