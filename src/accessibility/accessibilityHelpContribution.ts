/*---------------------------------------------------------------------------------------------
 * Upstream command registration for the projected editor accessibility-help provider.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../vs/base/common/keyCodes.js';
import { combinedDisposable, IDisposable } from '../vs/base/common/lifecycle.js';
import { ContextKeyExpr, IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../vs/platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingsRegistry } from '../vs/platform/keybinding/common/keybindingsRegistry.js';
import {
	AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, IAccessibleViewService
} from '../vs/platform/accessibility/browser/accessibleView.js';
import { EditorAreaFocusContext } from '../vs/workbench/common/contextkeys.js';
import { AccessibilityCommandId } from '../vs/workbench/contrib/accessibility/common/accessibilityCommands.js';
import { AccessibilityVerbositySettingId, accessibilityHelpIsShown, accessibleViewGoToSymbolSupported,
	accessibleViewIsShown } from '../vs/workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { AccessibilityHelpAction } from '../vs/workbench/contrib/accessibility/browser/accessibleViewActions.js';
import { accessibilityHelpLineSymbols, editorHelpContent } from './accessibilityHelp.js';

/** Registers the upstream Alt+F1 action's implementation for this projected editor surface. */
export function registerProjectedEditorAccessibilityHelp(): IDisposable {
	const implementation = AccessibilityHelpAction.addImplementation(90, 'projected-editor', accessor => {
		const context = accessor.get(IContextKeyService);
		if (!context.contextMatchesRules(EditorAreaFocusContext)) { return false; }
		const content = editorHelpContent();
		accessor.get(IAccessibleViewService).show(new AccessibleContentProvider(
			AccessibleViewProviderId.Editor,
			{ type: AccessibleViewType.Help, readMoreUrl: 'https://go.microsoft.com/fwlink/?linkid=851010' },
			() => content,
			() => undefined,
			AccessibilityVerbositySettingId.Editor,
			undefined, undefined, undefined, undefined, undefined,
			() => accessibilityHelpLineSymbols(content)
		));
		return true;
	});
	// The upstream journey names physical Control+Shift+O. CtrlCmd becomes Command on macOS, so the
	// native frontend adds the deliverable physical-Control spelling to the same upstream command.
	const symbolKey = KeybindingsRegistry.registerKeybindingRule({
		id: AccessibilityCommandId.GoToSymbol,
		primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyO,
		weight: KeybindingWeight.WorkbenchContrib + 10,
		when: ContextKeyExpr.and(ContextKeyExpr.or(accessibilityHelpIsShown, accessibleViewIsShown),
			accessibleViewGoToSymbolSupported)
	});
	return combinedDisposable(implementation, symbolKey);
}
