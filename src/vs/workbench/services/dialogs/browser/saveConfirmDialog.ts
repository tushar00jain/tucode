/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import * as resources from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import Severity from '../../../../base/common/severity.js';
import { IDialogService, ConfirmResult, getFileNamesMessage } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';

/** Save confirmation UI shared with frontends that provide no file-picker surface. */
export class SaveConfirmDialog {
	constructor(
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService
	) { }

	async showSaveConfirm(fileNamesOrResources: (string | URI)[]): Promise<ConfirmResult> {
		if (this.skipDialogs()) {
			this.logService.trace('FileDialogService: refused to show save confirmation dialog in tests.');

			// no veto when we are in extension dev testing mode because we cannot assume we run interactive
			return ConfirmResult.DONT_SAVE;
		}

		return this.doShowSaveConfirm(fileNamesOrResources);
	}

	private skipDialogs(): boolean {
		if (this.environmentService.enableSmokeTestDriver) {
			this.logService.warn('DialogService: Dialog requested during smoke test.');
		}
		// integration tests
		return this.environmentService.isExtensionDevelopment && !!this.environmentService.extensionTestsLocationURI;
	}

	private async doShowSaveConfirm(fileNamesOrResources: (string | URI)[]): Promise<ConfirmResult> {
		if (fileNamesOrResources.length === 0) {
			return ConfirmResult.DONT_SAVE;
		}

		let message: string;
		let detail = nls.localize('saveChangesDetail', "Your changes will be lost if you don't save them.");
		if (fileNamesOrResources.length === 1) {
			message = nls.localize('saveChangesMessage', "Do you want to save the changes you made to {0}?", typeof fileNamesOrResources[0] === 'string' ? fileNamesOrResources[0] : resources.basename(fileNamesOrResources[0]));
		} else {
			message = nls.localize('saveChangesMessages', "Do you want to save the changes to the following {0} files?", fileNamesOrResources.length);
			detail = getFileNamesMessage(fileNamesOrResources) + '\n' + detail;
		}

		const { result } = await this.dialogService.prompt<ConfirmResult>({
			type: Severity.Warning,
			message,
			detail,
			buttons: [
				{
					label: fileNamesOrResources.length > 1 ?
						nls.localize({ key: 'saveAll', comment: ['&& denotes a mnemonic'] }, "&&Save All") :
						nls.localize({ key: 'save', comment: ['&& denotes a mnemonic'] }, "&&Save"),
					run: () => ConfirmResult.SAVE
				},
				{
					label: nls.localize({ key: 'dontSave', comment: ['&& denotes a mnemonic'] }, "Do&&n't Save"),
					run: () => ConfirmResult.DONT_SAVE
				}
			],
			cancelButton: {
				run: () => ConfirmResult.CANCEL
			}
		});

		return result;
	}

}
