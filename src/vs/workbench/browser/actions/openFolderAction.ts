/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { ITelemetryData } from '../../../platform/telemetry/common/telemetry.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { MenuRegistry, MenuId, Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { OpenFolderWorkspaceSupportContext } from '../../common/contextkeys.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';

export class OpenFolderAction extends Action2 {

	static readonly ID = 'workbench.action.files.openFolder';

	constructor() {
		super({
			id: OpenFolderAction.ID,
			title: localize2('openFolder', 'Open Folder...'),
			category: Categories.File,
			f1: true,
			precondition: OpenFolderWorkspaceSupportContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: undefined,
				linux: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyO)
				},
				win: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyO)
				}
			}
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickFolderAndOpen({ forceNewWindow: false, telemetryExtraData: data });
	}
}

registerAction2(OpenFolderAction);

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFolderAction.ID,
		title: localize({ key: 'miOpenFolder', comment: ['&& denotes a mnemonic'] }, "Open &&Folder...")
	},
	order: 2,
	when: OpenFolderWorkspaceSupportContext
});
