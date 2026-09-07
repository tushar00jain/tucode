/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import {
	createFileSystemProviderError, FileChangeType, FilePermission, FileSystemProviderCapabilities,
	FileSystemProviderErrorCode, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions,
	IFileSystemProviderWithFileReadWriteCapability, IFileWriteOptions, IStat, IWatchOptions
} from '../../../../platform/files/common/files.js';
import { fromGitUri } from './gitUri.js';
import { GitResourceGroupType } from './scmIpc.js';
import { ScmChannelClient } from './scmIpc.js';
import { IGitProviderLookup } from './tauriGitProvider.js';

/**
 * Serves the `git:` scheme — the read-only left-hand side of every diff and the quick diff
 * baseline. A port of `GitFileSystemProvider` in `extensions/git/src/fileSystemProvider.ts`:
 * the ref sanitisation and the mtime-bumping change notification are upstream's, the read
 * itself is `GitService::show`.
 */
export class TauriGitFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {

	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly;
	readonly onDidChangeCapabilities: Event<void> = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event;

	/**
	 * Every `git:` URI served, by repository root. A `git:` URI's content changes when the
	 * repository does, and nothing else can tell the file service that — so the ones handed
	 * out are remembered in order to be invalidated.
	 */
	private readonly served = new Map<string, Map<string, URI>>();

	/** One timestamp for every `git:` URI, bumped on each repository change, as upstream's. */
	private mtime = Date.now();

	constructor(
		private readonly client: ScmChannelClient,
		private readonly lookup: IGitProviderLookup
	) {
		super();
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		// The size is not known without reading the blob, and the file service re-checks the
		// real byte length against any size limit after the read anyway.
		return { type: FileType.File, ctime: 0, mtime: this.mtime, size: 0, permissions: FilePermission.Readonly };
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const { path, ref } = fromGitUri(resource);
		const fileUri = URI.file(path);

		const provider = this.lookup(fileUri);
		if (!provider) {
			throw createFileSystemProviderError(`No repository for ${path}`, FileSystemProviderErrorCode.FileNotFound);
		}

		const root = provider.rootUri.fsPath;
		this.remember(root, resource);

		const buffer = await this.client.show(root, this.sanitizeRef(ref, fileUri), path);
		return buffer.buffer;
	}

	/**
	 * Port of `sanitizeRef` in `extensions/git/src/fileSystemProvider.ts`. `~` means "the
	 * staged version if there is one, else HEAD", and `~1`/`~2`/`~3` are the merge stages,
	 * which `git show` spells `:1`/`:2`/`:3`.
	 */
	private sanitizeRef(ref: string, fileUri: URI): string {
		if (ref === '~') {
			const resource = this.lookup(fileUri)?.getResource(fileUri);
			return resource?.resourceGroup.id === GitResourceGroupType.Index ? '' : 'HEAD';
		}

		if (/^~\d$/.test(ref)) {
			return `:${ref[1]}`;
		}

		return ref;
	}

	private remember(root: string, resource: URI): void {
		let uris = this.served.get(root);
		if (!uris) {
			uris = new Map();
			this.served.set(root, uris);
		}
		uris.set(resource.toString(), resource);
	}

	/**
	 * A mutation or a working-tree edit landed in `root`: every `git:` URI served from it may
	 * now read differently, so the file service is told they changed and the timestamp that
	 * backs their etag moves with them.
	 */
	notifyRepositoryChanged(root: string): void {
		const uris = this.served.get(root);
		if (!uris?.size) {
			return;
		}

		this.mtime = Date.now();
		this._onDidChangeFile.fire([...uris.values()].map(resource => ({ resource, type: FileChangeType.UPDATED })));
	}

	forgetRepository(root: string): void {
		this.served.delete(root);
	}

	async readdir(_resource: URI): Promise<[string, FileType][]> {
		throw createFileSystemProviderError('git is a file-only scheme', FileSystemProviderErrorCode.FileNotADirectory);
	}

	async mkdir(_resource: URI): Promise<void> {
		throw createFileSystemProviderError('git is read-only', FileSystemProviderErrorCode.NoPermissions);
	}

	async delete(_resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		throw createFileSystemProviderError('git is read-only', FileSystemProviderErrorCode.NoPermissions);
	}

	async rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		throw createFileSystemProviderError('git is read-only', FileSystemProviderErrorCode.NoPermissions);
	}

	async writeFile(_resource: URI, _content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		throw createFileSystemProviderError('git is read-only', FileSystemProviderErrorCode.NoPermissions);
	}
}
