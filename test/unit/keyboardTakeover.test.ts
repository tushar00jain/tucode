/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KeyCode, KeyMod } from '../../src/vs/base/common/keyCodes.js';
import { ContextKeyExpr } from '../../src/vs/platform/contextkey/common/contextkey.js';
import { keysFor, rowsFor } from '../../src/vs/workbench/browser/tauri/keymap.js';
import { filterForTakeover, keepReason, registerTakeoverKeepCommand, takeoverKeepCommands, type ITakeoverRule } from '../../src/vs/workbench/services/keybinding/tauri/keyboardTakeover.js';

/**
 * The keyboard takeover filters the default keybindings to a keep-set, and a rule that should
 * have been kept is a silent muscle-memory break rather than a crash. So this prints the
 * verdict for every rule in the corpus below, sorted, and asserts the print — the diff of that
 * block is the review surface for every later phase of the port.
 *
 * The corpus is the real registry's shape, not the real registry: `KeybindingsRegistry` is
 * filled at import time by the workbench's contribution modules, and those cannot be loaded
 * under Node (CSS imports, parameter decorators, DOM at module scope). It was taken from a
 * static scan of every `registerCommandAndKeybindingRule` / `registerKeybindingRule` /
 * `Action2` / `kbOpts` registration in `src/`, and each `when` is the serialized form of the
 * expression that registration passes.
 */

/** One corpus rule: its command id and its `when`, serialized. */
type CorpusRule = readonly [command: string, when: string];

const workbenchList = 'listFocus && !inputFocus && !treestickyScrollFocused';
const explorerFocus = 'foldersViewVisible && filesExplorerFocus && !inputFocus';

/** Every terminal find rule's `precondition`, which `registerAction2` conjoins onto its `when`. */
const terminalReady = '(terminalProcessSupported || terminalHasBeenCreated)';
/** The guard two of the find rules share: the terminal's own keyboard, or its find widget's. */
const terminalOrFind = `${terminalReady} && (terminalFocusInAny || terminalFindFocused)`;
const terminalHideFind = `${terminalReady} && terminalFocusInAny && terminalFindVisible`;
const terminalFindBox = `${terminalReady} && terminalFindInputFocused`;

const corpus: readonly CorpusRule[] = [
	// list and tree navigation — every pane in this build answers exactly these keys
	['list.clear', `${workbenchList} && listHasSelectionOrFocus`],
	['list.collapse', `${workbenchList} && (treeElementCanCollapse || treeElementHasParent)`],
	['list.collapseAll', workbenchList],
	['list.expand', `${workbenchList} && (treeElementCanExpand || treeElementHasChild)`],
	['list.expandSelectionDown', `${workbenchList} && listSupportsMultiselect`],
	['list.focusDown', workbenchList],
	['list.focusFirst', workbenchList],
	['list.focusLast', workbenchList],
	['list.focusPageDown', workbenchList],
	['list.focusUp', workbenchList],
	['list.scrollLeft', workbenchList],
	['list.scrollRight', workbenchList],
	// `Ctrl+Up`/`Ctrl+Down` are already the vertical half of the same gesture, and upstream scopes
	// each out of a list already at that edge so the pair falls through where there is nothing to
	// scroll. They survive for the same reason the horizontal pair does.
	['list.scrollUp', `${workbenchList} && listScrollAtBoundary != 'top' && listScrollAtBoundary != 'both'`],
	['list.scrollDown', `${workbenchList} && listScrollAtBoundary != 'bottom' && listScrollAtBoundary != 'both'`],
	['list.select', workbenchList],
	['list.selectAll', `${workbenchList} && listSupportsMultiselect`],
	['list.stickyScrollselect', 'treestickyScrollFocused'],
	['list.toggleExpand', workbenchList],
	// …except tree find and type-ahead, which `/` replaces
	['list.closeFind', 'listFocus && treeFindOpen'],
	['list.find', 'listFocus && listSupportsFind'],
	['list.triggerTypeNavigation', workbenchList],

	// a focused box keeps native editing
	['cursorHome', 'textInputFocus'],
	['cursorLeft', 'textInputFocus'],
	['deleteLeft', 'textInputFocus'],
	['editor.action.triggerSuggest', 'editorHasCompletionItemProvider && textInputFocus && !editorReadonly'],
	['editor.action.inlineSuggest.commit', 'inlineSuggestionVisible && !editorReadonly'],
	['scrollLineDown', 'textInputFocus'],
	// `editorTextFocus` is not `textInputFocus`: these are editor features, and the editor is
	// modal in this port
	['editor.action.formatDocument', 'editorHasDocumentFormattingProvider && editorTextFocus && !editorReadonly'],
	['outdent', 'editorTextFocus && !editorReadonly && !editorTabMovesFocus'],
	['tab', 'editorTextFocus && !editorReadonly && !editorTabMovesFocus'],

	// quick input and quick open own the keyboard while an overlay is up
	['quickInput.accept', "quickInputType != 'quickWidget' && inQuickInput && !isComposing"],
	['workbench.action.acceptSelectedQuickOpenItem', 'inQuickOpen'],
	['workbench.action.closeQuickOpen', 'inQuickOpen'],
	['workbench.action.quickOpenNavigateNextInFilePicker', 'inQuickOpen && inFilesPicker'],
	['workbench.action.quickPickManyToggle', 'inQuickOpen'],

	// the chords the keymap declares identical to stock's
	['search.focus.nextInputBox', '(inSearchEditor && inputBoxFocus) || (searchViewletVisible && inputBoxFocus)'],
	['search.focus.previousInputBox', '(inSearchEditor && inputBoxFocus) || (searchViewletVisible && inputBoxFocus)'],
	// …the editor's find, whose `Ctrl+F` a *viewer* has no second way to reach — `/` is vim's and
	// vim is not attached there. `editorFocus` is the widget's own focus and not a text box's, so
	// every one of these was dropped: `actions.find` by a disjunction one clause of which names no
	// key at all, and the other two by naming a key the classifier cannot read.
	['actions.find', 'editorFocus || editorIsOpen'],
	['editor.action.nextMatchFindAction', 'editorFocus && findInputFocussed'],
	['closeFindWidget', 'findWidgetVisible && editorFocus && !isComposing'],
	// …and the panel's clipboard, which is the shape the find pair was: `commandsToSkipShell`
	// names the command, so a dropped rule is not an unbound key but one xterm keeps and the shell
	// eats. `Ctrl+V` pasted nothing and typed nothing for as long as this was absent.
	['workbench.action.terminal.paste', `${terminalReady} && terminalFocus`],
	// …and the *second* command upstream binds `Ctrl+V` to, which the panel's `paste` beats by
	// nothing but `paste < pastePwsh`. Naming one and not the other silently picked a different
	// paste, so the pair is asserted together.
	['workbench.action.terminal.pastePwsh', `terminalFocus && terminalShellType == 'pwsh' && !accessibilityModeEnabled`],
	// …and the toast's `Escape`, whose only other way out is the ✕ and a mouse.
	['notifications.hideToasts', 'notificationToastsVisible'],
	['workbench.action.closeActiveEditor', ''],
	['workbench.action.quickOpen', ''],
	['workbench.action.showCommands', ''],
	['workbench.action.toggleSidebarVisibility', ''],
	// …and the terminal panel's five, which are the reason the keep-set is asked about a command
	// rather than a chord: not one of these `when`s names a key the classifier can read, so every
	// one of them was dropped and the panel lost its keyboard entirely. The find `when`s are
	// `and(precondition, keybinding.when)` as `registerAction2` composes them
	// (`actions.ts:764`), and the toggle's is the `precondition` `viewsService.ts:492` puts on
	// every view with an `openCommandActionDescriptor`.
	['workbench.action.terminal.focusFind', terminalOrFind],
	['workbench.action.terminal.hideFind', terminalHideFind],
	['workbench.action.terminal.findNext', terminalOrFind],
	// Find Previous is listed at its **second** rule, the one `Enter` in the find box answers:
	// `terminalFindInputFocused` is a focused text input that no keep-set key names, which is the
	// exact shape that made this class of loss invisible.
	['workbench.action.terminal.findPrevious', terminalFindBox],
	['workbench.action.terminal.toggleTerminal', 'terminal.active'],

	// the clipboard of whatever has the keyboard, which is upstream's and stays upstream's. Every
	// one of these guards on the surface that owns the gesture and on no key the walk below can
	// read, so the keep-set has to name them — and the audit that put them here is the reason it
	// does: they were dropped because the *terminal* frontend has no file clipboard, which is a
	// reason for an omission there and never for one here. `^filesExplorer.paste` registers with a
	// caret to let a paste bubble; `ResolvedKeybindingItem` strips it, so the keep-set sees the
	// bare id.
	['filesExplorer.copy', `${explorerFocus} && !explorerResourceIsRoot`],
	['filesExplorer.cut', `${explorerFocus} && !explorerResourceIsRoot && explorerResourceWritable`],
	['filesExplorer.paste', `${explorerFocus} && !explorerResourceReadonly`],
	['filesExplorer.cancelCut', `${explorerFocus} && explorerResourceCut`],
	['search.action.copyMatch', 'fileMatchOrMatchFocus'],
	['copyFilePath', 'editorFocus'],

	// everything else, named so its loss is visible rather than discovered
	['deleteFile', explorerFocus],
	['filesExplorer.openFilePreserveFocus', `${explorerFocus} && !explorerResourceIsFolder`],
	['renameFile', `${explorerFocus} && !explorerResourceIsRoot && explorerResourceWritable`],
	// The `when` **as the resolver hands it over**, not as `widgetNavigationCommands.ts` writes it:
	// `and(navigableContainerFocused, or(WorkbenchListFocusContextKey.negate(), atBoundary))`
	// distributes into five clauses, and the first of them names `inputFocus`. Written out because
	// the shape is the point — a corpus of conjunctions never asks the classifier the question a
	// disjunction asks, and this rule survived as `text-input` in a real build until it did.
	['widgetNavigation.focusNext', `inputFocus && navigableContainerFocused || navigableContainerFocused && treestickyScrollFocused || navigableContainerFocused && !listFocus || navigableContainerFocused && listScrollAtBoundary == 'both' || navigableContainerFocused && listScrollAtBoundary == 'bottom'`],
	['widgetNavigation.focusPrevious', `inputFocus && navigableContainerFocused || navigableContainerFocused && treestickyScrollFocused || navigableContainerFocused && !listFocus || navigableContainerFocused && listScrollAtBoundary == 'both' || navigableContainerFocused && listScrollAtBoundary == 'top'`],
	['workbench.action.files.save', ''],
	['workbench.action.navigateBack', ''],
	['workbench.action.terminal.new', 'terminalProcessSupported'],
	['workbench.action.toggleFullScreen', ''],
];

/**
 * The accessibility surface, and the chord each rule answers. Accessibility support stays on —
 * `IAccessibilityService`, the accessible view, the help, the signals and every
 * `accessibility.*` setting are all registered — so the question the user's rule asks is not
 * whether it is loaded but whether any of it answers a key this port's keymap registers. The
 * chords are `keymap.ts`'s own vocabulary so the two tables can be compared directly.
 *
 * **This table was read off the running app**, not off a scan: `Developer: Print Effective
 * Keybindings` with the takeover switched off prints stock's whole default set with the verdict
 * the filter would give each rule, and the two overlays' rules are the ones it printed with none.
 * The scan had missed `accessibilityHelpConfigureAssignedKeybindings`, four of the terminal
 * accessible buffer's six, and the fact that `openDetectedLink` registers **twice** on two
 * different guards. Each `when` below is the serialized form the resolver hands the filter.
 *
 * Windows primaries throughout, which is what this port ships; a rule with a `linux`/`mac`
 * override is listed at the chord this platform resolves it to.
 */
type AccessibilityRule = readonly [command: string, when: string, chord: number];

const inAccessibleView = 'accessibleViewIsShown || accessibilityHelpIsShown';
/** `wordOperations.ts`'s `and(textInputFocus, and(accessibilityModeEnabled, isWindows).negate())`. */
const wordNavigation = 'textInputFocus && (!accessibilityModeEnabled || !isWindows)';
/** The accessible buffer's guard: the accessible view, up, over a terminal. */
const terminalAccessibleView = `accessibleViewIsShown && ${terminalReady} && accessibleViewCurrentProviderId == 'terminal'`;

const accessibilitySurface: readonly AccessibilityRule[] = [
	// the accessible view and the accessibility help — the whole of `accessibleViewActions.ts`
	['editor.action.accessibilityHelp', '!accessibilityHelpIsShown', KeyMod.Alt | KeyCode.F1],
	['editor.action.accessibleView', '', KeyMod.Alt | KeyCode.F2],
	['editor.action.accessibleViewNext', 'accessibleViewIsShown && accessibleViewSupportsNavigation', KeyMod.Alt | KeyCode.BracketRight],
	['editor.action.accessibleViewPrevious', 'accessibleViewIsShown && accessibleViewSupportsNavigation', KeyMod.Alt | KeyCode.BracketLeft],
	['editor.action.accessibleViewGoToSymbol', `(${inAccessibleView}) && accessibleViewGoToSymbolSupported`, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO],
	['editor.action.accessibleViewDisableHint', `(${inAccessibleView}) && accessibleViewVerbosityEnabled`, KeyMod.Alt | KeyCode.F6],
	['editor.action.accessibilityHelpOpenHelpLink', 'accessibilityHelpIsShown', KeyMod.Alt | KeyCode.KeyH],
	['editor.action.accessibilityHelpConfigureKeybindings', 'accessibilityHelpIsShown && accessibleViewHasUnassignedKeybindings', KeyMod.Alt | KeyCode.KeyK],
	['editor.action.accessibilityHelpConfigureAssignedKeybindings', 'accessibilityHelpIsShown && accessibleViewHasAssignedKeybindings', KeyMod.Alt | KeyCode.KeyA],
	["editor.action.accessibleViewAcceptInlineCompletion", "accessibleViewIsShown && accessibleViewCurrentProviderId == 'inlineCompletions'", KeyMod.CtrlCmd | KeyCode.Slash],
	// screen-reader mode itself. `Ctrl+E` is the keymap's own secondary for `quickOpen`, which is
	// why it is here rather than assumed harmless.
	['editor.action.toggleScreenReaderAccessibilityMode', 'accessibilityHelpIsShown', KeyMod.CtrlCmd | KeyCode.KeyE],
	['editor.action.announceCursorPosition', 'editorTextFocus && accessibilityModeEnabled', KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyG],
	// The rule `!accessibilityHelpIsShown && !accessibleViewIsShown` guards, which is how upstream
	// gets *out* of the way of the row above it on the same chord. Both polarities of the same key,
	// and only one of them is the overlay's.
	['workbench.action.gotoSymbol', '!accessibilityHelpIsShown && !accessibleViewIsShown', KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO],

	// the terminal accessible buffer's six, which are the reason the keep-set is asked per *rule*:
	// `openDetectedLink` registers twice, once inside the accessible view and once on a focused
	// terminal, and only the first of them is a key the overlay owns.
	['workbench.action.terminal.focusAccessibleBuffer', `accessibilityModeEnabled && terminalFocus && ${terminalReady}`, KeyMod.Alt | KeyCode.F2],
	['workbench.action.terminal.accessibleBufferGoToNextCommand', terminalAccessibleView, KeyMod.Alt | KeyCode.DownArrow],
	['workbench.action.terminal.accessibleBufferGoToPreviousCommand', terminalAccessibleView, KeyMod.Alt | KeyCode.UpArrow],
	['workbench.action.terminal.scrollToTopAccessibleView', terminalAccessibleView, KeyMod.CtrlCmd | KeyCode.Home],
	['workbench.action.terminal.scrollToBottomAccessibleView', terminalAccessibleView, KeyMod.CtrlCmd | KeyCode.End],
	['workbench.action.terminal.openDetectedLink', terminalAccessibleView, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG],
	['workbench.action.terminal.openDetectedLink', `terminalFocus && ${terminalReady}`, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO],
	['workbench.action.terminal.runRecentCommand', `accessibilityModeEnabled && terminalFocus && ${terminalReady} || accessibilityModeEnabled && ${terminalAccessibleView}`, KeyMod.CtrlCmd | KeyCode.KeyR],

	// rules elsewhere that an accessibility context key decides, in both polarities
	["workbench.action.terminal.focus", "accessibilityModeEnabled && accessibleViewOnLastLine && accessibleViewCurrentProviderId == 'terminal'", KeyMod.CtrlCmd | KeyCode.DownArrow],
	['workbench.action.terminal.scrollToPreviousCommand', 'terminalFocus && !accessibilityModeEnabled', KeyMod.CtrlCmd | KeyCode.UpArrow],
	['search.action.focusSearchFromResults', 'searchViewletVisible && (firstMatchFocus || accessibilityModeEnabled)', KeyMod.CtrlCmd | KeyCode.UpArrow],
	['notification.acceptPrimaryAction', 'accessibilityModeEnabled && (notificationFocus || notificationToastsVisible)', KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA],
	['editor.action.accessibleDiffViewer.next', 'isInDiffEditor', KeyCode.F7],
	['editor.action.scrollLeftHover', 'editorHoverFocused', KeyCode.LeftArrow],
	['editor.action.goToTopHover', 'editorHoverFocused', KeyCode.Home],

	// the four word-navigation rules, which are the only accessibility-gated defaults the keep-set
	// keeps: each names `textInputFocus` positively and then switches itself off under a screen
	// reader on Windows
	['cursorWordLeft', wordNavigation, KeyMod.CtrlCmd | KeyCode.LeftArrow],
	['cursorWordEndRight', wordNavigation, KeyMod.CtrlCmd | KeyCode.RightArrow],
	['cursorWordLeftSelect', wordNavigation, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.LeftArrow],
	['cursorWordEndRightSelect', wordNavigation, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.RightArrow],
	['editor.action.inlineSuggest.acceptNextWord', 'editorWritable && inlineSuggestionVisible && cursorBeforeGhostText && !accessibilityModeEnabled', KeyMod.CtrlCmd | KeyCode.RightArrow],
];

function rule([command, when]: CorpusRule | AccessibilityRule): ITakeoverRule {
	return { command, when: when ? ContextKeyExpr.deserialize(when) : undefined };
}

/** One printed line per rule: the verdict, the command, and the `when` it was judged on. */
function print(rules: readonly (CorpusRule | AccessibilityRule)[]): string {
	return rules
		.map(entry => `${keepReason(rule(entry)) ?? 'drop'}\t${entry[0]}\t${entry[1]}`)
		.sort()
		.join('\n');
}

const expected = [
	'clipboard\tcopyFilePath\teditorFocus',
	'clipboard\tfilesExplorer.cancelCut\tfoldersViewVisible && filesExplorerFocus && !inputFocus && explorerResourceCut',
	'clipboard\tfilesExplorer.copy\tfoldersViewVisible && filesExplorerFocus && !inputFocus && !explorerResourceIsRoot',
	'clipboard\tfilesExplorer.cut\tfoldersViewVisible && filesExplorerFocus && !inputFocus && !explorerResourceIsRoot && explorerResourceWritable',
	'clipboard\tfilesExplorer.paste\tfoldersViewVisible && filesExplorerFocus && !inputFocus && !explorerResourceReadonly',
	'clipboard\tsearch.action.copyMatch\tfileMatchOrMatchFocus',
	'drop\tdeleteFile\tfoldersViewVisible && filesExplorerFocus && !inputFocus',
	'drop\teditor.action.formatDocument\teditorHasDocumentFormattingProvider && editorTextFocus && !editorReadonly',
	'drop\teditor.action.inlineSuggest.commit\tinlineSuggestionVisible && !editorReadonly',
	'drop\tfilesExplorer.openFilePreserveFocus\tfoldersViewVisible && filesExplorerFocus && !inputFocus && !explorerResourceIsFolder',
	'drop\tlist.closeFind\tlistFocus && treeFindOpen',
	'drop\tlist.find\tlistFocus && listSupportsFind',
	'drop\tlist.triggerTypeNavigation\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'drop\toutdent\teditorTextFocus && !editorReadonly && !editorTabMovesFocus',
	'drop\trenameFile\tfoldersViewVisible && filesExplorerFocus && !inputFocus && !explorerResourceIsRoot && explorerResourceWritable',
	'drop\ttab\teditorTextFocus && !editorReadonly && !editorTabMovesFocus',
	"drop\twidgetNavigation.focusNext\tinputFocus && navigableContainerFocused || navigableContainerFocused && treestickyScrollFocused || navigableContainerFocused && !listFocus || navigableContainerFocused && listScrollAtBoundary == 'both' || navigableContainerFocused && listScrollAtBoundary == 'bottom'",
	"drop\twidgetNavigation.focusPrevious\tinputFocus && navigableContainerFocused || navigableContainerFocused && treestickyScrollFocused || navigableContainerFocused && !listFocus || navigableContainerFocused && listScrollAtBoundary == 'both' || navigableContainerFocused && listScrollAtBoundary == 'top'",
	'drop\tworkbench.action.files.save\t',
	'drop\tworkbench.action.navigateBack\t',
	'drop\tworkbench.action.terminal.new\tterminalProcessSupported',
	'drop\tworkbench.action.toggleFullScreen\t',
	'list-navigation\tlist.clear\tlistFocus && !inputFocus && !treestickyScrollFocused && listHasSelectionOrFocus',
	'list-navigation\tlist.collapse\tlistFocus && !inputFocus && !treestickyScrollFocused && (treeElementCanCollapse || treeElementHasParent)',
	'list-navigation\tlist.collapseAll\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.expand\tlistFocus && !inputFocus && !treestickyScrollFocused && (treeElementCanExpand || treeElementHasChild)',
	'list-navigation\tlist.expandSelectionDown\tlistFocus && !inputFocus && !treestickyScrollFocused && listSupportsMultiselect',
	'list-navigation\tlist.focusDown\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.focusFirst\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.focusLast\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.focusPageDown\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.focusUp\tlistFocus && !inputFocus && !treestickyScrollFocused',
	"list-navigation\tlist.scrollDown\tlistFocus && !inputFocus && !treestickyScrollFocused && listScrollAtBoundary != 'bottom' && listScrollAtBoundary != 'both'",
	'list-navigation\tlist.scrollLeft\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.scrollRight\tlistFocus && !inputFocus && !treestickyScrollFocused',
	"list-navigation\tlist.scrollUp\tlistFocus && !inputFocus && !treestickyScrollFocused && listScrollAtBoundary != 'top' && listScrollAtBoundary != 'both'",
	'list-navigation\tlist.select\tlistFocus && !inputFocus && !treestickyScrollFocused',
	'list-navigation\tlist.selectAll\tlistFocus && !inputFocus && !treestickyScrollFocused && listSupportsMultiselect',
	'list-navigation\tlist.stickyScrollselect\ttreestickyScrollFocused',
	'list-navigation\tlist.toggleExpand\tlistFocus && !inputFocus && !treestickyScrollFocused',
	"quick-input\tquickInput.accept\tquickInputType != 'quickWidget' && inQuickInput && !isComposing",
	'quick-input\tworkbench.action.acceptSelectedQuickOpenItem\tinQuickOpen',
	'quick-input\tworkbench.action.closeQuickOpen\tinQuickOpen',
	'quick-input\tworkbench.action.quickOpenNavigateNextInFilePicker\tinQuickOpen && inFilesPicker',
	'quick-input\tworkbench.action.quickPickManyToggle\tinQuickOpen',
	'shared-chord\tactions.find\teditorFocus || editorIsOpen',
	'shared-chord\tcloseFindWidget\tfindWidgetVisible && editorFocus && !isComposing',
	'shared-chord\teditor.action.nextMatchFindAction\teditorFocus && findInputFocussed',
	'shared-chord\tnotifications.hideToasts\tnotificationToastsVisible',
	'shared-chord\tsearch.focus.nextInputBox\t(inSearchEditor && inputBoxFocus) || (searchViewletVisible && inputBoxFocus)',
	'shared-chord\tsearch.focus.previousInputBox\t(inSearchEditor && inputBoxFocus) || (searchViewletVisible && inputBoxFocus)',
	'shared-chord\tworkbench.action.closeActiveEditor\t',
	'shared-chord\tworkbench.action.quickOpen\t',
	'shared-chord\tworkbench.action.showCommands\t',
	`shared-chord\tworkbench.action.terminal.findNext\t${terminalOrFind}`,
	`shared-chord\tworkbench.action.terminal.findPrevious\t${terminalFindBox}`,
	`shared-chord\tworkbench.action.terminal.focusFind\t${terminalOrFind}`,
	`shared-chord\tworkbench.action.terminal.hideFind\t${terminalHideFind}`,
	`shared-chord\tworkbench.action.terminal.paste\t${terminalReady} && terminalFocus`,
	"shared-chord\tworkbench.action.terminal.pastePwsh\tterminalFocus && terminalShellType == 'pwsh' && !accessibilityModeEnabled",
	'shared-chord\tworkbench.action.terminal.toggleTerminal\tterminal.active',
	'shared-chord\tworkbench.action.toggleSidebarVisibility\t',
	'text-input\tcursorHome\ttextInputFocus',
	'text-input\tcursorLeft\ttextInputFocus',
	'text-input\tdeleteLeft\ttextInputFocus',
	'text-input\teditor.action.triggerSuggest\teditorHasCompletionItemProvider && textInputFocus && !editorReadonly',
	'text-input\tscrollLineDown\ttextInputFocus',
].join('\n');

describe('keyboard takeover', () => {

	it('keeps exactly the keep-set of the corpus', () => {
		assert.equal(print(corpus), expected);
	});

	it('does not read a negated guard as a positive one', () => {
		// Every `list.*` rule carries `!inputFocus`. If that counted, the whole default set
		// would survive the filter and the takeover would do nothing at all.
		assert.equal(keepReason({ command: 'someCommand', when: ContextKeyExpr.deserialize(workbenchList) }), undefined);
		assert.equal(keepReason({ command: 'someCommand', when: ContextKeyExpr.deserialize('!textInputFocus') }), undefined);
		assert.equal(keepReason({ command: 'someCommand', when: ContextKeyExpr.deserialize('!inQuickOpen') }), undefined);
	});

	// The shape the corpus above could not ask about until `widgetNavigation.*` was written out in
	// it: the resolver normalizes every `when` to disjunctive normal form, and the two connectives
	// answer "does this rule apply only where a text box has the keyboard" differently.
	it('reads a disjunction as every clause and a conjunction as any term', () => {
		// One clause naming a text box is not a rule that needs one — the other four are ways for
		// `Ctrl+Down` to traverse containers with no box focused at all.
		assert.equal(keepReason({
			command: 'someCommand',
			when: ContextKeyExpr.deserialize('textInputFocus && a || b && c')
		}), undefined);

		// …and a text box named in *every* clause still is. This is `cursorWordLeft`'s shape,
		// `textInputFocus && (!accessibilityModeEnabled || !isWindows)`, which the resolver
		// distributes into two clauses that each name it.
		assert.equal(keepReason({
			command: 'someCommand',
			when: ContextKeyExpr.deserialize('textInputFocus && (!accessibilityModeEnabled || !isWindows)')
		}), 'text-input');

		// The same pair for the quick-input keys, which are classified by the identical walk.
		assert.equal(keepReason({ command: 'someCommand', when: ContextKeyExpr.deserialize('inQuickOpen && a || b') }), undefined);
		assert.equal(keepReason({ command: 'someCommand', when: ContextKeyExpr.deserialize('inQuickOpen && a || inQuickInput && b') }), 'quick-input');
	});

	// A `stock: true` row registers no rule, so `keymap.contribution.ts` never names it to the
	// keep-set and `sharedChordCommands` above is the only thing standing between it and the
	// filter. That is the shape the terminal panel fell through — its keys were in neither list —
	// so the two are held together here rather than by whoever remembers.
	it('names every row the keymap leaves to stock', () => {
		for (const row of rowsFor('gui').filter(candidate => candidate.stock)) {
			assert.equal(keepReason({ command: row.id, when: undefined }), 'shared-chord', `${row.id} is declared stock and dropped`);
		}
	});

	it('keeps a command the keymap declares', () => {
		assert.equal(keepReason({ command: 'git.stage', when: undefined }), undefined);
		registerTakeoverKeepCommand('git.stage');
		assert.equal(keepReason({ command: 'git.stage', when: undefined }), 'keymap');
		assert.deepEqual(takeoverKeepCommands(), ['git.stage']);
	});

	// The user's rule for accessibility: it may be active, but it may not answer a key the keymap
	// registers. These two are that rule, checked rather than argued — the first says which of the
	// accessibility surface the filter lets through at all, the second says none of the survivors
	// lands on one of this frontend's chords without being named here on purpose.
	//
	// **The claim this holds up is `keymap.ts`'s**: that the accessible view and the accessibility
	// help keep upstream's keyboard. Standing every row of the map down inside them was enforced and
	// is only half of it — the other half was false for as long as nothing checked it, because every
	// rule upstream writes for those surfaces is guarded on the two keys the rows stand down on, and
	// the filter read that guard as naming nothing it knew. Take `KeepReason.AccessibilityOverlay`
	// away and eighteen lines below turn back into `drop`.
	it('keeps the two overlays own rules, and nothing else of the accessibility surface', () => {
		assert.equal(print(accessibilitySurface), [
			'accessibility-overlay\teditor.action.accessibilityHelp\t!accessibilityHelpIsShown',
			'accessibility-overlay\teditor.action.accessibilityHelpConfigureAssignedKeybindings\taccessibilityHelpIsShown && accessibleViewHasAssignedKeybindings',
			'accessibility-overlay\teditor.action.accessibilityHelpConfigureKeybindings\taccessibilityHelpIsShown && accessibleViewHasUnassignedKeybindings',
			'accessibility-overlay\teditor.action.accessibilityHelpOpenHelpLink\taccessibilityHelpIsShown',
			'accessibility-overlay\teditor.action.accessibleView\t',
			"accessibility-overlay\teditor.action.accessibleViewAcceptInlineCompletion\taccessibleViewIsShown && accessibleViewCurrentProviderId == 'inlineCompletions'",
			`accessibility-overlay\teditor.action.accessibleViewDisableHint\t(${inAccessibleView}) && accessibleViewVerbosityEnabled`,
			`accessibility-overlay\teditor.action.accessibleViewGoToSymbol\t(${inAccessibleView}) && accessibleViewGoToSymbolSupported`,
			'accessibility-overlay\teditor.action.accessibleViewNext\taccessibleViewIsShown && accessibleViewSupportsNavigation',
			'accessibility-overlay\teditor.action.accessibleViewPrevious\taccessibleViewIsShown && accessibleViewSupportsNavigation',
			'accessibility-overlay\teditor.action.toggleScreenReaderAccessibilityMode\taccessibilityHelpIsShown',
			`accessibility-overlay\tworkbench.action.terminal.accessibleBufferGoToNextCommand\t${terminalAccessibleView}`,
			`accessibility-overlay\tworkbench.action.terminal.accessibleBufferGoToPreviousCommand\t${terminalAccessibleView}`,
			`accessibility-overlay\tworkbench.action.terminal.focusAccessibleBuffer\taccessibilityModeEnabled && terminalFocus && ${terminalReady}`,
			`accessibility-overlay\tworkbench.action.terminal.openDetectedLink\t${terminalAccessibleView}`,
			`accessibility-overlay\tworkbench.action.terminal.runRecentCommand\taccessibilityModeEnabled && terminalFocus && ${terminalReady} || accessibilityModeEnabled && ${terminalAccessibleView}`,
			`accessibility-overlay\tworkbench.action.terminal.scrollToBottomAccessibleView\t${terminalAccessibleView}`,
			`accessibility-overlay\tworkbench.action.terminal.scrollToTopAccessibleView\t${terminalAccessibleView}`,
			'drop\teditor.action.accessibleDiffViewer.next\tisInDiffEditor',
			'drop\teditor.action.announceCursorPosition\teditorTextFocus && accessibilityModeEnabled',
			'drop\teditor.action.goToTopHover\teditorHoverFocused',
			'drop\teditor.action.inlineSuggest.acceptNextWord\teditorWritable && inlineSuggestionVisible && cursorBeforeGhostText && !accessibilityModeEnabled',
			'drop\teditor.action.scrollLeftHover\teditorHoverFocused',
			'drop\tnotification.acceptPrimaryAction\taccessibilityModeEnabled && (notificationFocus || notificationToastsVisible)',
			'drop\tsearch.action.focusSearchFromResults\tsearchViewletVisible && (firstMatchFocus || accessibilityModeEnabled)',
			'drop\tworkbench.action.gotoSymbol\t!accessibilityHelpIsShown && !accessibleViewIsShown',
			"drop\tworkbench.action.terminal.focus\taccessibilityModeEnabled && accessibleViewOnLastLine && accessibleViewCurrentProviderId == 'terminal'",
			`drop\tworkbench.action.terminal.openDetectedLink\tterminalFocus && ${terminalReady}`,
			'drop\tworkbench.action.terminal.scrollToPreviousCommand\tterminalFocus && !accessibilityModeEnabled',
			`text-input\tcursorWordEndRight\t${wordNavigation}`,
			`text-input\tcursorWordEndRightSelect\t${wordNavigation}`,
			`text-input\tcursorWordLeft\t${wordNavigation}`,
			`text-input\tcursorWordLeftSelect\t${wordNavigation}`,
		].join('\n'));
	});

	it('leaves no chord where a surviving accessibility rule and a keymap row both answer, beyond the pair below', () => {
		const keymapChords = new Map<number, string>();
		for (const row of rowsFor('gui')) {
			for (const key of keysFor(row, 'gui')) {
				keymapChords.set(key, row.id);
			}
		}

		const shared = accessibilitySurface
			.filter(entry => keepReason(rule(entry)) !== undefined && keymapChords.has(entry[2]))
			.map(entry => `${entry[0]} / ${keymapChords.get(entry[2])}`);

		// The last two are disjoint by guard rather than by weight: the keymap rows are guarded on
		// `tscodeCanScrollHorizontally`, which `keymap.contribution.ts` publishes only while a list
		// element has the keyboard — and a focused list is exactly when `textInputFocus` is false.
		//
		// `Ctrl+E` is the one where the two really do meet, and it is the shape the whole keep-set
		// exists to make honest: `workbench.action.quickOpen` is a `stock: true` row, so this
		// frontend registers **no** rule for it and both sides of the collision are upstream's own.
		// Which of them answers `Ctrl+E` inside the accessibility help is therefore upstream's
		// resolution, unchanged — where before this it was neither, because both were dropped.
		//
		// Every other accessibility rule either lands on no chord of the map, or is dropped before
		// it can reach one.
		assert.deepEqual(shared, [
			'editor.action.toggleScreenReaderAccessibilityMode / workbench.action.quickOpen',
			'cursorWordLeft / list.scrollLeft',
			'cursorWordEndRight / list.scrollRight',
		]);
	});

	it('keeps every user rule, and only the keep-set of the defaults', () => {
		const rules = [
			{ command: 'workbench.action.files.save', when: undefined, isDefault: true },
			{ command: 'workbench.action.files.save', when: undefined, isDefault: false },
			{ command: 'list.focusDown', when: ContextKeyExpr.deserialize(workbenchList), isDefault: true },
			// A removal from `keybindings.json` is a rule with no keybinding and a `-` command;
			// it is not a default, so it survives to do its work.
			{ command: '-list.focusDown', when: undefined, isDefault: false },
		];

		assert.deepEqual(filterForTakeover(rules).map(r => `${r.command}:${r.isDefault}`), [
			'workbench.action.files.save:false',
			'list.focusDown:true',
			'-list.focusDown:false',
		]);
	});
});
