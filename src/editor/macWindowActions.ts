/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh } from '../vs/base/common/platform.js';
import { invoke } from './nativeTransport.js';
import { CommandsRegistry } from '../vs/platform/commands/common/commands.js';
import { IConfigurationService } from '../vs/platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../vs/platform/instantiation/common/instantiation.js';

// From VS Code's electron-browser/actions/windowActions.ts. The Electron native-host
// calls are replaced by the WK bridge; AppKit still owns tab order and selection.
function canRunNativeTabsHandler(accessor: ServicesAccessor): boolean {
	if (!isMacintosh) {
		return false;
	}

	const configurationService = accessor.get(IConfigurationService);
	return configurationService.getValue<unknown>('window.nativeTabs') === true;
}

CommandsRegistry.registerCommand('workbench.action.showPreviousWindowTab', function (accessor: ServicesAccessor) {
	if (!canRunNativeTabsHandler(accessor)) {
		return;
	}

	return invoke('mac_show_previous_window_tab');
});

CommandsRegistry.registerCommand('workbench.action.showNextWindowTab', function (accessor: ServicesAccessor) {
	if (!canRunNativeTabsHandler(accessor)) {
		return;
	}

	return invoke('mac_show_next_window_tab');
});
