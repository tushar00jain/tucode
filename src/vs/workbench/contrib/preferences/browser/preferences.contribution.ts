/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isBoolean, isObject, isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsMacNativeContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { WorkbenchStateContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { CURRENT_PROFILE_CONTEXT } from '../../../services/userDataProfile/common/userDataProfile.js';
import { ExplorerFolderContext, ExplorerRootContext } from '../../files/common/files.js';
import { PreferencesContribution } from '../common/preferencesContribution.js';
import { ConfigureLanguageBasedSettingsAction } from './preferencesActions.js';
import { preferencesOpenSettingsIcon } from './preferencesIcons.js';

const SETTINGS_COMMAND_OPEN_SETTINGS = 'workbench.action.openSettings';

const OPEN_USER_SETTINGS_JSON_TITLE = nls.localize2('openUserSettingsJson', "Open User Settings (JSON)");
const OPEN_APPLICATION_SETTINGS_JSON_TITLE = nls.localize2('openApplicationSettingsJson', "Open Application Settings (JSON)");
const category = Categories.Preferences;

interface IOpenSettingsActionOptions {
	openToSide?: boolean;
	query?: string;
	revealSetting?: {
		key: string;
		edit?: boolean;
	};
	focusSearch?: boolean;
}

function sanitizeBoolean(arg: unknown): boolean | undefined {
	return isBoolean(arg) ? arg : undefined;
}

function sanitizeString(arg: unknown): string | undefined {
	return isString(arg) ? arg : undefined;
}

function sanitizeOpenSettingsArgs(args: any): IOpenSettingsActionOptions {
	if (!isObject(args)) {
		args = {};
	}

	let sanitizedObject: IOpenSettingsActionOptions = {
		focusSearch: sanitizeBoolean(args?.focusSearch),
		openToSide: sanitizeBoolean(args?.openToSide),
		query: sanitizeString(args?.query)
	};

	if (isString(args?.revealSetting?.key)) {
		sanitizedObject = {
			...sanitizedObject,
			revealSetting: {
				key: args.revealSetting.key,
				edit: sanitizeBoolean(args.revealSetting?.edit)
			}
		};
	}

	return sanitizedObject;
}

class PreferencesActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.preferencesActions';

	constructor(
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
	) {
		super();

		this.registerSettingsActions();
		this.registerKeybindingsActions();
	}

	private registerSettingsActions() {
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: SETTINGS_COMMAND_OPEN_SETTINGS,
					title: {
						...nls.localize2('settings', "Settings"),
						mnemonicTitle: nls.localize({ key: 'miOpenSettings', comment: ['&& denotes a mnemonic'] }, "&&Settings"),
					},
					keybinding: {
						weight: KeybindingWeight.WorkbenchContrib,
						when: null,
						primary: KeyMod.CtrlCmd | KeyCode.Comma,
					},
					menu: [{
						id: MenuId.GlobalActivity,
						group: '2_configuration',
						order: 2
					}, {
						id: MenuId.MenubarPreferencesMenu,
						group: '2_configuration',
						order: 2
					}],
				});
			}
			run(accessor: ServicesAccessor, args: string | IOpenSettingsActionOptions) {
				// args takes a string for backcompat
				const opts = typeof args === 'string' ? { query: args } : sanitizeOpenSettingsArgs(args);
				return accessor.get(IPreferencesService).openSettings({ ...opts });
			}
		}));

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openSettingsJson',
					title: OPEN_USER_SETTINGS_JSON_TITLE,
					metadata: {
						description: nls.localize2('workbench.action.openSettingsJson.description', "Opens the JSON file containing the current user profile settings")
					},
					category,
					f1: true,
				});
			}
			run(accessor: ServicesAccessor, args: IOpenSettingsActionOptions) {
				args = sanitizeOpenSettingsArgs(args);
				return accessor.get(IPreferencesService).openSettings({ jsonEditor: true, ...args });
			}
		}));

		const that = this;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openApplicationSettingsJson',
					title: OPEN_APPLICATION_SETTINGS_JSON_TITLE,
					category,
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.notEquals(CURRENT_PROFILE_CONTEXT.key, that.userDataProfilesService.defaultProfile.id)
					}
				});
			}
			run(accessor: ServicesAccessor, args: IOpenSettingsActionOptions) {
				args = sanitizeOpenSettingsArgs(args);
				return accessor.get(IPreferencesService).openApplicationSettings({ jsonEditor: true, ...args });
			}
		}));

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openGlobalSettings',
					title: nls.localize2('openGlobalSettings', "Open User Settings"),
					category,
					f1: true,
				});
			}
			run(accessor: ServicesAccessor, args: IOpenSettingsActionOptions) {
				args = sanitizeOpenSettingsArgs(args);
				return accessor.get(IPreferencesService).openUserSettings(args);
			}
		}));
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openRawDefaultSettings',
					title: nls.localize2('openRawDefaultSettings', "Open Default Settings (JSON)"),
					category,
					f1: true,
				});
			}
			run(accessor: ServicesAccessor) {
				return accessor.get(IPreferencesService).openRawDefaultSettings();
			}
		}));

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: ConfigureLanguageBasedSettingsAction.ID,
					title: ConfigureLanguageBasedSettingsAction.LABEL,
					category,
					f1: true,
				});
			}
			run(accessor: ServicesAccessor) {
				return accessor.get(IInstantiationService).createInstance(ConfigureLanguageBasedSettingsAction, ConfigureLanguageBasedSettingsAction.ID, ConfigureLanguageBasedSettingsAction.LABEL.value).run();
			}
		}));
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openWorkspaceSettings',
					title: nls.localize2('openWorkspaceSettings', "Open Workspace Settings"),
					category,
					menu: {
						id: MenuId.CommandPalette,
						when: WorkbenchStateContext.notEqualsTo('empty')
					}
				});
			}
			run(accessor: ServicesAccessor, args?: string | IOpenSettingsActionOptions) {
				// Match the behaviour of workbench.action.openSettings
				args = typeof args === 'string' ? { query: args } : sanitizeOpenSettingsArgs(args);
				return accessor.get(IPreferencesService).openWorkspaceSettings(args);
			}
		}));

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openWorkspaceSettingsFile',
					title: nls.localize2('openWorkspaceSettingsFile', "Open Workspace Settings (JSON)"),
					category,
					menu: {
						id: MenuId.CommandPalette,
						when: WorkbenchStateContext.notEqualsTo('empty')
					}
				});
			}
			run(accessor: ServicesAccessor, args?: IOpenSettingsActionOptions) {
				args = sanitizeOpenSettingsArgs(args);
				return accessor.get(IPreferencesService).openWorkspaceSettings({ jsonEditor: true, ...args });
			}
		}));
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openFolderSettings',
					title: nls.localize2('openFolderSettings', "Open Folder Settings"),
					category,
					menu: {
						id: MenuId.CommandPalette,
						when: WorkbenchStateContext.isEqualTo('workspace')
					}
				});
			}
			async run(accessor: ServicesAccessor, args?: IOpenSettingsActionOptions) {
				const commandService = accessor.get(ICommandService);
				const preferencesService = accessor.get(IPreferencesService);
				const workspaceFolder = await commandService.executeCommand<IWorkspaceFolder>(PICK_WORKSPACE_FOLDER_COMMAND_ID);
				if (workspaceFolder) {
					args = sanitizeOpenSettingsArgs(args);
					await preferencesService.openFolderSettings({ folderUri: workspaceFolder.uri, ...args });
				}
			}
		}));
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openFolderSettingsFile',
					title: nls.localize2('openFolderSettingsFile', "Open Folder Settings (JSON)"),
					category,
					menu: {
						id: MenuId.CommandPalette,
						when: WorkbenchStateContext.isEqualTo('workspace')
					}
				});
			}
			async run(accessor: ServicesAccessor, args?: IOpenSettingsActionOptions) {
				const commandService = accessor.get(ICommandService);
				const preferencesService = accessor.get(IPreferencesService);
				const workspaceFolder = await commandService.executeCommand<IWorkspaceFolder>(PICK_WORKSPACE_FOLDER_COMMAND_ID);
				if (workspaceFolder) {
					args = sanitizeOpenSettingsArgs(args);
					await preferencesService.openFolderSettings({ folderUri: workspaceFolder.uri, jsonEditor: true, ...args });
				}
			}
		}));
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: '_workbench.action.openFolderSettings',
					title: nls.localize('openFolderSettings', "Open Folder Settings"),
					category,
					menu: {
						id: MenuId.ExplorerContext,
						group: '2_workspace',
						order: 20,
						when: ContextKeyExpr.and(ExplorerRootContext, ExplorerFolderContext)
					}
				});
			}
			async run(accessor: ServicesAccessor, resource?: URI) {
				if (URI.isUri(resource)) {
					await accessor.get(IPreferencesService).openFolderSettings({ folderUri: resource });
				} else {
					const commandService = accessor.get(ICommandService);
					const preferencesService = accessor.get(IPreferencesService);
					const workspaceFolder = await commandService.executeCommand<IWorkspaceFolder>(PICK_WORKSPACE_FOLDER_COMMAND_ID);
					if (workspaceFolder) {
						await preferencesService.openFolderSettings({ folderUri: workspaceFolder.uri });
					}
				}
			}
		}));
	}

	private registerKeybindingsActions() {
		const category = nls.localize2('preferences', "Preferences");
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openDefaultKeybindingsFile',
					title: nls.localize2('openDefaultKeybindingsFile', "Open Default Keyboard Shortcuts (JSON)"),
					category,
					menu: { id: MenuId.CommandPalette }
				});
			}
			run(accessor: ServicesAccessor) {
				return accessor.get(IPreferencesService).openDefaultKeybindingsFile();
			}
		}));
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.openGlobalKeybindingsFile',
					title: nls.localize2('openGlobalKeybindingsFile', "Open Keyboard Shortcuts (JSON)"),
					category,
					icon: preferencesOpenSettingsIcon,
					menu: [
						{ id: MenuId.CommandPalette }
					]
				});
			}
			run(accessor: ServicesAccessor, ...args: unknown[]) {
				const groupId = getEditorGroupFromArguments(accessor, args)?.id;
				return accessor.get(IPreferencesService).openGlobalKeybindingSettings(true, { groupId });
			}
		}));
	}
}

function getEditorGroupFromArguments(accessor: ServicesAccessor, args: unknown[]): IEditorGroup | undefined {
	const context = resolveCommandsContext(args, accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IListService));
	return context.groupedEditors[0]?.group;
}

registerWorkbenchContribution2(PreferencesActionsContribution.ID, PreferencesActionsContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(PreferencesContribution.ID, PreferencesContribution, WorkbenchPhase.BlockStartup);

// Preferences menu

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	title: nls.localize({ key: 'miPreferences', comment: ['&& denotes a mnemonic'] }, "&&Preferences"),
	submenu: MenuId.MenubarPreferencesMenu,
	group: '5_autosave',
	order: 2,
	when: IsMacNativeContext.toNegated() // on macOS native the preferences menu is separate under the application menu
});
