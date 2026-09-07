/*---------------------------------------------------------------------------------------------
 *  The keys this app answers, declared once.
 *
 *  The *declaration* is one table and the expansion into `when` clauses is a function over it, so
 *  a key is a row rather than a `registerKeybindingRule` call somewhere. This module is the table.
 *
 *  A row is data in upstream's own vocabulary: `KeyCode`/`KeyMod` numbers and a
 *  `ContextKeyExpression` for whatever the scope does not already say. `scope` is symbolic rather
 *  than a `when` string, and `expandGuiScope` is what turns it into one:
 *
 *  | scope | expands to |
 *  | --- | --- |
 *  | `global` | `!inputFocus \|\| tscodeEditorCommands` |
 *  | `view:<viewId>` | `focusedView == <viewId> && (!inputFocus \|\| tscodeEditorCommands)` |
 *  | `editor:<paneId>` | `activeEditor == <paneId> && editorTextFocus` |
 *
 *  **The two editor terms are the same fact:** `!inputFocus` means "the user is not typing" only
 *  where everything that sets the key takes text, and here two surfaces set it while taking none.
 *  A focused Monaco always sets `inputFocus` (`isEditableElement` counts every textarea,
 *  `dom.ts:2448`) — in the viewer and in vim's normal mode the buffer is read-only and the letters
 *  are commands. So the editor row swaps in `editorTextFocus`, which is the term that means "not
 *  typing" over an editor, and every other row is widened by `tscodeEditorCommands`, which is the
 *  same statement made from outside the editor.
 *
 *  A focused **terminal** sets `inputFocus` too, and there the key tells the truth: every byte goes
 *  to the shell, so a `global` row is meant to be dead. The panel's own keys are `whileEditing`
 *  rather than widened, which is the distinction stated once — `tscodeEditorCommands` is a
 *  correction, not a licence.
 *
 *  `whileEditing` drops that half entirely, which is what a key carrying a modifier needs: a
 *  `Ctrl+Down` cannot be mistaken for typing.
 *
 *  **A row can carry its own chord here, and that is not the same thing as `only`.** `guiKeys`
 *  gives a row a chord of this frontend's while it keeps one id, one guard and one meaning — which
 *  is what a terminal wire forces on `Ctrl+Tab`, the same byte as `Tab`. `only` would have said
 *  the row does not exist away from a window at all, and that would be false: it exists, at the
 *  chord a wire can deliver. Both fields **require a `reason`**, because both are divergence.
 *
 *  `only` marks a row a surface cannot carry, and **requires a `reason`**. A row that is
 *  `only: 'tui'` does nothing here and is left out of the keys quick pick, which is a recorded
 *  divergence rather than a silent absence. `only: 'gui'` is the same wall from the other side,
 *  and the terminal panel is what it is for: five rows of upstream's own keys belong to a panel
 *  region a surface that *is* a terminal has nowhere to put.
 *
 *  **And a divergence a row cannot declare at all still has to be written down.** `only` and
 *  `guiKeys` are what this table states; `surfaceDrift` is for what only a measurement can find —
 *  keyed by which of `scripts/keymap-drift.mjs`'s four comparisons differs, so a reason answers
 *  one finding and stops answering anything when the finding goes. The gate holds both
 *  directions: no divergence without a reason, and no reason without a divergence.
 *
 *  Upstream counterpart: none — upstream declares each key beside the feature that owns it, so
 *  there is no single file this stands in for.
 *--------------------------------------------------------------------------------------------*/

import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { EditorContextKeys } from '../../../editor/common/editorContextKeys.js';
import { localize } from '../../../nls.js';
import { ContextKeyExpr, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression } from '../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../platform/contextkey/common/contextkeys.js';
import { SearchContext } from '../../contrib/search/common/constants.js';

//#region --- the ids and keys this table names, and why some of them are named rather than imported
//
// **This module has to load outside the bundler.** The app reads it at boot, and so do the unit
// suite, `docs/keyboard/build.mjs` and the drift gate, all from a plain `node` process — which is
// what makes the declaration checkable instead of merely written down. The workbench modules that
// declare the ids and context keys below all reach a service class with parameter decorators in
// their closure, which no type-stripping runtime parses, so importing them would cost the module
// every reader but the app.
//
// Naming a context key rather than importing its declaration is upstream's own idiom where the
// declaration is not in reach — `scm.contribution.ts` guards `scm.acceptInput` on
// `ContextKeyExpr.has('scmRepository')`, a key `scmInput.ts` creates.

/** `contrib/files/common/files.ts`'s `VIEW_ID`. */
const EXPLORER_VIEW_ID = 'workbench.explorer.fileView';
/** `contrib/files/common/files.ts`'s `TEXT_FILE_EDITOR_ID`. */
const TEXT_FILE_EDITOR_ID = 'workbench.editors.files.textFileEditor';
/** `parts/editor/textResourceEditor.ts`'s pane for untitled text buffers. */
const TEXT_RESOURCE_EDITOR_ID = 'workbench.editors.textResourceEditor';
/** `contrib/scm/common/scm.ts`'s `VIEW_PANE_ID`. */
const SCM_VIEW_ID = 'workbench.scm';
/** `contrib/scm/common/scm.ts`'s `HISTORY_VIEW_PANE_ID`. */
const SCM_HISTORY_VIEW_ID = 'workbench.scm.history';
/** `services/search/common/search.ts`'s `VIEW_ID`. */
const SEARCH_VIEW_ID = 'workbench.view.search';
/** `contrib/terminal/common/terminal.ts`'s `TERMINAL_VIEW_ID`. */
const TERMINAL_VIEW_ID = 'terminal';
/** `SaplingViewPane.ID` — declared on the view pane itself, which is DOM. */
export const SAPLING_VIEW_ID = 'workbench.sapling.smartlogView';

/** The language a markdown preview applies to, as `markdownPreview.contribution.ts` names it. */
const MARKDOWN_LANGUAGE_ID = 'markdown';

/** `workbench/common/contextkeys.ts`'s `ActiveEditorContext`. */
const ACTIVE_EDITOR = 'activeEditor';
/** `workbench/common/contextkeys.ts`'s `EditorAreaFocusContext`. */
const EditorAreaFocus = ContextKeyExpr.has('editorAreaFocus');
/** `workbench/common/contextkeys.ts`'s `FocusedViewContext`. */
const FOCUSED_VIEW = 'focusedView';
/** `workbench/common/contextkeys.ts`'s `ResourceContextKey.LangId`. */
const RESOURCE_LANG_ID = 'resourceLangId';
/** `workbench/common/contextkeys.ts`'s `SideBarVisibleContext`. */
const SideBarVisible = ContextKeyExpr.has('sideBarVisible');
/** `browser/quickaccess.ts`'s `inQuickPickContext`. */
const InQuickPick = ContextKeyExpr.has('inQuickOpen');
/**
 * `contrib/accessibility/browser/accessibilityConfiguration.ts`'s `accessibleViewIsShown` and
 * `accessibilityHelpIsShown` — the two keys `guiModalOverlays` stands this table's rows down on,
 * exported because the keep-set has to read the same two: standing down is only half of "the
 * overlay owns the keyboard", and the other half is upstream's own rules surviving the filter.
 */
export const ACCESSIBILITY_OVERLAY_KEYS = ['accessibleViewIsShown', 'accessibilityHelpIsShown'] as const;
/** `contrib/terminal/common/terminalContextKey.ts`'s `TerminalContextKeys.focusInAny`. */
const TerminalFocused = ContextKeyExpr.has('terminalFocusInAny');
/** `contrib/terminal/common/terminalContextKey.ts`'s `TerminalContextKeys.findFocus`. */
const TerminalFindFocused = ContextKeyExpr.has('terminalFindFocused');
/** `editor/contrib/find/browser/findModel.ts`'s `CONTEXT_FIND_WIDGET_VISIBLE`. */
const FindWidgetVisible = ContextKeyExpr.has('findWidgetVisible');

//#endregion

//#region --- the context keys the rows are guarded on, beyond upstream's own

/** Whether the focused row, or the pane's own box, is something the user can type into. */
export const CanEditInputContext = new RawContextKey<boolean>('tscodeCanEditInput', false,
	localize('tscodeCanEditInput', "Whether the focused row is a text input"));

/**
 * Whether the focused pane's view root filter box is the box being typed into, which `inputFocus`
 * cannot say: the source control pane has two boxes and a commit message has nothing to complete.
 */
export const FilteringContext = new RawContextKey<boolean>('tscodeFiltering', false,
	localize('tscodeFiltering', "Whether the focused pane's filter box is being typed into"));

/**
 * Whether the editor that has the keyboard reads letters as commands rather than as text — the
 * viewer and every vim mode but insert and replace.
 *
 * **Nothing publishes it in this fork, and that is correct.** In tscode it is published from
 * `VimEditorPolicy.typing` by `contrib/vim/tauri/vim.contribution.ts`, which exists to correct a
 * Monaco `inputFocus` that is true whenever an editor has the keyboard, typing or not. This
 * frontend has no Monaco: `Workbench.publishContext` sets `inputFocus` from
 * `overlays.top || pane.editing` (`tui/workbench/workbench.ts:660`), so it already means *typing*
 * and there is nothing to correct. The key stays declared because the rows below are the rows
 * tscode's keymap builds, and it reads `false` forever here — which collapses
 * `!inputFocus || tscodeEditorCommands` to `!inputFocus`, the answer this fork wants.
 *
 * **This is what `!inputFocus` cannot say here.** A focused Monaco always sets `inputFocus`
 * (`isEditableElement` counts every textarea, `dom.ts:2448`), so a `global` row expanded to
 * `!inputFocus` alone is dead in an editor — including in a read-only viewer, where the user is
 * demonstrably not typing and Monaco answers the keystroke with "cannot edit in read only editor"
 * because nothing else claimed it.
 *
 * It names the editor rather than the workbench on purpose. The key `global` actually wants is
 * "nobody is typing", and that is the *pair* `!inputFocus || tscodeEditorCommands`: `inputFocus` is
 * already upstream's answer for every box in the window, and a single key restating it would be a
 * second copy of `isEditableElement` that drifts. So the one surface whose `inputFocus` lies about
 * typing publishes the correction, and everything else keeps upstream's answer — which also makes
 * an editable editor that is not this one default to *typing*, the safe way for it to be wrong.
 */
export const EditorCommandsContext = new RawContextKey<boolean>('tscodeEditorCommands', false,
	localize('tscodeEditorCommands', "Whether the focused editor reads letters as commands"));

/** Whether the focused row has actions to offer, which is what decides `Shift+F10` means anything. */
export const HasContextMenuContext = new RawContextKey<boolean>('tscodeHasContextMenu', false,
	localize('tscodeHasContextMenu', "Whether the focused row has a context menu"));

/**
 * Whether the shown view container has more than one view in it, which is what decides whether
 * moving between them means anything. Ours, because upstream's answer is a click on a header and
 * there is no `when` clause for "there is a second one".
 */
export const MultipleViewsContext = new RawContextKey<boolean>('tscodeMultipleViews', false,
	localize('tscodeMultipleViews', "Whether the shown view container has more than one view"));

/**
 * Whether the focused pane has more content than the columns it was given. Ours, for the same
 * reason `tscodeMultipleViews` is: upstream scopes `list.scrollUp`/`list.scrollDown` out of a list
 * already at the edge through `IListService`, but it leaves the horizontal pair unbound entirely,
 * so there is no upstream key that says "there is something off to the right". It is published
 * from `ListView.contentWidth` measured against the list's own box.
 */
export const CanScrollHorizontallyContext = new RawContextKey<boolean>('tscodeCanScrollHorizontally', false,
	localize('tscodeCanScrollHorizontally', "Whether the focused pane has content past its right-hand edge"));

/**
 * Upstream's own command for showing a user what the keys do, and **this vendored tree registers
 * it nowhere** — its surface upstream is the keybindings editor, which is in the cut table. Named
 * here because the quick pick that answers it leaves itself out of its own list.
 */
export const SHOW_KEYS_ID = 'workbench.action.openGlobalKeybindings';

//#endregion


//#region --- the row

/**
 * Where a key applies, symbolically. Not a `when` clause: how a scope is *spelled* as a guard is
 * `expandGuiScope`'s to decide, so a row states where and never how.
 */
export type KeymapScope = 'global' | `view:${string}` | `editor:${string}`;

/** A surface this table is read for: tscode's window or this terminal frontend. */
export type KeymapSurface = 'tui' | 'gui';


/**
 * The four comparisons `scripts/keymap-drift.mjs` makes when it measures this declaration against
 * a sibling frontend's registrations, named here so the reason a row writes and the finding it
 * answers cannot drift apart. The instrument imports these strings; it does not spell them a
 * second time.
 */
export const KeymapDrift = {
	/** The chords the row is answered on. */
	Chord: 'chord',
	/** The view or pane the row is scoped to. */
	Scope: 'scope',
	/** Whether the row stands down while the user is typing. */
	Typing: 'not while typing',
	/** How many terms the guard carries beyond the scope's own. */
	Guard: 'extra guard terms'
} as const;

export type KeymapDriftKind = typeof KeymapDrift[keyof typeof KeymapDrift];

export interface IKeymapRow {
	/** The command id the row declares a key for. */
	readonly id: string;
	/**
	 * The command `id` stands in for, where `id` is a fork wrapper around someone else's handler —
	 * `tscode.scm.stage → git.stage`. A consumer with nothing to wrap binds this id directly.
	 */
	readonly forwards?: string;
	readonly scope: KeymapScope;
	/** `KeyCode`/`KeyMod` numbers, primary first — the rest are secondary bindings. */
	readonly keys: readonly number[];
	/**
	 * The chords this frontend answers instead, where a terminal wire cannot carry the ones
	 * `keys` names. One id, one guard, one meaning — only the chord splits. Requires a `reason`.
	 */
	readonly guiKeys?: readonly number[];
	/** What the rule carries into the handler, which is how one command takes nine keys. */
	readonly args?: unknown;
	/** Drops the scope's not-typing half, for a key a text input cannot swallow. */
	readonly whileEditing?: boolean;
	/** Everything the scope does not already say. */
	readonly extraWhen?: ContextKeyExpression;
	/**
	 * Upstream already binds this key to this command here, so this frontend declares the row and
	 * registers nothing — a second identical rule would only be noise in the effective set.
	 *
	 * **It says that and nothing more: we do not claim this key, and stock keeps it.** A stock row
	 * therefore carries no `extraWhen`, because there is no rule of ours for one to guard — a
	 * `when` on a row nobody registers is evaluated by nobody. Where a key is wanted somewhere
	 * narrower, it is claimed *there*, by a row of ours scoped to the surface that owns it.
	 */
	readonly stock?: boolean;
	readonly only?: KeymapSurface;
	/** Required whenever `only` is set. Prose, because that is the part a scan cannot write. */
	readonly reason?: string;
	/**
	 * Why a measured registration of this row comes out different from what this table declares,
	 * keyed by which of the four comparisons differs. `only` and `guiKeys` are divergences a row
	 * **declares**, and their `reason` covers them; this is the one a row cannot declare, because
	 * nothing in this file can see it — only `scripts/keymap-drift.mjs` can.
	 *
	 * Two of them exist, and each is legal exactly once written down: a `stock: true` row declares
	 * no guard at all here because it registers no rule to carry one, so a surface with no upstream
	 * rule to inherit has to state a guard this table does not; and a row can stand down for a
	 * widget only a window has.
	 *
	 * The invariant is the one this whole table is kept against, in both directions: `npm run
	 * keymap -- --gate` fails on a measured difference with no reason **and** on a reason with no
	 * measured difference — so a row cannot carry an explanation of something that is no longer
	 * true.
	 */
	readonly surfaceDrift?: { readonly [kind in KeymapDriftKind]?: string };
}

/** The view a `view:` scope names, or `undefined` for any other scope. */
export function viewIdOf(scope: KeymapScope): string | undefined {
	return scope.startsWith('view:') ? scope.slice('view:'.length) : undefined;
}

/** The editor pane an `editor:` scope names, or `undefined` for any other scope. */
export function editorIdOf(scope: KeymapScope): string | undefined {
	return scope.startsWith('editor:') ? scope.slice('editor:'.length) : undefined;
}

/**
 * The rows a surface has to carry: everything but what another surface keeps to itself.
 */
export function rowsFor(surface: KeymapSurface): readonly IKeymapRow[] {
	return KEYMAP.filter(row => row.only === undefined || row.only === surface);
}

/** The chords a surface answers a row on. */
export function keysFor(row: IKeymapRow, surface: KeymapSurface): readonly number[] {
	return surface === 'gui' && row.guiKeys ? row.guiKeys : row.keys;
}

/**
 * The command a row's rule binds in this frontend. A wrapper is bound at its own id only where
 * this frontend has one to run — `implemented` is that set; every other forwarding row binds the
 * command it stands in for, which is already in the tree.
 *
 * It is also the id the takeover keep-set is told about, and the two have to be the same string:
 * the filter drops every stock default not named there, and a rule this file registers is a stock
 * default like any other.
 */
export function guiRuleId(row: IKeymapRow, implemented: ReadonlySet<string>): string {
	return implemented.has(row.id) ? row.id : row.forwards ?? row.id;
}

/**
 * "The user is not typing", which is what a scope's non-`whileEditing` half means and what
 * `!inputFocus` alone gets wrong on the one surface that sets the key without taking text: see
 * `EditorCommandsContext`.
 */
const guiNotTyping = ContextKeyExpr.or(InputFocusedContext.negate(), EditorCommandsContext)!;

/**
 * A row's `when` clause in this frontend's terms — the table in this file's header, as code. It
 * sits beside the table it expands rather than in `keymap.contribution.ts` so that the contract
 * and the assertion over it need nothing but this module.
 */
export function expandGuiScope(row: IKeymapRow): ContextKeyExpression | undefined {
	const editorId = editorIdOf(row.scope);
	if (editorId !== undefined) {
		const activeEditor = editorId === TEXT_FILE_EDITOR_ID
			? ContextKeyExpr.or(ContextKeyExpr.equals(ACTIVE_EDITOR, editorId), ContextKeyExpr.equals(ACTIVE_EDITOR, TEXT_RESOURCE_EDITOR_ID))
			: ContextKeyExpr.equals(ACTIVE_EDITOR, editorId);
		return ContextKeyExpr.and(activeEditor, EditorContextKeys.editorTextFocus, row.extraWhen);
	}

	const viewId = viewIdOf(row.scope);
	return ContextKeyExpr.and(
		viewId === undefined ? undefined : ContextKeyExpr.equals(FOCUSED_VIEW, viewId),
		row.whileEditing ? undefined : guiNotTyping,
		row.extraWhen);
}

/**
 * A row's `when` clause as a surface with no editor panes would have to spell it: one view key,
 * `!inputFocus` unless the row is `whileEditing`, and the row's own extra terms.
 *
 * It is here because the declaration is here and an expansion is part of it — `scripts/keymap-drift.mjs`
 * reads this to say what a measured registration *should* be, and a second expander written
 * elsewhere would be the drift the gate exists to catch.
 *
 * `editor:` has no editor pane to name in that spelling, so it expands as a view — which is the
 * whole reason `scope` is symbolic rather than a `when` string.
 */
export function expandTuiScope(row: IKeymapRow): ContextKeyExpression | undefined {
	const viewId = viewIdOf(row.scope) ?? editorIdOf(row.scope);

	return ContextKeyExpr.and(
		viewId === undefined ? undefined : ContextKeyExpr.equals(FOCUSED_VIEW, viewId),
		row.whileEditing ? undefined : InputFocusedContext.negate(),
		row.extraWhen);
}

/**
 * The overlays drawn over the workbench: the accessible view and the accessibility help are an
 * embedded editor plus a toolbar, and `Tab`
 * inside one reaches that toolbar. They own the keyboard the way the quick pick does — which is
 * why `tscode.stopEditingInput` already stands down inside a quick pick — so no row of this table
 * answers a key while one is up.
 *
 * The `stock: true` chords are unaffected, because this frontend registers no rule for them:
 * `Ctrl+P`, `F1`, `Ctrl+B` and `Ctrl+W` still get out of an overlay on upstream's own rules.
 *
 * **Standing down is only half of it**, and the half this file can enforce. Upstream's own rules
 * for those two surfaces are guarded on the very keys negated here, so the takeover dropped every
 * one of them and the overlays were left with a keyboard that answered nothing —
 * `KeepReason.AccessibilityOverlay` is the other half, over `ACCESSIBILITY_OVERLAY_KEYS`.
 */
const guiModalOverlays = ContextKeyExpr.and(...ACCESSIBILITY_OVERLAY_KEYS.map(key => ContextKeyExpr.has(key).negate()))!;

/**
 * A row's `when` as this frontend registers it: the scope expansion, and the overlays no row
 * applies inside. The pair with `guiRuleId` — between them they are everything the registration
 * decides about a row, which is why both live beside the table rather than in the contribution.
 */
export function guiRuleWhen(row: IKeymapRow): ContextKeyExpression | undefined {
	return ContextKeyExpr.and(expandGuiScope(row), guiModalOverlays);
}

//#endregion


//#region --- the map
//
// Explicit shortcut rows consumed by the app and docs/keyboard/build.mjs.

const EXPLORER = `view:${EXPLORER_VIEW_ID}` as const;
const SCM = `view:${SCM_VIEW_ID}` as const;
const SCM_HISTORY = `view:${SCM_HISTORY_VIEW_ID}` as const;
const SEARCH = `view:${SEARCH_VIEW_ID}` as const;
const SMARTLOG = `view:${SAPLING_VIEW_ID}` as const;
const TERMINAL = `view:${TERMINAL_VIEW_ID}` as const;
const TEXT_EDITOR = `editor:${TEXT_FILE_EDITOR_ID}` as const;

/**
 * A text box that is neither the editor area nor a shell — the surface the two editing keys below
 * belong to. `inputFocus` is upstream's own answer for "something in this window takes text"
 * (`isEditableElement`, `dom.ts:2448`), and the two negations name the two places where that is
 * true and the keystroke is somebody else's: the editor area, where `Ctrl+W` closes the editor,
 * and a terminal, where every byte is the shell's.
 */
const TextBoxFocus = ContextKeyExpr.and(InputFocusedContext, EditorAreaFocus.negate(), TerminalFocused.negate())!;

export const KEYMAP: readonly IKeymapRow[] = [
	// **Find in the editor, at upstream's own chords.** The rule that took `Ctrl+F` away everywhere
	// was about *trees*, where `/` filters the rows and is a better answer than a widget — and an
	// editor is not a tree. The viewer has no `/` of its own either: `/` belongs to the engine and
	// vim is not attached until `V`, so dropping these left a read-only text pane with **no way to
	// search it at all**, which is the one thing on the list with no replacement gesture behind it.
	//
	// Four rows rather than one, because a find that opens and cannot be stepped or closed is not
	// the feature: `Enter`/`F3` and `Escape` are what upstream binds inside the widget, and each is
	// its own command and so its own keep-set entry. `tscode.stopEditingInput` stands out of the
	// way of the last of them, the same move it already makes for the terminal panel's find box.
	{
		id: 'actions.find',
		scope: TEXT_EDITOR,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyF],
		stock: true,
		only: 'gui',
		reason: "Monaco's find widget is upstream's own answer for an editor, and it is a widget: it exists only where there is a window to draw it in. A surface without one searches an editor with vim's `/` once vim is attached and not at all before, which is the divergence this row records rather than removes."
	},
	{
		id: 'editor.action.nextMatchFindAction',
		scope: TEXT_EDITOR,
		whileEditing: true,
		keys: [KeyCode.F3, KeyCode.Enter],
		stock: true,
		only: 'gui',
		reason: "As `actions.find` — stepping a widget that exists only in a window. `Enter` is upstream's second rule for the same command, inside the find box, and it rides along because the keep-set names a command rather than a chord."
	},
	{
		id: 'editor.action.previousMatchFindAction',
		scope: TEXT_EDITOR,
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.F3, KeyMod.Shift | KeyCode.Enter],
		stock: true,
		only: 'gui',
		reason: "As `editor.action.nextMatchFindAction` — the other direction of one gesture, and the same widget."
	},
	{
		id: 'closeFindWidget',
		scope: TEXT_EDITOR,
		whileEditing: true,
		keys: [KeyCode.Escape, KeyMod.Shift | KeyCode.Escape],
		stock: true,
		only: 'gui',
		reason: "As `actions.find` — there is no find widget to close where there was none to open. This is the `Escape` of an editor whose find is open, and `tscode.stopEditingInput` stands down on `findWidgetVisible` so that upstream's rule is the one that answers it."
	},
	{
		id: 'closeReplaceInFilesWidget',
		scope: SEARCH,
		keys: [KeyMod.Shift | KeyCode.KeyH],
		extraWhen: SearchContext.ReplaceActiveKey
	},
	// Not walled either way. Upstream registers the two commands and binds neither, and the pair `Ctrl+Up`/
	// `Ctrl+Down` is already on — `list.scrollUp`/`list.scrollDown` carry it — so the horizontal half
	// arriving unbound is a gap in the set rather than a gesture the mouse already has. The guard is
	// what keeps `Ctrl+Left` word-left everywhere else: the key is published only while a list that
	// genuinely overflows has the keyboard.
	//
	// They do nothing until `workbench.list.horizontalScrolling` is turned on, and this port leaves
	// it at upstream's `false`: while it is off a list's scroll width is clamped to its render width
	// and the offset cannot move, so the rows are registered and inert. That is deliberate — the
	// setting costs the ellipsis on every over-long row and a width measurement per render — and a
	// user who wants the keys turns it on themselves. `docs/TODO.md` carries the rest, including that
	// Source Control opts out at construction and so stays inert either way.
	{
		id: 'list.scrollLeft',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.LeftArrow],
		extraWhen: CanScrollHorizontallyContext
	},
	{
		id: 'list.scrollRight',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.RightArrow],
		extraWhen: CanScrollHorizontallyContext
	},
	{
		id: 'markdown.showPreview',
		scope: TEXT_EDITOR,
		keys: [KeyCode.KeyP],
		extraWhen: ContextKeyExpr.equals(RESOURCE_LANG_ID, MARKDOWN_LANGUAGE_ID),
	},
	{
		id: 'markdown.showPreviewToSide',
		scope: TEXT_EDITOR,
		keys: [KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyV)],
		extraWhen: ContextKeyExpr.equals(RESOURCE_LANG_ID, MARKDOWN_LANGUAGE_ID),
		only: 'tui',
		reason: "The terminal exposes the port's explicit side-preview command separately from its current-group P command."
	},
	{
		id: 'markdown.showSource',
		scope: 'view:workbench.editor.markdownPreview',
		keys: [KeyCode.KeyP],
		only: 'tui',
		reason: "P returns from the native terminal preview to its existing source editor; the window preview owns its own controls."
	},
	// A toast is a thing the window put on screen without being asked, and upstream's answer for it
	// is the same `Escape` that dismisses everything else. The ✕ is a mouse gesture, not a second
	// way to reach the key. Upstream registers the command twice — once at
	// `WorkbenchContrib - 50` for a toast that is merely visible and once at `+ 100` for one that
	// has the keyboard — and both ride along, because the keep-set names a command.
	// `tscode.stopEditingInput` outranks the first of the two, which is exactly right: a box the
	// user is typing in answers `Escape` first, and the toast is still there for the next press.
	{
		id: 'notifications.hideToasts',
		scope: 'global',
		whileEditing: true,
		keys: [KeyCode.Escape],
		stock: true,
		only: 'gui',
		reason: "Upstream's progress and notification surfaces are a window's — a toast is drawn over the workbench by `INotificationService`. Without one there is nothing for this key to hide."
	},
	{
		id: 'sapling.pickRepository',
		scope: SMARTLOG,
		keys: [KeyCode.KeyP],
	},
	{ id: 'scm.setActiveProvider', scope: SCM, keys: [KeyCode.KeyP] },
	{
		id: 'search.action.replace',
		scope: SEARCH,
		keys: [KeyMod.Shift | KeyCode.KeyR],
		extraWhen: SearchContext.ReplaceActiveKey
	},
	{ id: 'search.focus.nextInputBox', scope: SEARCH, whileEditing: true, keys: [KeyMod.CtrlCmd | KeyCode.DownArrow], stock: true },
	{ id: 'search.focus.previousInputBox', scope: SEARCH, whileEditing: true, keys: [KeyMod.CtrlCmd | KeyCode.UpArrow], stock: true },
	{ id: 'toggleSearchCaseSensitive', scope: SEARCH, keys: [KeyCode.KeyC] },
	{
		id: 'toggleSearchPreserveCase',
		scope: SEARCH,
		keys: [KeyCode.KeyP],
		extraWhen: SearchContext.ReplaceActiveKey
	},
	{ id: 'toggleSearchRegex', scope: SEARCH, keys: [KeyCode.KeyR] },
	{ id: 'toggleSearchWholeWord', scope: SEARCH, keys: [KeyCode.KeyW] },

	// `paneview.ts` binds a focused header's `LeftArrow`/`RightArrow` to collapsing and expanding
	// the pane, idempotently rather than as a toggle. The keyboard model here focuses the view
	// rather than its header, and the bare arrows belong to the tree inside it, so the pair arrives
	// shifted. `tscodeMultipleViews` is the condition exactly: a view is collapsible only where its
	// container has a second one to give the rows to.
	{
		id: 'tscode.collapseView',
		scope: 'global',
		keys: [KeyMod.Shift | KeyCode.LeftArrow],
		extraWhen: ContextKeyExpr.and(EditorAreaFocus.negate(), MultipleViewsContext)
	},
	{
		id: 'tscode.expandView',
		scope: 'global',
		keys: [KeyMod.Shift | KeyCode.RightArrow],
		extraWhen: ContextKeyExpr.and(EditorAreaFocus.negate(), MultipleViewsContext)
	},

	// The `/` box's own `Tab`, declared once for all three panes that have one — the completion is
	// one file and this is one rule, rather than a pair per pane. **The one bare `Tab` this frontend
	// still registers**, and it is the one place where giving the key back to browser traversal would
	// buy nothing: the box owns its keyboard and has no traversal to hand back. `tscodeFiltering` is
	// what hands the key over from view cycling and `!editorAreaFocus` what keeps it from
	// `nextEditor` — both left alone here, because the row is one row.
	{
		id: 'tscode.completeFilter',
		scope: 'global',
		whileEditing: true,
		keys: [KeyCode.Tab],
		extraWhen: ContextKeyExpr.and(FilteringContext, EditorAreaFocus.negate())
	},
	{
		id: 'tscode.completeFilterBack',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.Tab],
		extraWhen: ContextKeyExpr.and(FilteringContext, EditorAreaFocus.negate())
	},
	// **A focused area answers with its own keys**, and these two are where that invariant had a
	// hole. `Ctrl+W` erases the word before the caret in a text box and `Ctrl+U` empties it, over
	// the offsets `inputEditing.ts` declares. Nothing here answered either, so `Ctrl+W` typed into
	// the explorer's `/` box reached
	// upstream's rule for `workbench.action.closeActiveEditor`, which carries no `when` at all, and
	// **closed an editor tab**.
	//
	// Claiming the key on the surface that owns it is the whole of the fix, and what makes the
	// claim win is `KEYMAP_WEIGHT` — at equal weight the resolver's tie-break is the command id's
	// *spelling*, and `tscode.` loses to `workbench.`. The `closeActiveEditor` row below therefore
	// stays `stock` and declares nothing: outside a box the key is upstream's and means what it
	// always meant.
	{
		id: 'tscode.deleteAllLeft',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyU],
		extraWhen: TextBoxFocus,
		only: 'gui',
		reason: "Only the *mechanism* is this frontend's. Here a box is a DOM element the window-level resolver reaches, so a rule is the only way to have the key at all; a surface that owns its box's value answers the keystroke inside the box instead, and could not use a rule anyway — a rule for it would have to be scoped to `inputFocus`, which every other row is scoped out of. What is not the mechanism is how far back the deletion goes, and that is `inputEditing.ts`'s."
	},
	{
		id: 'tscode.deleteWordLeft',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyW],
		extraWhen: TextBoxFocus,
		only: 'gui',
		reason: "As `tscode.deleteAllLeft` — the other of the same two keys, and the same reason a rule is the only shape the key can have here."
	},
	{
		id: 'tscode.editFile',
		scope: TEXT_EDITOR,
		keys: [KeyCode.KeyE],
		only: 'tui',
		reason: "Handing the file to `$EDITOR` is a terminal's own gesture — there is a terminal already on screen to hand it to. Not part of this frontend (`docs/ARCHITECTURE.md`, *What the keyboard commits to*); it does nothing here and the keys quick pick does not list it."
	},
	{
		id: 'tscode.editInput',
		scope: 'global',
		keys: [KeyCode.KeyI],
		extraWhen: CanEditInputContext
	},
	{
		id: 'tscode.file.edit', scope: TEXT_EDITOR, keys: [KeyCode.KeyV],
	},
	{
		id: 'tscode.file.toggleFold', forwards: 'editor.toggleFold', scope: TEXT_EDITOR, keys: [KeyCode.KeyF],
	},
	{ id: 'tscode.file.toggleWordWrap', forwards: 'editor.action.toggleWordWrap', scope: TEXT_EDITOR, keys: [KeyCode.KeyW] },

	// `0` continues the digits the activity bar draws, and it is one key for both directions:
	// upstream's own pair is `Ctrl+1`/`Ctrl+0`. Which of the two rules applies is `editorAreaFocus`
	// against its own negation, the same split `Tab` is on — so the way *out* of the part that has
	// the keyboard is always the one that is live.
	{
		id: 'tscode.focusEditorArea',
		forwards: 'workbench.action.focusActiveEditorGroup',
		scope: 'global',
		keys: [KeyCode.Digit0],
		extraWhen: EditorAreaFocus.negate()
	},
	// The four cycling rows, and the one place a row carries a chord of its own here: `Ctrl+Tab`
	// rather than the bare `Tab` a wire can deliver, one command either way.
	{
		id: 'tscode.focusNextView',
		scope: 'global',
		whileEditing: true,
		keys: [KeyCode.Tab],
		guiKeys: [KeyMod.CtrlCmd | KeyCode.Tab],
		extraWhen: ContextKeyExpr.and(FilteringContext.negate(), EditorAreaFocus.negate(), MultipleViewsContext),
		reason: "**No terminal can deliver `Ctrl+Tab`** — `Tab` is already the control byte for `I`, so there is nowhere for the modifier to go on the wire. The chord splits and the command does not. What the modifier buys is the two places bare `Tab` was already spoken for and the rows were dead: a focused editor, where Monaco's own `tab` outranks a workbench rule, and a text box, where the key is the browser's. And what it gives back is bare `Tab` itself — browser focus traversal is a *default action*, which no resolver filters, so the port never controlled it and only ever half-took it: swallowed where a row matched, walking to the next button where none did. Handing it back makes traversal whole again rather than half-lost, which is the accessibility regression this port had recorded and not repaired."
	},
	{
		id: 'tscode.focusPreviousView',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.Tab],
		guiKeys: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab],
		extraWhen: ContextKeyExpr.and(FilteringContext.negate(), EditorAreaFocus.negate(), MultipleViewsContext),
		reason: "As `tscode.focusNextView` — the other direction of one gesture, and the same wire."
	},

	// Two rows rather than one, because the two bindings carry different guards:
	// `Ctrl+C` has to work while a text input has focus, which is what every single-character rule
	// is kept out of.
	{
		id: 'tscode.quit',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyC],
		only: 'tui',
		reason: "`Ctrl+C` is copy in a window, and a terminal program is quit where a window is closed. Not part of this frontend (`docs/ARCHITECTURE.md`, *What the keyboard commits to*)."
	},
	{
		id: 'tscode.quit',
		scope: 'global',
		keys: [KeyCode.KeyQ],
		only: 'tui',
		reason: "As above — `Q` is the deliverable half of the same command, and the user ruled the whole command not ported.",
	},

	{
		id: 'tscode.sapling.refresh',
		forwards: 'sapling.refresh',
		scope: SMARTLOG,
		keys: [KeyCode.KeyR],
	},

	// **No terminal can deliver `Ctrl+Enter`** — it is the same byte as `Enter` — so upstream's own
	// rule can never match there, and `Enter` is what the message box has spare. The user ruled the
	// same key here for parity (`docs/ARCHITECTURE.md`, *What the keyboard commits to*): `Enter` commits, `Shift+Enter` is the newline the
	// input widget writes with no rule of its own. The view scope plus `inputFocus` are the actual
	// ownership edge: Return is claimed only while the SCM input is being edited.
	{
		id: 'tscode.scm.acceptInput',
		forwards: 'scm.acceptInput',
		scope: SCM,
		whileEditing: true,
		keys: [KeyCode.Enter],
		extraWhen: ContextKeyExpr.and(InputFocusedContext, ContextKeyExpr.has('scmRepository'))
	},
	{ id: 'tscode.scm.cycleSortKey', scope: SCM, keys: [KeyCode.KeyS] },
	{ id: 'tscode.scm.filter', scope: SCM, keys: [KeyCode.Slash] },
	{ id: 'tscode.scm.refresh', forwards: 'git.refresh', scope: SCM, keys: [KeyCode.KeyR] },
	// `A` rather than `S`, which the sort key already has.
	{ id: 'tscode.scm.stage', forwards: 'git.stage', scope: SCM, keys: [KeyCode.KeyA] },
	{ id: 'tscode.scm.toggleViewMode', scope: SCM, keys: [KeyCode.KeyV] },
	{ id: 'tscode.scm.unstage', forwards: 'git.unstage', scope: SCM, keys: [KeyCode.KeyU] },
	{ id: 'tscode.scmGraph.refresh', forwards: 'workbench.scm.action.graph.refresh', scope: SCM_HISTORY, keys: [KeyCode.KeyR] },
	{ id: 'tscode.search.filter', scope: SEARCH, keys: [KeyCode.Slash] },

	{
		id: 'tscode.showContextMenu',
		scope: 'global',
		keys: [KeyMod.Shift | KeyCode.F10],
		extraWhen: HasContextMenuContext,
		only: 'tui',
		reason: "`Shift+F10` already opens the context menu here without a rule: `listWidget.ts`'s `onContextMenu` reads it off the list's own DOM node and stops the event, and `editor.action.showContextMenu` answers it in an editor. A rule of ours would shadow the editor's and could never reach a focused list, so the row is `only: 'tui'` — it is for a surface where no widget answered it first."
	},

	// One command for nine keys, each rule carrying the container it means as its argument — which
	// is how a command that needs a choice takes one with no picker to choose in. `Ctrl`+digit,
	// which upstream binds the per-view commands to, is not on a terminal's wire at all.
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit1], args: 0 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit2], args: 1 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit3], args: 2 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit4], args: 3 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit5], args: 4 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit6], args: 5 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit7], args: 6 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit8], args: 7 },
	{ id: 'tscode.showViewContainer', scope: 'global', keys: [KeyCode.Digit9], args: 8 },
	{ id: 'workbench.action.findInFiles', scope: 'global', whileEditing: true, keys: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF] },
	// A box on the floating layer sets `inputFocus` too — that is what keeps every single-character
	// rule out of a picker — so this rule and upstream's `workbench.action.closeQuickOpen` are both
	// on `Escape` under conditions that hold together. `inQuickOpen` is the key upstream tells them
	// apart with.
	//
	// The two terminal keys are the same move for the terminal panel's own `Escape`, which has two
	// owners and neither is this rule: `workbench.action.terminal.hideFind` closes the find widget
	// from a focused terminal, and `simpleFindWidget.ts`'s **keyup** closes it from inside the find
	// box — a keyup that never arrives if a keydown rule has already moved the focus off the
	// widget. Standing down is also what lets `Escape` reach the shell at all: a chord this rule
	// answers is not in `commandsToSkipShell`, so `terminalInstance.ts` hands it to the process.
	//
	// `findWidgetVisible` is the editor's own version of that, and it has to be here rather than
	// left to weight: upstream registers `closeFindWidget` at `KeybindingWeight.EditorContrib`,
	// which is below `KEYMAP_WEIGHT`, so this rule would answer the key first and leave the widget
	// open over an editor whose text no longer has the keyboard.
	{
		id: 'tscode.stopEditingInput',
		scope: 'global',
		whileEditing: true,
		keys: [KeyCode.Escape],
		extraWhen: ContextKeyExpr.and(InputFocusedContext, InQuickPick.negate(), TerminalFocused.negate(), TerminalFindFocused.negate(), FindWidgetVisible.negate()),
		surfaceDrift: {
			[KeymapDrift.Guard]: "Three of the five terms name widgets only a window draws: `findWidgetVisible` is Monaco's find, `terminalFindFocused` is the panel's, and `terminalFocusInAny` is a shell that owns every byte. A surface that *is* the terminal has none of the three, and its find is the outer one's. The two terms that survive anywhere are the same two: a focused box, and not inside a quick pick."
		}
	},

	// This row carried `editorAreaFocus && editorIsOpen`, and the key closed a tab from inside the
	// explorer's `/` box for as long as it did — which is what a guard that is documentation rather
	// than behaviour looks like from the outside: correct on the page, absent in the window.
	{
		id: 'workbench.action.closeActiveEditor',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyW],
		stock: true,
		surfaceDrift: {
			[KeymapDrift.Guard]: "`stock: true` is this frontend declaring that it does not claim the key, so it registers no rule and there is no `when` of ours for a guard to sit on — upstream's own rule answers `Ctrl+W` and carries none. A surface with no upstream rule to inherit has to register this one itself, and must therefore state where the key applies: `editorAreaFocus && editorsVisible`. One key, one meaning, and the divergence is only in who owns the registration."
		}
	},
	{ id: 'workbench.files.action.collapseExplorerFolders', scope: EXPLORER, keys: [KeyCode.KeyC] },
	{
		id: 'workbench.action.createTerminalEditor', scope: 'global', keys: [KeyCode.KeyT],
	},

	// Upstream binds neither resize command: the gesture is a sash, and the commands exist for a
	// `keybindings.json` to reach. Their nearest neighbours by meaning are `zoomIn`/`zoomOut` at
	// `Ctrl+=`/`Ctrl+-`, and a terminal has a control byte for a letter and nothing else — so the
	// two characters that pair carries arrive on their own.
	{
		id: 'workbench.action.decreaseViewSize',
		scope: 'global',
		keys: [KeyCode.Minus],
		extraWhen: SideBarVisible
	},
	{
		id: 'workbench.action.increaseViewSize',
		scope: 'global',
		keys: [KeyCode.Equal],
		extraWhen: SideBarVisible
	},
	{
		id: 'workbench.action.focusSideBar',
		scope: 'global',
		keys: [KeyCode.Digit0],
		extraWhen: EditorAreaFocus,
	},

	// The cycling gesture means "the next thing in the part that has the keyboard", and the two
	// rules that say so are told apart by `editorAreaFocus` against its own negation — the same
	// split `0` is on.
	{
		id: 'workbench.action.nextEditor',
		scope: 'global',
		whileEditing: true,
		keys: [KeyCode.Tab],
		guiKeys: [KeyMod.CtrlCmd | KeyCode.Tab],
		extraWhen: EditorAreaFocus,
		reason: "As `tscode.focusNextView`, and this half of the split repairs a key the port was **taking away from the shell**: `workbench.action.nextEditor` is in `commandsToSkipShell` (`contrib/terminal/common/terminal.ts:622`), so while it sat on bare `Tab` a focused terminal editor resolved the key to the workbench and the shell never saw a completion. On `Ctrl+Tab` the workbench keeps the cycle and `Tab` reaches the process. Upstream's own `Ctrl+Tab` is the MRU picker (`quickOpenPreviousRecentlyUsedEditorInGroup`), which the takeover drops with every other unlisted default and which this deliberately does not forward to: an overlay you hold a modifier through is a second interaction model, and this gesture answers with one command by design."
	},
	{
		id: SHOW_KEYS_ID,
		scope: 'global',
		keys: [KeyMod.Shift | KeyCode.Slash, KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyS)]
	},
	{
		id: 'workbench.action.previousEditor',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.Tab],
		guiKeys: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab],
		extraWhen: EditorAreaFocus,
		reason: "As `workbench.action.nextEditor` — the other direction of one gesture, and the same wire."
	},
	{ id: 'workbench.action.quickOpen', scope: 'global', whileEditing: true, keys: [KeyMod.CtrlCmd | KeyCode.KeyP, KeyMod.CtrlCmd | KeyCode.KeyE], stock: true },
	{ id: 'workbench.action.replaceInFiles', scope: SEARCH, keys: [KeyCode.KeyH] },
	{ id: 'workbench.action.search.toggleQueryDetails', scope: SEARCH, keys: [KeyCode.KeyD] },
	{ id: 'workbench.action.showCommands', scope: 'global', whileEditing: true, keys: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, KeyCode.F1], stock: true },

	// The terminal panel's own keys, at upstream's chords and on upstream's own rules — every row
	// `stock: true`, so this frontend registers nothing and the row's whole job is to put the
	// command in the takeover's keep-set.
	//
	// **A dropped rule here is not an unbound key, it is a swallowed one.** `terminalInstance.ts`
	// hands a keystroke to the workbench only where `softDispatch` finds a command that
	// `commandsToSkipShell` names; all five ids are in that list, so a rule the takeover filtered
	// out resolves to nothing, xterm keeps the key, and the shell gets it instead.
	//
	// `whileEditing` throughout: xterm draws a textarea, so a focused terminal sets `inputFocus`
	// and the `!inputFocus` half of either scope would be dead exactly where these have to work.
	{
		id: 'workbench.action.terminal.findNext',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyCode.F3],
		stock: true,
		only: 'gui',
		reason: "The panel is a window's, and a surface that *is* the terminal has nothing to step a search through. `F3` is upstream's own chord; the `Shift+Enter` its second rule adds inside the find box rides along, because the keep-set names a command rather than a chord."
	},
	{
		id: 'workbench.action.terminal.findPrevious',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.F3],
		stock: true,
		only: 'gui',
		reason: "As `findNext` — the other half of the same gesture, over a panel only a window has. The find box's `Enter` rides along on the same keep-set entry."
	},
	{
		id: 'workbench.action.terminal.focusFind',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyF],
		stock: true,
		only: 'gui',
		reason: "There is no panel to search without a window to draw one in. `Ctrl+F` is the one this port took away everywhere else, and this row is not a decision to give it back: the rule that replaced it was about **trees**, which `/` can filter, and a terminal is not one — `/` there is a character the shell owns. So this is upstream's binding, inside a widget that already had it."
	},
	{
		id: 'workbench.action.terminal.hideFind',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyCode.Escape, KeyMod.Shift | KeyCode.Escape],
		stock: true,
		only: 'gui',
		reason: "There is no find widget to close where the panel itself is absent. This is the `Escape` of a focused *terminal*; the find box's own is `simpleFindWidget.ts`'s keyup, which `tscode.stopEditingInput` now stands out of the way of rather than answering first."
	},
	{
		id: 'workbench.action.terminal.toggleTerminal',
		scope: 'global',
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.Backquote],
		stock: true,
		only: 'gui',
		reason: "There is no panel region to show or hide without a window that has one. `global` rather than `view:terminal` because half of what the key does is reach a panel that is not on screen — and `whileEditing`, because the other half is pressing it *in* the terminal to put it away."
	},

	// The clipboard, the groups and the pages — the rest of the panel's `commandsToSkipShell` keys,
	// and the same swallowing as the find pair. `Ctrl+V` was the loud one: the paste never happened
	// *and* the byte never reached the shell, leaving the right-click menu as the only way in.
	//
	// **The terminal is the only surface with a paste key of this table's, which is not the same as
	// the only one in the app.** Everywhere the user can type — a text box, the editor's textarea,
	// vim's insert mode — the browser itself delivers the clipboard, as a `paste` event on whatever
	// holds focus. It fires **no `keydown`**, so a clipboard's bytes cannot reach the keybinding
	// resolver, and `editor/contrib/clipboard/browser/clipboard.ts` declines to bind the chord
	// off-native for that very reason. That is what makes the whole defect class (a paste arriving
	// as the same bytes as typing, so a clipboard beginning `t` opens a shell and feeds it the
	// rest) structurally impossible here rather than merely absent: there is no route from pasted
	// text to a command.
	//
	// **What that argument does not cover is a clipboard that is not text.** Upstream's explorer
	// binds `Ctrl+C` and `^filesExplorer.paste` over *files*, so "a tree has no editable to paste
	// into" says nothing about them, and the pair is a feature of this frontend either way. Those
	// are upstream's own rules and no row of this table claims their
	// chords; `KeepReason.Clipboard` is what keeps them, and it carries why.
	//
	// A terminal is a typing surface with no editable of its own, which is why it needs the key: the
	// chord is claimed, the keydown is consumed, and the paste is performed by `terminal.paste`
	// through upstream's `shouldPasteTerminalText` — the multi-line warning and bracketed-paste
	// mode — rather than by xterm's own raw `paste` handler.
	{
		id: 'workbench.action.terminal.copySelection',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC],
		stock: true,
		only: 'gui',
		reason: "Where the app *is* a terminal the selection belongs to the terminal the user is already running it in, and so does copying it — there is no selection of ours to read and no clipboard to write. Here the selection is xterm's inside a window we own, and `Ctrl+Shift+C` is upstream's own chord for it."
	},
	{
		id: 'workbench.action.terminal.copyAndClearSelection',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyC],
		stock: true,
		only: 'gui',
		reason: "As `copySelection`, and this is the Windows half of the pair. **It is not a claim on `Ctrl+C`**: upstream guards it on `terminalFocus && textSelected`, so with nothing selected the key is the shell's interrupt exactly as before — which is also why it says nothing about `tscode.quit`, a different command on a different surface."
	},
	{
		id: 'workbench.action.terminal.paste',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.KeyV, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV],
		stock: true,
		only: 'gui',
		reason: "A surface running inside another terminal needs no key of its own: the paste is performed by the host and arrives as a bracketed-paste sequence, answered through upstream's own `shouldPasteTerminalText`. Here the paste is ours to perform, and `Ctrl+V` is upstream's Windows chord for it — answered by `paste`, or, in a PowerShell terminal, by `pastePwsh`, which upstream registers on the same chord and the keep-set names alongside it."
	},
	{
		id: 'workbench.action.terminal.focusNext',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.PageDown],
		stock: true,
		only: 'gui',
		reason: "Terminal groups are the panel's, and there are none without a panel. Where a terminal is an editor tab holding one child, stepping between them is `workbench.action.nextEditor`, which is a row of its own."
	},
	{
		id: 'workbench.action.terminal.focusPrevious',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.CtrlCmd | KeyCode.PageUp],
		stock: true,
		only: 'gui',
		reason: "As `focusNext` — the other direction of one gesture, and the same absent groups."
	},
	{
		id: 'workbench.action.terminal.scrollUpPage',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.PageUp],
		stock: true,
		only: 'gui',
		reason: "A surface that draws a child's viewport into a rectangle of its frame keeps no scrollback view of its own to page through — the scrollback is then the outer terminal's, and so is the gesture for it."
	},
	{
		id: 'workbench.action.terminal.scrollDownPage',
		scope: TERMINAL,
		whileEditing: true,
		keys: [KeyMod.Shift | KeyCode.PageDown],
		stock: true,
		only: 'gui',
		reason: "As `scrollUpPage` — the other direction of one gesture, over a scrollback that is not ours to draw."
	},

	{ id: 'workbench.action.toggleSidebarVisibility', scope: 'global', whileEditing: true, keys: [KeyMod.CtrlCmd | KeyCode.KeyB], stock: true },
	{ id: 'workbench.scm.action.graph.pickRepository', scope: SCM_HISTORY, keys: [KeyCode.KeyP] }
];

//#endregion
