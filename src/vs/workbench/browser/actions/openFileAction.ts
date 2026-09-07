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
import { IsMacNativeContext } from '../../../platform/contextkey/common/contextkeys.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';

export class OpenFileAction extends Action2 {

	static readonly ID = 'workbench.action.files.openFile';

	constructor() {
		super({
			id: OpenFileAction.ID,
			title: localize2('openFile', 'Open File...'),
			category: Categories.File,
			f1: true,
			keybinding: {
				when: IsMacNativeContext.toNegated(),
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyO
			}
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickFileAndOpen({ forceNewWindow: false, telemetryExtraData: data });
	}
}

registerAction2(OpenFileAction);

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFileAction.ID,
		title: localize({ key: 'miOpenFile', comment: ['&& denotes a mnemonic'] }, "&&Open File...")
	},
	order: 1,
	when: IsMacNativeContext.toNegated()
});
