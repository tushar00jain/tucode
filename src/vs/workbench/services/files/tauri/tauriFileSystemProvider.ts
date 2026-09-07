/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isLinux } from '../../../../base/common/platform.js';
import { ReadableStreamEvents } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { DiskFileSystemProviderClient } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import { FileSystemProviderCapabilities, IFileReadStreamOptions } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

/**
 * The name `channels/file.rs` is registered under.
 */
export const FILE_CHANNEL_NAME = 'file';

/**
 * A disk file system provider that delegates all calls to the Rust process via
 * the `file` channel. The stock `DiskFileSystemProviderClient` is transport
 * agnostic and does all the work; this only narrows the capabilities it
 * advertises to the ones the Rust side actually implements.
 */
export class TauriFileSystemProvider extends DiskFileSystemProviderClient {

	constructor(mainProcessService: IMainProcessService) {
		super(mainProcessService.getChannel(FILE_CHANNEL_NAME), { pathCaseSensitive: isLinux, trash: false });
	}

	// `readFileStream` is not implemented by the Rust side, so the capability
	// must not be advertised or the file service will take that path.
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities & ~FileSystemProviderCapabilities.FileReadStream;
	}

	override readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		throw new Error('Method not implemented.');
	}
}
