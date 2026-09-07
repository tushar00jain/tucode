import { Disposable } from '../vs/base/common/lifecycle.js';
import { Schemas } from '../vs/base/common/network.js';
import { basename, dirname, joinPath } from '../vs/base/common/resources.js';
import { URI, UriComponents } from '../vs/base/common/uri.js';
import { invoke } from './nativeTransport.js';
import { IOpenDialogOptions, ISaveDialogOptions } from '../vs/platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../vs/platform/ipc/common/mainProcessService.js';
import { FILE_CHANNEL_NAME } from '../vs/workbench/services/files/tauri/tauriFileSystemProvider.js';
import { ISimpleFileDialog, ProjectedFileDialogService } from '../workbench/fileDialogService.js';

/** Native panels replace only the picker. Defaults, save and editor opening stay upstream. */
class MacFileDialog extends Disposable implements ISimpleFileDialog {
	constructor(@IMainProcessService private readonly mainProcess: IMainProcessService) { super(); }

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		return this.pick('open', options, options.openLabel);
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		return (await this.pick('save', options, options.saveLabel))?.[0];
	}

	private async pick(kind: 'open' | 'save', options: IOpenDialogOptions | ISaveDialogOptions,
		label: IOpenDialogOptions['openLabel']): Promise<URI[] | undefined> {
		if (options.availableFileSystems?.length && !options.availableFileSystems.includes(Schemas.file)) {
			throw new Error('Mac file dialogs support local files only');
		}
		const selections = await invoke<{ path: string; directory: boolean }[] | null>('mac_show_file_dialog', {
			...options, kind,
			defaultPath: options.defaultUri?.scheme === Schemas.file ? options.defaultUri.fsPath : undefined,
			label: typeof label === 'string' ? label : label?.withoutMnemonic
		});
		if (!selections?.length) { return undefined; }
		return Promise.all(selections.map(async ({ path, directory }) => {
			const uri = URI.file(path);
			// A selected file needs its parent authorized for atomic-save temporary siblings too.
			// A directory only needs itself authorized for upstream's file-or-folder stat.
			const root = URI.revive(await this.mainProcess.getChannel(FILE_CHANNEL_NAME)
				.call<UriComponents>('registerWorkspaceRoot', directory ? uri : dirname(uri)));
			return directory ? root : joinPath(root, basename(uri));
		}));
	}
}

export class MacFileDialogService extends ProjectedFileDialogService {
	protected override getSimpleFileDialog(): ISimpleFileDialog {
		return this.instantiationService.createInstance(MacFileDialog);
	}
}
