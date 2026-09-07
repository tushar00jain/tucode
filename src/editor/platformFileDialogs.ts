import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { IFileDialogService } from '../vs/platform/dialogs/common/dialogs.js';
import { SaveConfirmDialog } from '../vs/workbench/services/dialogs/browser/saveConfirmDialog.js';

/** The platform has a confirmation surface but no file-picker surface. */
export function platformFileDialogs(instantiationService: IInstantiationService): IFileDialogService {
	const confirm = instantiationService.createInstance(SaveConfirmDialog);
	const service: Partial<IFileDialogService> = { showSaveConfirm: files => confirm.showSaveConfirm(files) };
	return new Proxy(service as IFileDialogService, {
		get(target, property) {
			if (property in target) { return target[property as keyof IFileDialogService]; }
			throw new Error(`IFileDialogService.${String(property)} is unavailable: this frontend has no file-picker surface`);
		}
	});
}
