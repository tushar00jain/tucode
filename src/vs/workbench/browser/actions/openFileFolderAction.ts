/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { ITelemetryData } from '../../../platform/telemetry/common/telemetry.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { MenuRegistry, MenuId, Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { OpenFolderWorkspaceSupportContext } from '../../common/contextkeys.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { IsMacNativeContext } from '../../../platform/contextkey/common/contextkeys.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { ILocalizedString } from '../../../platform/action/common/action.js';

export class OpenFileFolderAction extends Action2 {

	static readonly ID = 'workbench.action.files.openFileFolder';
	static readonly LABEL: ILocalizedString = localize2('openFileFolder', 'Open...');

	constructor() {
		super({
			id: OpenFileFolderAction.ID,
			title: OpenFileFolderAction.LABEL,
			category: Categories.File,
			f1: true,
			precondition: ContextKeyExpr.and(IsMacNativeContext, OpenFolderWorkspaceSupportContext),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyO
			}
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickFileFolderAndOpen({ forceNewWindow: false, telemetryExtraData: data });
	}
}

registerAction2(OpenFileFolderAction);

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFileFolderAction.ID,
		title: localize({ key: 'miOpen', comment: ['&& denotes a mnemonic'] }, "&&Open...")
	},
	order: 1,
	when: ContextKeyExpr.and(IsMacNativeContext, OpenFolderWorkspaceSupportContext)
});
