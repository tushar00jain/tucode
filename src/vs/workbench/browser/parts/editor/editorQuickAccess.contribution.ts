/* Shared registration of the existing editor picker providers and navigation bindings. */
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { IQuickAccessRegistry, Extensions as QuickAccessExtensions } from '../../../../platform/quickinput/common/quickAccess.js';
import { ActiveGroupEditorsByMostRecentlyUsedQuickAccess, AllEditorsByAppearanceQuickAccess, AllEditorsByMostRecentlyUsedQuickAccess } from './editorQuickAccess.js';
import { ShowAllEditorsByAppearanceAction, ShowAllEditorsByMostRecentlyUsedAction, ShowEditorsInActiveGroupByMostRecentlyUsedAction } from './editorActions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { inQuickPickContext, getQuickNavigateHandler } from '../../quickaccess.js';

const quickAccessRegistry = Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess);
const editorPickerContextKey = 'inEditorsPicker';
const editorPickerContext = ContextKeyExpr.and(inQuickPickContext, ContextKeyExpr.has(editorPickerContextKey));

quickAccessRegistry.registerQuickAccessProvider({
	ctor: ActiveGroupEditorsByMostRecentlyUsedQuickAccess,
	prefix: ActiveGroupEditorsByMostRecentlyUsedQuickAccess.PREFIX,
	contextKey: editorPickerContextKey,
	placeholder: localize('editorQuickAccessPlaceholder', "Type the name of an editor to open it."),
	helpEntries: [{ description: localize('activeGroupEditorsByMostRecentlyUsedQuickAccess', "Show Editors in Active Group by Most Recently Used"), commandId: ShowEditorsInActiveGroupByMostRecentlyUsedAction.ID }]
});

quickAccessRegistry.registerQuickAccessProvider({
	ctor: AllEditorsByAppearanceQuickAccess,
	prefix: AllEditorsByAppearanceQuickAccess.PREFIX,
	contextKey: editorPickerContextKey,
	placeholder: localize('editorQuickAccessPlaceholder', "Type the name of an editor to open it."),
	helpEntries: [{ description: localize('allEditorsByAppearanceQuickAccess', "Show All Opened Editors By Appearance"), commandId: ShowAllEditorsByAppearanceAction.ID }]
});

quickAccessRegistry.registerQuickAccessProvider({
	ctor: AllEditorsByMostRecentlyUsedQuickAccess,
	prefix: AllEditorsByMostRecentlyUsedQuickAccess.PREFIX,
	contextKey: editorPickerContextKey,
	placeholder: localize('editorQuickAccessPlaceholder', "Type the name of an editor to open it."),
	helpEntries: [{ description: localize('allEditorsByMostRecentlyUsedQuickAccess', "Show All Opened Editors By Most Recently Used"), commandId: ShowAllEditorsByMostRecentlyUsedAction.ID }]
});

const quickAccessNavigateNextInEditorPickerId = 'workbench.action.quickOpenNavigateNextInEditorPicker';
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: quickAccessNavigateNextInEditorPickerId,
	weight: KeybindingWeight.WorkbenchContrib + 50,
	handler: getQuickNavigateHandler(quickAccessNavigateNextInEditorPickerId, true),
	when: editorPickerContext,
	primary: KeyMod.CtrlCmd | KeyCode.Tab,
	mac: { primary: KeyMod.WinCtrl | KeyCode.Tab }
});

const quickAccessNavigatePreviousInEditorPickerId = 'workbench.action.quickOpenNavigatePreviousInEditorPicker';
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: quickAccessNavigatePreviousInEditorPickerId,
	weight: KeybindingWeight.WorkbenchContrib + 50,
	handler: getQuickNavigateHandler(quickAccessNavigatePreviousInEditorPickerId, false),
	when: editorPickerContext,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab,
	mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Tab }
});

