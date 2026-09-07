/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ContextKeyExprType, type ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContextKey } from '../../../../platform/contextkey/common/contextkeys.js';
import { ACCESSIBILITY_OVERLAY_KEYS } from '../../../browser/tauri/keymap.js';

/**
 * The keep-set: which of stock's default keybinding rules survive when this port's keymap is
 * the only keyboard consumer. The filter runs at the resolver — `TauriKeybindingService` —
 * rather than in the DOM, so there is one dispatcher and no second race.
 *
 * This module holds no DOM and no service, so the effective set can be printed and asserted
 * from a unit test.
 */

/** Off restores stock's resolver exactly, and is the accessibility escape hatch. */
export const takeoverSettingKey = 'tscode.keyboard.takeover';

/** Why a default rule survived the filter. One reason per rule, first match wins. */
export const enum KeepReason {
	/** A row of this port's own keymap. Registered by `keymap.contribution.ts`. */
	Keymap = 'keymap',
	/** A chord the keymap declares identical to stock's, so stock's own rule serves it. */
	SharedChord = 'shared-chord',
	/** `list.*` — list and tree navigation, which every pane in this build answers. */
	ListNavigation = 'list-navigation',
	/** Guarded on a focused input or text editor: a box deliberately entered keeps native typing. */
	TextInput = 'text-input',
	/** Quick-input / quick-open internals, which own the keyboard while an overlay is up. */
	QuickInput = 'quick-input',
	/** The accessible view and the accessibility help, which own the keyboard the same way. */
	AccessibilityOverlay = 'accessibility-overlay',
	/** Copy, cut and paste on whatever has the keyboard — upstream's own rules for it. */
	Clipboard = 'clipboard',
}

/** The two fields of a `ResolvedKeybindingItem` the filter reads. */
export interface ITakeoverRule {
	readonly command: string | null;
	readonly when: ContextKeyExpression | undefined;
}

/**
 * `inQuickOpen` and `inQuickInput` are spelled out rather than imported: their declarations
 * (`workbench/browser/quickaccess.ts` and `platform/quickinput/browser/quickInput.ts`) are
 * DOM-bound, and this module is loaded by a test that has no DOM.
 */
const quickInputContextKeys = ['inQuickOpen', 'inQuickInput'];

/**
 * The accessible view and the accessibility help own the keyboard the way a quick pick does, and
 * `keymap.ts` already stands every row of the map down inside them. That was half of the claim:
 * upstream's own rules for those surfaces are guarded on these same two keys, so the filter
 * dropped **eighteen** of them — `Alt+]`/`Alt+[` to step, `Ctrl+Shift+O` to go to a symbol,
 * `Alt+H`, `Alt+K`, `Alt+A`, `Alt+F6`, `Ctrl+E`, and the terminal accessible buffer's six —
 * measured off the running app's own resolver rather than a scan. The two overlays kept no
 * keyboard at all; they kept only the absence of ours.
 */
const accessibilityOverlayContextKeys = ACCESSIBILITY_OVERLAY_KEYS;

/**
 * The two overlays' rules the guard walk cannot read, so they are named by command — the same
 * move `sharedChordCommands` is, and for the same reason.
 *
 * The first two are the way *in*: `Alt+F1` is guarded on `!accessibilityHelpIsShown` and `Alt+F2`
 * on nothing at all, which is a negation and an absence, and a surface with no way in has not
 * kept its keyboard. `focusAccessibleBuffer` is `Alt+F2`'s **second** command, on the `pastePwsh`
 * rule above: keeping one of a chord's two commands is how the keep-set silently picks a
 * different one. `runRecentCommand` is the accessible buffer's sixth key, and it is here rather
 * than in the walk because two of its four clauses are `accessibilityModeEnabled && terminalFocus`
 * — outside the overlay, under a screen reader, and on a chord no row of the map claims.
 */
const accessibilityOverlayCommands = new Set([
	'editor.action.accessibilityHelp',
	'editor.action.accessibleView',
	'workbench.action.terminal.focusAccessibleBuffer',
	'workbench.action.terminal.runRecentCommand',
]);

const textInputContextKeys = [InputFocusedContextKey, EditorContextKeys.textInputFocus.key];

const listCommandPrefix = 'list.';

/**
 * The one exception to `list.*`: tree find and type-ahead do not survive, because `/` replaces
 * both. `workbench.list.typeNavigationMode` is defaulted to `trigger` alongside this filter so
 * type-ahead also stops consuming bare letters raw, ahead of the resolver.
 */
const listFindCommands = new Set([
	'list.find',
	'list.closeFind',
	'list.toggleFindMode',
	'list.toggleFindMatchType',
	'list.toggleFilterOnType',
	'list.toggleKeyboardNavigation',
	'list.triggerTypeNavigation',
]);

/**
 * The chords the keymap lists as already identical to stock's, so stock keeps answering them —
 * every `stock: true` row of `keymap.ts`, named here because those rows register no rule of their
 * own and so never reach `registerTakeoverKeepCommand`.
 *
 * The terminal ids are the panel's keys. They are named by *command* and not by chord, which is
 * what carries the second rule each of the find commands has: upstream binds `Shift+Enter` and
 * `Enter` inside the find box as well, and a keep-set of commands keeps those with them. The same
 * is true of the editor's find — one entry keeps `F3` and the `Enter` inside its box — and of
 * `notifications.hideToasts`, which upstream registers twice at two weights.
 *
 * **`pastePwsh` is what naming a command costs**: it keeps *that* command's rules and nothing
 * else, so a chord upstream answers with a **second command** has to be named too, or the keep-set
 * quietly changes which one wins. Upstream's Windows `Ctrl+V` in a PowerShell terminal is
 * `pastePwsh`, which beats `paste` on nothing but `paste < pastePwsh` in `keybindingsRegistry.ts`'s
 * tie-break, and sends the shell a literal `Ctrl+V` so PSReadLine pastes multi-line text itself.
 */
const sharedChordCommands = new Set([
	'workbench.action.quickOpen',
	'workbench.action.showCommands',
	'workbench.action.toggleSidebarVisibility',
	'workbench.action.closeActiveEditor',
	'search.focus.nextInputBox',
	'search.focus.previousInputBox',
	'actions.find',
	'editor.action.nextMatchFindAction',
	'editor.action.previousMatchFindAction',
	'closeFindWidget',
	'notifications.hideToasts',
	'workbench.action.terminal.findNext',
	'workbench.action.terminal.findPrevious',
	'workbench.action.terminal.focusFind',
	'workbench.action.terminal.hideFind',
	'workbench.action.terminal.toggleTerminal',
	'workbench.action.terminal.copySelection',
	'workbench.action.terminal.copyAndClearSelection',
	'workbench.action.terminal.paste',
	'workbench.action.terminal.pastePwsh',
	'workbench.action.terminal.focusNext',
	'workbench.action.terminal.focusPrevious',
	'workbench.action.terminal.scrollUpPage',
	'workbench.action.terminal.scrollDownPage',
]);

/**
 * The clipboard, wherever this frontend has one — upstream's own copy, cut and paste rules for the
 * surface that has the keyboard: the explorer's files, a search result's text and its path, the
 * active file's path, and the suggest widget's details.
 *
 * **The reason these were dropped is the one direction this port does not allow.** It was that a
 * surface with no file clipboard has nothing to copy files to, and that a tree has no editable to
 * paste into — the second of which is false about the thing it describes. Upstream's explorer
 * binds `Ctrl+C` and `^filesExplorer.paste`, and what they carry is *files*, so an argument about
 * text and editables never reached them. **A key this frontend can answer is never dropped because
 * some other surface could not**: that direction is an `only: 'tui'` omission, recorded on the row
 * it belongs to in `keymap.ts`, and it does not travel back.
 *
 * Named by command, as `sharedChordCommands` is and for the same reason: every one of these guards
 * on the surface that owns the gesture — `filesExplorerFocus`, `fileMatchOrMatchFocus`,
 * `suggestWidgetDetailsFocused` — and the guard walk below reads none of them.
 */
const clipboardCommands = new Set([
	'filesExplorer.copy',
	'filesExplorer.cut',
	// `^filesExplorer.paste` is upstream's "let this one bubble" form; `ResolvedKeybindingItem`
	// strips the caret, so the filter sees the bare id.
	'filesExplorer.paste',
	'filesExplorer.cancelCut',
	'copyFilePath',
	'copyRelativeFilePath',
	'workbench.action.files.copyPathOfActiveFile',
	'search.action.copyMatch',
	'search.action.copyPath',
	'suggestWidgetCopy',
]);

const keymapCommands = new Set<string>();

/**
 * Declare a command as one the keymap binds, so its rule survives the filter. The keymap is
 * registered into `KeybindingsRegistry` like any other default, and nothing on a resolved item
 * says where it came from — so its consumer names its own commands here.
 */
export function registerTakeoverKeepCommand(commandId: string): void {
	keymapCommands.add(commandId);
}

/** The declared keymap commands, sorted — the printable half of the keep-set. */
export function takeoverKeepCommands(): string[] {
	return [...keymapCommands].sort();
}

/**
 * Whether `expr` **cannot hold** unless one of `keys` is set. The question a keep-set asks is "does
 * this rule apply only where one of these has the keyboard", not "could it" — so a conjunction is
 * settled by any one term naming a key, while a disjunction needs *every* clause to name one,
 * because a clause that names none is a way for the rule to fire with nothing of the sort focused.
 * A rule guarded on `!inputFocus` (every `list.*` rule is) names nothing: a negation, an equality
 * and a regex are all unreadable to this walk and answer `false`, which drops rather than guesses.
 */
function onlyAppliesWhere(expr: ContextKeyExpression, keys: readonly string[]): boolean {
	switch (expr.type) {
		case ContextKeyExprType.Defined:
			return keys.includes(expr.key);
		case ContextKeyExprType.And:
			return expr.expr.some(child => onlyAppliesWhere(child, keys));
		case ContextKeyExprType.Or:
			return expr.expr.every(child => onlyAppliesWhere(child, keys));
		default:
			return false;
	}
}

/** Why this default rule is kept, or `undefined` if the takeover drops it. */
export function keepReason(rule: ITakeoverRule): KeepReason | undefined {
	const command = rule.command;
	if (command) {
		if (keymapCommands.has(command)) {
			return KeepReason.Keymap;
		}
		if (sharedChordCommands.has(command)) {
			return KeepReason.SharedChord;
		}
		if (accessibilityOverlayCommands.has(command)) {
			return KeepReason.AccessibilityOverlay;
		}
		if (clipboardCommands.has(command)) {
			return KeepReason.Clipboard;
		}
		if (command.startsWith(listCommandPrefix)) {
			return listFindCommands.has(command) ? undefined : KeepReason.ListNavigation;
		}
	}
	if (rule.when) {
		if (onlyAppliesWhere(rule.when, textInputContextKeys)) {
			return KeepReason.TextInput;
		}
		if (onlyAppliesWhere(rule.when, quickInputContextKeys)) {
			return KeepReason.QuickInput;
		}
		if (onlyAppliesWhere(rule.when, accessibilityOverlayContextKeys)) {
			return KeepReason.AccessibilityOverlay;
		}
	}
	return undefined;
}

/**
 * The rules a resolver keeps under the takeover: every user rule, and the defaults in the
 * keep-set. `keybindings.json` still loads and still overrides both, exactly as it does with the
 * takeover switched off.
 */
export function filterForTakeover<T extends ITakeoverRule & { readonly isDefault: boolean }>(rules: readonly T[]): T[] {
	return rules.filter(rule => !rule.isDefault || keepReason(rule) !== undefined);
}

/** What the print names a rule the user's own `keybindings.json` contributed. */
const userSource = 'user';

/** One resolved rule as the print states it — a chord, and the three facts the filter reads. */
export interface IPrintedRule extends ITakeoverRule {
	/** The chord as the keyboard mapper labels it: `Ctrl+K Ctrl+S` for a chord of two. */
	readonly chord: string;
	readonly isDefault: boolean;
}

/**
 * The effective rule set, one tab-separated line per rule and sorted — so two runs of one build
 * print the same bytes and two builds print a diff a reviewer can read.
 *
 * **This is the print a unit test cannot produce.** `KeybindingsRegistry` is filled at import time
 * by contribution modules carrying CSS imports, parameter decorators and module-scope DOM, so a
 * type-stripping `node` can only classify a corpus someone wrote down; the set the app resolves
 * with exists only inside a running window. Its caller is
 * `TauriKeybindingService.dumpEffectiveKeybindings`, over `_getResolver().getKeybindings()`.
 */
export function printEffectiveKeybindings(rules: readonly IPrintedRule[]): string {
	return rules
		.map(rule => [
			rule.chord,
			rule.command ?? '',
			rule.isDefault ? keepReason(rule) ?? '' : userSource,
			rule.when?.serialize() ?? ''
		].join('\t'))
		.sort()
		.join('\n');
}
