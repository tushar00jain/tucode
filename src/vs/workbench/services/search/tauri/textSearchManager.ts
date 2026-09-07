/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { toCanonicalName } from '../../textfile/common/encoding.js';
import { ITextQuery, ITextSearchStats } from '../common/search.js';
import { TextSearchProvider2 } from '../common/searchExtTypes.js';
import { TextSearchManager } from '../common/textSearchManager.js';

/**
 * The two functions `TextSearchManager`'s `IFileUtils` seam exists for, supplied
 * for this port. Upstream's `node/textSearchManager.ts` is the same twenty lines
 * with `pfs.Promises.readdir` where this has the file channel.
 */
export class TauriTextSearchManager extends TextSearchManager {

	constructor(query: ITextQuery, provider: TextSearchProvider2, fileService: IFileService, processType: ITextSearchStats['type'] = 'searchProcess') {
		super({ query, provider }, {
			readdir: (resource: URI) => readdir(fileService, resource),
			toCanonicalName: name => toCanonicalName(name)
		}, processType);
	}
}

async function readdir(fileService: IFileService, resource: URI): Promise<string[]> {
	const stat = await fileService.resolve(resource);
	return stat.children?.map(child => child.name) ?? [];
}
