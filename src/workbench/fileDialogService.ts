import { URI } from '../vs/base/common/uri.js';
import { IOpenDialogOptions, IPickAndOpenOptions, ISaveDialogOptions } from '../vs/platform/dialogs/common/dialogs.js';
import { AbstractFileDialogService } from '../vs/workbench/services/dialogs/browser/abstractFileDialogService.js';
import { ISimpleFileDialog } from '../vs/workbench/services/dialogs/browser/simpleFileDialog.js';

/** Shared owner of workbench file-dialog command/default-path semantics. */
export abstract class ProjectedFileDialogService extends AbstractFileDialogService {
	protected abstract override getSimpleFileDialog(): ISimpleFileDialog;

	async pickFileFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);
		if (!options.defaultUri) { options.defaultUri = await this.defaultFilePath(schema); }
		return super.pickFileFolderAndOpenSimplified(schema, options, false);
	}

	async pickFileAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);
		if (!options.defaultUri) { options.defaultUri = await this.defaultFilePath(schema); }
		return super.pickFileAndOpenSimplified(schema, options, false);
	}

	async pickFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		const schema = this.getFileSystemSchema(options);
		if (!options.defaultUri) { options.defaultUri = await this.defaultFolderPath(schema); }
		return super.pickFolderAndOpenSimplified(schema, options);
	}

	async pickWorkspaceAndOpen(options: IPickAndOpenOptions): Promise<void> {
		options.availableFileSystems = this.getWorkspaceAvailableFileSystems(options);
		const schema = this.getFileSystemSchema(options);
		if (!options.defaultUri) { options.defaultUri = await this.defaultWorkspacePath(schema); }
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

export type { ISimpleFileDialog };
