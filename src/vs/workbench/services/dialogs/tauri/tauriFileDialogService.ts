/*---------------------------------------------------------------------------------------------
 *  The file dialog service for tscode.
 *
 *  Upstream has two: the browser one, which drives the File System Access API and refuses to
 *  open folders at all, and the electron one, which routes every pick through
 *  `INativeHostService`. tscode has a native picker but no native host, so it takes the seam
 *  the abstract service already has — `getSimpleFileDialog()` — and puts the Tauri dialog
 *  plugin behind it. Everything that happens *after* a pick (stat, recently-opened, the
 *  `openWindow` / `openEditors` split) stays upstream's `…Simplified` code, unmodified.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { FileFilter, IFileDialogService, IOpenDialogOptions, IPickAndOpenOptions, ISaveDialogOptions } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractFileDialogService } from '../browser/abstractFileDialogService.js';
import { ISimpleFileDialog } from '../browser/simpleFileDialog.js';

class TauriFileDialog extends Disposable implements ISimpleFileDialog {

	constructor(
		@IFileService private readonly fileService: IFileService
	) {
		super();
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		const { open } = await import('@tauri-apps/plugin-dialog');

		const selected: string | string[] | null = await open({
			title: options.title,
			defaultPath: await this.defaultPath(options.defaultUri),
			filters: this.toDialogFilters(options.filters),
			directory: !options.canSelectFiles && !!options.canSelectFolders,
			multiple: !!options.canSelectMany
		});

		if (!selected) {
			return undefined; // the picker resolves `null` when the user cancels
		}

		return (Array.isArray(selected) ? selected : [selected]).map(path => URI.file(path));
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		const { save } = await import('@tauri-apps/plugin-dialog');

		const selected = await save({
			title: options.title,
			defaultPath: await this.defaultPath(options.defaultUri),
			filters: this.toDialogFilters(options.filters)
		});

		return selected ? URI.file(selected) : undefined;
	}

	/**
	 * The workbench falls back to `file:///` when it has no history to derive a starting
	 * folder from, which the picker would open on the filesystem root. Hand it nothing
	 * instead and let the platform pick its own default.
	 */
	private async defaultPath(defaultUri: URI | undefined): Promise<string | undefined> {
		if (defaultUri?.scheme !== Schemas.file) {
			return undefined;
		}

		return await this.fileService.exists(defaultUri) ? defaultUri.fsPath : undefined;
	}

	private toDialogFilters(filters: readonly FileFilter[] | undefined): { name: string; extensions: string[] }[] | undefined {
		const dialogFilters = (filters ?? [])
			.map(filter => ({ name: filter.name, extensions: filter.extensions.filter(extension => extension !== '*' && extension !== '') }))
			.filter(filter => filter.extensions.length > 0);

		return dialogFilters.length ? dialogFilters : undefined;
	}
}

export class TauriFileDialogService extends AbstractFileDialogService implements IFileDialogService {

	protected override getSimpleFileDialog(): ISimpleFileDialog {
		return this.instantiationService.createInstance(TauriFileDialog);
	}

	async pickFileFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFilePath(schema);
		}

		return super.pickFileFolderAndOpenSimplified(schema, options, false);
	}

	async pickFileAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFilePath(schema);
		}

		return super.pickFileAndOpenSimplified(schema, options, false);
	}

	async pickFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFolderPath(schema);
		}

		return super.pickFolderAndOpenSimplified(schema, options);
	}

	async pickWorkspaceAndOpen(options: IPickAndOpenOptions): Promise<void> {
		options.availableFileSystems = this.getWorkspaceAvailableFileSystems(options);
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultWorkspacePath(schema);
		}

		return super.pickWorkspaceAndOpenSimplified(schema, options);
	}

	async pickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined> {
		const schema = this.getFileSystemSchema({ defaultUri, availableFileSystems });

		return super.pickFileToSaveSimplified(schema, this.getPickFileToSaveDialogOptions(defaultUri, availableFileSystems));
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		return super.showSaveDialogSimplified(this.getFileSystemSchema(options), options);
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		return super.showOpenDialogSimplified(this.getFileSystemSchema(options), options);
	}
}

registerSingleton(IFileDialogService, TauriFileDialogService, InstantiationType.Delayed);
