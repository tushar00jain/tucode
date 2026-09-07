/*---------------------------------------------------------------------------------------------
 * Native Mac terminal keybindings that differ from the cross-platform CtrlCmd primary.
 *--------------------------------------------------------------------------------------------*/
import { KeyCode, KeyMod } from '../vs/base/common/keyCodes.js';

/** Vendored upstream's macOS override: physical Control+Backquote, not Command+Backquote. */
export const MAC_TERMINAL_TOGGLE_KEYBINDING = KeyMod.WinCtrl | KeyCode.Backquote;
/** Vendored upstream's macOS override: physical Control+Shift+Backquote. */
export const MAC_TERMINAL_NEW_KEYBINDING = KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Backquote;
