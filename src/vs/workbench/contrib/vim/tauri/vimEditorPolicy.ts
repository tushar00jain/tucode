/*---------------------------------------------------------------------------------------------
 *  The modal editor's policy, declared once and drawn nowhere.
 *
 *  A text editor opens as a **viewer**: typing does nothing and the editor-scoped letters of the
 *  shared keymap — `F`, `W`, `P`, `V`, `Tab` — answer. `V` attaches vim in **normal** mode, from
 *  where the engine's own modes follow; `:q` detaches back to the viewer, and `V` itself does not,
 *  because once vim is attached `V` is vim's own visual-line. **Insert is
 *  the only state in which typing reaches the buffer**, and it is the only state in which those
 *  same letters are dead, because in it the editor consumes the key before the workbench sees it.
 *
 *  **This module is that model and nothing else** — the state set, what moves between the states,
 *  and who consumes a key in each. It is the condition the modal editor exists on
 *  (`docs/ARCHITECTURE.md`, *What the keyboard commits to*): the model is written once so that
 *  changing it later is one edit in one file. Only what is *beneath* the policy names an editor at
 *  all — an `IVimSession` binds the engine to one, and that is where the pixels live.
 *
 *  So nothing here may name the DOM, Monaco, a terminal, a key encoding or a service. The key
 *  type is a parameter for exactly that reason: here it is Monaco's `IKeyboardEvent`, and the
 *  policy has no opinion about it.
 *
 *  **Which keys escape is a question about the state, not about the editor.** `Ctrl+W` is vim's
 *  erase-word while typing and the engine's own declared no-op in normal mode; `Ctrl+B` is a page
 *  up in normal mode and nothing at all in insert. A flat set of escaping commands — upstream's own
 *  `commandsToSkipShell` is that shape — has to lose one of those two, so the engine's claims per
 *  state are stated here instead (`ENGINE_CHORDS`) and they settle the contested chords.
 *
 *  Upstream counterpart: none — VS Code's editor has no modal state, so there is no file this
 *  stands in for.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
// `IDisposable` is imported as a type on its own so this module loads under the type-stripping
// `node` its unit test runs in: a named import it cannot erase is one it looks for at runtime.
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

/** What the engine says it is in, which is what vim's own `showmode` says. */
export type VimEngineMode = 'normal' | 'insert' | 'replace' | 'visual';

/** Every state a text editor can be in. `viewer` is the one the editor opens in. */
export type VimEditorState = 'viewer' | VimEngineMode;

/**
 * A key as the engine spells it — `<C-w>`, `<Esc>`, `<Tab>`, `x`. Vim's own notation is the
 * vocabulary the engine itself uses, so the escape table is keyed on it rather than on a
 * `KeyCode` or a control byte, neither of which this module is allowed to name.
 */
export type VimKeyName = string;

/**
 * `vim.js`'s own `context` field, which is what decides whether one of its rows is live.
 *
 * A row with no `context` matches `normal` and `visual` and **never insert**: `commandMatches`
 * skips every row whose context is not literally `'insert'` once the engine is typing
 * (`vim.js:3627`). That asymmetry is the whole reason this table exists.
 */
type VimKeyContext = 'normal' | 'insert' | 'visual';

/** A row `vim.js` gives no `context`. */
const MOVING: readonly VimKeyContext[] = ['normal', 'visual'];
/** A contextless row plus an `insert` one — the chord means something wherever vim is attached. */
const EVERYWHERE: readonly VimKeyContext[] = ['normal', 'visual', 'insert'];
const INSERT_ONLY: readonly VimKeyContext[] = ['insert'];
/** `context: 'normal'` and an `insert` counterpart, with nothing in visual. */
const NORMAL_AND_INSERT: readonly VimKeyContext[] = ['normal', 'insert'];

/**
 * **Every chord the engine binds, and where.** Transcribed from `vim.js`'s `defaultKeymap` (the
 * line numbers are its) plus `IVimSession.handleKey`'s own insert-mode keys, which are the three
 * named keys typing means and are as much a claim on the keyboard as a keymap row is.
 *
 * Only chords are here. A bare printable character needs no row: in normal and visual it is a
 * motion, an operator or a count, and in insert it is the buffer — the engine claims it in every
 * attached state, which is what `vimClaimsKey` says without a table.
 *
 * A chord the engine does **not** bind is absent rather than false, and `<C-w>` in normal mode is
 * the row that makes the difference visible: its keymap entry is `type: 'idle'`, whose comment is
 * "ignore C-w in normal mode" — the engine declaring it wants the chord to do nothing, which is
 * not the same as wanting it.
 */
const ENGINE_CHORDS: ReadonlyMap<VimKeyName, readonly VimKeyContext[]> = new Map([
	// Leaving a mode, which is the one gesture no state may lose. `handleEsc` runs ahead of the
	// keymap (`vim.js:932`) and the three aliases are keyed to it in both contexts (`:92`-`:97`).
	['<Esc>', EVERYWHERE],
	['<C-[>', EVERYWHERE],
	['<C-c>', EVERYWHERE],
	['<C-Esc>', EVERYWHERE],

	// The arrows and their named neighbours, mapped onto the letter motions (`:77`-`:105`).
	['<Left>', MOVING],
	['<Right>', MOVING],
	['<Up>', MOVING],
	['<Down>', MOVING],
	['<Space>', MOVING],
	['<S-Space>', MOVING],
	['<C-Space>', MOVING],
	['<S-BS>', MOVING],
	['<C-BS>', MOVING],
	['<Del>', MOVING],
	['<Home>', MOVING],
	['<End>', MOVING],
	['<PageUp>', MOVING],
	['<PageDown>', MOVING],

	// The three keys typing is made of, beside what they mean as motions: `<BS>` is `h` (`:84`) and
	// a delete to the left, `<CR>` is `j^` (`:106`) and a newline, `<Tab>` is the engine's nowhere
	// and an indent. `<Ins>` is `i` (`:107`) and the overwrite toggle (`:108`).
	['<BS>', NORMAL_AND_INSERT],
	['<CR>', NORMAL_AND_INSERT],
	['<Tab>', INSERT_ONLY],
	['<Ins>', NORMAL_AND_INSERT],

	// Moving and scrolling: `j`/`k` (`:90`, `:91`), the pages (`:131`, `:132`), the jump list
	// (`:201`, `:202`) and the line scrolls (`:203`, `:204`).
	['<C-n>', MOVING],
	['<C-p>', MOVING],
	['<C-f>', MOVING],
	['<C-b>', MOVING],
	['<C-i>', MOVING],
	['<C-e>', MOVING],
	['<C-y>', MOVING],

	// Blockwise visual (`:217`, `:218`) and the number increments (`:245`, `:246`).
	['<C-v>', MOVING],
	['<C-q>', MOVING],
	['<C-a>', MOVING],
	['<C-x>', MOVING],

	// The chords that mean one thing outside insert and another inside it: half-page scroll against
	// the indent pair (`:133`, `:248`; `:134`, `:196`), the jump list against one normal command
	// (`:202`, `:237`), and undo against putting a register (`:233`, `:236`).
	['<C-d>', EVERYWHERE],
	['<C-u>', EVERYWHERE],
	['<C-o>', EVERYWHERE],
	['<C-r>', EVERYWHERE],

	// Erase the word before the cursor (`:197`) — and in normal mode the `idle` row (`:199`).
	['<C-w>', INSERT_ONLY],
	// Indent, which the engine binds in insert and nowhere else (`:247`).
	['<C-t>', INSERT_ONLY]
] satisfies readonly [VimKeyName, readonly VimKeyContext[]][]);

// `<C-c>`, `<C-v>` and `<C-x>` are rows of the table above and are never contested here:
// `editor/contrib/clipboard/browser/clipboard.ts` registers the clipboard chords only when
// `platform.isNative`, which this port never is, so no command resolves for them at all.

/**
 * The commands that outrank the engine in **every** state, chords and all. They are how a user
 * gets out of an editor that consumes nearly every key, so they cannot be a thing you have to
 * leave insert mode to reach — and both are chords the engine does bind (`<C-p>` is `k`, `<C-e>`
 * scrolls a line), which is why they need saying rather than falling out of the table.
 *
 * Commands rather than chords, so that each one's secondary binding — `Ctrl+E` for the quick pick,
 * `F1` for the command palette — is covered by the same row it belongs to.
 */
export const ALWAYS_WORKBENCH_COMMANDS: ReadonlySet<string> = new Set([
	'workbench.action.quickOpen',
	'workbench.action.showCommands'
]);

/** The engine's context for a state, or `undefined` in the viewer, where there is no engine. */
export function engineContextOf(state: VimEditorState): VimKeyContext | undefined {
	switch (state) {
		case 'viewer': return undefined;
		// Replace mode is insert mode with a flag on: `vim.js` routes both through
		// `handleKeyInsertMode`, so it matches insert's rows and no others.
		case 'insert': case 'replace': return 'insert';
		case 'visual': return 'visual';
		case 'normal': return 'normal';
	}
}

/**
 * Whether the engine has a live binding for this key in this state — the question that settles a
 * chord both the engine and the workbench claim.
 */
export function vimClaimsKey(key: VimKeyName | undefined, state: VimEditorState): boolean {
	const context = engineContextOf(state);

	if (context === undefined || key === undefined) {
		return false;
	}
	if (key.length === 1 && key >= ' ') {
		return true;
	}

	return ENGINE_CHORDS.get(key)?.includes(context) ?? false;
}

/**
 * **What a single `u` takes back**: one vim command, except while the engine is typing, where the
 * whole insert is one undo and the boundary is `i` and `<Esc>` rather than each character.
 *
 * It is asked here rather than at each adapter because it is a decision about the model and both
 * frontends make it the same way — they differ only in what an undo element *is* (a
 * `pushUndoStop()` on a Monaco editor, a `pushStackElement()` on a text model). `state` is the
 * engine's own `vimState` holder, which is the vocabulary both adapters already speak; the engine
 * routes replace mode through insert, so `insertMode` covers `R` as well as `i`.
 */
export function startsUndoElement(state: { vim?: { insertMode?: boolean } }): boolean {
	return !state.vim?.insertMode;
}

/**
 * The engine bound to one editor: the half that names an editor at all.
 *
 * `handleKey` answers whether vim took the key, which is the question the pane asks before
 * letting anything else have it.
 */
export interface IVimSession<TKey> extends IDisposable {
	readonly mode: VimEngineMode;
	/** Fires when the mode, the buffer or the cursor changed — the frontend repaints on it. */
	readonly onDidChange: Event<void>;
	handleKey(key: TKey): boolean;
}

/** What the policy needs from the frontend, and the whole of it. */
export interface IVimEditorFrontend<TKey> {
	/**
	 * Bind the engine to the editor that is open, or `undefined` if there is nothing to edit.
	 * `quit` is what `:q` and `:wq` call, and it is the policy's own `detach`.
	 */
	createSession(quit: () => void): IVimSession<TKey> | undefined;

	/**
	 * Whether the workbench claims this command at all while vim has the buffer — the keep-set the
	 * frontend resolves with, which here is the keyboard takeover's. A `true` makes the key
	 * **contested**; it does not decide it. What the workbench keeps is the frontend's answer, and
	 * who wins is `consumesKey`'s.
	 */
	keepsCommand(commandId: string | undefined): boolean;
}

/**
 * One editor's state.
 *
 * The frontend owns the pixels or the cells; this owns which of them are allowed to mean
 * anything.
 */
export class VimEditorPolicy<TKey> extends Disposable {

	private readonly session = this._register(new MutableDisposable<IVimSession<TKey>>());

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	/** Fires on every transition, and on every change vim makes while it is attached. */
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	constructor(private readonly frontend: IVimEditorFrontend<TKey>) {
		super();
	}

	get state(): VimEditorState {
		return this.session.value?.mode ?? 'viewer';
	}

	/** Whether vim is attached at all, which is what the viewer's letters are guarded on. */
	get editing(): boolean {
		return !!this.session.value;
	}

	/**
	 * **Whether a keystroke is text.** Insert and replace, and no other state — the viewer types
	 * nothing and vim's other modes read every letter as a command.
	 *
	 * It is not `editing`: vim attached in normal mode is an editor the user is not typing into.
	 * The distinction is the whole of what a frontend's `global` keys need from this module, and it
	 * is asked here rather than derived from `state` at each call site because "which states are
	 * typing" is a fact about the model.
	 */
	get typing(): boolean {
		return engineContextOf(this.state) === 'insert';
	}

	/**
	 * `V` — vim on, or off again.
	 *
	 * The viewer is the state an editor opens in, deliberately: with vim attached this editor
	 * consumes nearly every key, and a reader who never asked for an editor should not lose
	 * `F`, `W` and `P` to it.
	 */
	toggle(): void {
		if (this.session.value) {
			this.detach();

			return;
		}

		const session = this.frontend.createSession(() => this.detach());

		if (!session) {
			return;
		}

		this.session.value = session;
		this._register(session.onDidChange(() => this._onDidChangeState.fire()));
		this._onDidChangeState.fire();
	}

	detach(): void {
		if (this.session.value) {
			this.session.clear();
			this._onDidChangeState.fire();
		}
	}

	/**
	 * Whether this editor takes the key rather than the workbench.
	 *
	 * Three questions in order, and only the last one is about the state:
	 *
	 * 1. In the viewer the answer is always the workbench's, which is what makes the editor-scoped
	 *    letters live there — there is no vim yet to own anything.
	 * 2. A key the workbench does not claim is the editor's, which is nearly every key: no rule
	 *    resolves, or the one that does is a stock default the takeover already dropped.
	 * 3. A key both claim is **contested**, and the engine's own table settles it — vim keeps the
	 *    chord in the states it binds it in and gives it up in the ones it does not. That is what
	 *    leaves `Ctrl+W` erasing a word while typing and closing the editor from normal mode, out
	 *    of one rule rather than two exceptions.
	 *
	 * `commandId` is a thunk because resolving a keystroke to a command is the expensive half and
	 * the viewer never needs it.
	 */
	consumesKey(key: VimKeyName | undefined, commandId: () => string | undefined): boolean {
		const state = this.state;

		if (state === 'viewer') {
			return false;
		}

		const id = commandId();

		if (!id) {
			return true;
		}
		if (ALWAYS_WORKBENCH_COMMANDS.has(id)) {
			return false;
		}

		return !this.frontend.keepsCommand(id) || vimClaimsKey(key, state);
	}

	/** One key, once this editor has decided it is the one to answer it. */
	handleKey(key: TKey): boolean {
		return this.session.value?.handleKey(key) ?? false;
	}
}
