/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { canceled } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI as uri } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { FileMatch, IFileMatch, IFileQuery, IProgressMessage, IRawSearchService, ISearchComplete, ISearchProgressItem, ISearchResultProvider, isProgressMessage, isSerializedSearchComplete, isSerializedSearchSuccess, ISerializedFileMatch, ISerializedSearchComplete, ISerializedSearchProgressItem, ITextQuery, SearchProviderType } from '../common/search.js';
import { SearchService } from '../common/searchService.js';
import { ChannelTextSearchProvider } from './channelTextSearchProvider.js';
import { SearchService as RawSearchService } from './rawSearchService.js';
import { SearchChannelClient } from './searchIpc.js';

/**
 * The name `channels/search.rs` is registered under.
 */
const SEARCH_CHANNEL_NAME = 'search';

export class TauriSearchService extends SearchService {

	constructor(
		@IModelService modelService: IModelService,
		@IEditorService editorService: IEditorService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILogService logService: ILogService,
		@IExtensionService extensionService: IExtensionService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super(modelService, editorService, telemetryService, logService, extensionService, fileService, uriIdentityService);

		const diskSearch = new DiskSearch(mainProcessService.getChannel(SEARCH_CHANNEL_NAME), fileService, logService);
		this._register(this.registerSearchResultProvider(Schemas.file, SearchProviderType.file, diskSearch));
		this._register(this.registerSearchResultProvider(Schemas.file, SearchProviderType.text, diskSearch));
	}
}

class DiskSearch implements ISearchResultProvider {

	private readonly raw: IRawSearchService;

	constructor(channel: IChannel, fileService: IFileService, private readonly logService: ILogService) {
		// Stock runs `rawSearchService` behind the IPC channel, in the process that
		// owns the engines. Ours owns no engine — `tscode_search` does — so the
		// ranking and caching layer sits on this side of the channel instead, and
		// each of stock's two engine boundaries is crossed by the channel: the
		// file walker as an `ISearchEngine`, text search as a `TextSearchProvider2`.
		this.raw = new RawSearchService(new SearchChannelClient(channel), new ChannelTextSearchProvider(channel), fileService);
	}

	textSearch(query: ITextQuery, onProgress?: (p: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
		if (token && token.isCancellationRequested) {
			throw canceled();
		}

		const event: Event<ISerializedSearchProgressItem | ISerializedSearchComplete> = this.raw.textSearch(query);

		return collectResultsFromEvent(event, onProgress, token);
	}

	fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
		if (token && token.isCancellationRequested) {
			throw canceled();
		}

		const event = this.raw.fileSearch(query);

		const onProgress = (p: ISearchProgressItem) => {
			if (isProgressMessage(p)) {
				// Should only be for logs
				this.logService.debug('SearchService#search', p.message);
			}
		};

		return collectResultsFromEvent(event, onProgress, token);
	}

	getAIName(): Promise<string | undefined> {
		return Promise.resolve(undefined); // no AI search without an extension host
	}

	clearCache(cacheKey: string): Promise<void> {
		return this.raw.clearCache(cacheKey);
	}
}

function collectResultsFromEvent(event: Event<ISerializedSearchProgressItem | ISerializedSearchComplete>, onProgress?: (p: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
	let result: IFileMatch[] = [];

	let listener: IDisposable;
	return new Promise<ISearchComplete>((c, e) => {
		if (token) {
			token.onCancellationRequested(() => {
				if (listener) {
					listener.dispose();
				}

				e(canceled());
			});
		}

		listener = event(ev => {
			if (isSerializedSearchComplete(ev)) {
				if (isSerializedSearchSuccess(ev)) {
					c({
						limitHit: ev.limitHit,
						results: result,
						stats: ev.stats,
						messages: ev.messages,
					});
				} else {
					e(ev.error);
				}

				listener.dispose();
			} else {
				// Matches
				if (Array.isArray(ev)) {
					const fileMatches = ev.map(d => createFileMatch(d));
					result = result.concat(fileMatches);
					if (onProgress) {
						fileMatches.forEach(onProgress);
					}
				}

				// Match
				else if ((<ISerializedFileMatch>ev).path) {
					const fileMatch = createFileMatch(<ISerializedFileMatch>ev);
					result.push(fileMatch);

					if (onProgress) {
						onProgress(fileMatch);
					}
				}

				// Progress
				else if (onProgress) {
					onProgress(<IProgressMessage>ev);
				}
			}
		});
	});
}

function createFileMatch(data: ISerializedFileMatch): FileMatch {
	const fileMatch = new FileMatch(uri.file(data.path));
	if (data.results) {
		fileMatch.results.push(...data.results);
	}
	return fileMatch;
}
