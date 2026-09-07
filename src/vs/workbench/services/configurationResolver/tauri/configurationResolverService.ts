/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { BaseConfigurationResolverService } from '../browser/baseConfigurationResolverService.js';
import { IConfigurationResolverService } from '../common/configurationResolver.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IShellEnvironmentService } from '../../environment/tauri/shellEnvironmentService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { IPathService } from '../../path/common/pathService.js';

/**
 * Copy of `electron-browser/configurationResolverService.ts`, which this port registers in
 * place of the browser one. The difference between the two is the environment `${env:…}`
 * resolves against: the browser service passes an empty one, which is right for a workbench
 * in a tab and wrong here — this window runs on the machine, and `terminal.integrated.profiles.
 * windows` alone ships `${env:windir}` in its own default value.
 *
 * `appRoot` and `execPath` stay undefined, as they are in the browser service: they come from
 * `INativeWorkbenchEnvironmentService`, and both name paths inside a desktop installation this
 * port does not have.
 */
export class ConfigurationResolverService extends BaseConfigurationResolverService {

	constructor(
		@IEditorService editorService: IEditorService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IQuickInputService quickInputService: IQuickInputService,
		@ILabelService labelService: ILabelService,
		@IShellEnvironmentService shellEnvironmentService: IShellEnvironmentService,
		@IPathService pathService: IPathService,
		@IExtensionService extensionService: IExtensionService,
		@IStorageService storageService: IStorageService,
	) {
		super({ getAppRoot: () => undefined, getExecPath: () => undefined },
			shellEnvironmentService.getShellEnv(), editorService, configurationService,
			commandService, workspaceContextService, quickInputService, labelService, pathService, extensionService, storageService);
	}
}

registerSingleton(IConfigurationResolverService, ConfigurationResolverService, InstantiationType.Delayed);
