/*---------------------------------------------------------------------------------------------
 *  The CM5 editor interface over a Monaco editor: monaco-vim's adapter, plus what the engine
 *  this port binds it to expects and it does not answer.
 *
 *  `src/vendor/monaco-vim/cm_adapter.ts` is the reference implementation of the ~11 members a
 *  terminal answers with the identity and a GUI must answer with real pixels — `charCoords`,
 *  `coordsChar`, `getScrollInfo`, `scrollTo`, `defaultTextHeight`, `findPosV`, `scanForBracket`.
 *  It was co-developed with monaco-vim's *own* fork of the CM5 vim engine, not with the engine
 *  vendored beside it, so its surface is a subset of `CM5EditorInterface`. **This subclass is the
 *  difference**, and it exists as a subclass so that `src/vendor/**` stays pristine but for two
 *  rewritten import lines — `initVim` is handed a class and never calls `new` on it, and statics
 *  inherit, so a subclass is a drop-in.
 *
 *  Measured at vendor time against `src/vendor/codemirror-vim/types.ts`: **50 of 82 instance
 *  members and 13 of 17 statics present**, with 18 of the absent ones reached somewhere in
 *  `vim.js`. The splice probe ran 32 vim checks over this binding and 31 passed untouched; the one
 *  that did not is `operation`, below. What the remaining absences cost
 *  is stated per member — none of them is on the path of a motion, an operator, insert mode,
 *  visual mode, search, undo or `:`.
 *
 *  Upstream counterpart: none — VS Code has no vim mode and no CM5 shim.
 *--------------------------------------------------------------------------------------------*/

import CMAdapter from '../../../../../vendor/monaco-vim/cm_adapter.js';
import { StringStream } from './stringStream.js';
import { IVimCodeEditor } from './vimCodeEditor.js';
import { startsUndoElement } from './vimEditorPolicy.js';

/** The prompt the engine opens for `:`, `/` and `?`, as the mode line renders it. */
export interface IVimPrompt {
	readonly prefix: string;
	readonly value: string;
	commit(value: string): void;
	close(): void;
}

export class TauriVimAdapter extends (CMAdapter as unknown as VimAdapterBase) {

	/**
	 * The ex-command token stream.
	 *
	 * The vendored adapter carries one of its own, but it is declared inside a file that imports
	 * Monaco. `stringStream.ts` is the Monaco-free home, and this override is what makes it the
	 * live one rather than a second copy.
	 */
	static readonly StringStream = StringStream;

	/**
	 * `:w`. The engine's `ex.write` calls `CM.commands.save`, so the hook is a static rather than
	 * a member — and it is installed here rather than mutated at each editor, because
	 * `CMAdapter.commands` is one object shared by every adapter.
	 */
	save: (() => void) | undefined;

	/** `:q` and `:wq`, defined beside the one `initVim` in `vimSession.ts`. */
	quit: (() => void) | undefined;

	/** Where `openDialog` puts the box, which is the mode line rather than a widget. */
	prompt: ((prompt: IVimPrompt | undefined) => void) | undefined;

	private op: { $d: number } | undefined;

	// ------------------------------------------------------------------ the operation

	/**
	 * One vim command.
	 *
	 * **This is where the undo stop is pushed**, and under this engine it is the only place that
	 * can be. monaco-vim ships `operation(fn) { return fn(); }` and buys its undo granularity
	 * with four `cm.pushUndoStop()` calls patched into its own engine fork; the engine vendored
	 * here has none of them, which is CodeMirror 5's arrangement — granularity is the adapter's,
	 * and one command is exactly this function's extent. Without it a single `u` after an insert
	 * and a `dd` takes back both, which is the one check of the 32 that failed before this landed.
	 *
	 * *When* a stop is pushed is `vimEditorPolicy.ts`'s `startsUndoElement`, because it is a decision
	 * about the model rather than about the editor; what an undo element is — a `pushUndoStop()`
	 * here — is the adapter's.
	 */
	override operation<T>(fn: () => T, _force?: boolean): T {
		if (!this.op) {
			this.op = { $d: 0 };

			if (startsUndoElement(this.state)) {
				this.editor.pushUndoStop();
			}
		}
		this.op.$d++;

		try {
			return fn();
		} finally {
			if (this.op && --this.op.$d === 0) {
				this.op = undefined;
			}
		}
	}

	// ------------------------------------------------------------------ the prompt

	/**
	 * `:`, `/` and `?`.
	 *
	 * The engine builds its prompt as an element tree — `makePrompt` is a `div` holding the prefix
	 * and an `<input>` — and hands it over; **the prefix is not an option**, it is that tree's own
	 * text, which is where the engine's own no-dialog branch reads it from too. The box is not
	 * focused: the editor keeps the keyboard, so `<Esc>` and every editing chord keep working and
	 * the mode line only has to render what was typed.
	 */
	override openDialog(template: Element, callback: ((value: string) => void) | undefined, options: { value?: string; onClose?: Function }): (newVal?: string) => void {
		const close = (value?: string) => {
			options.onClose?.(template);
			this.prompt?.(undefined);

			return value;
		};

		this.prompt?.({
			prefix: template.textContent ?? '',
			value: options.value ?? '',
			commit: value => { close(); callback?.(value); },
			close: () => close()
		});

		return close;
	}

	override getInputField(): HTMLElement {
		return this.editor.getDomNode() ?? document.createElement('div');
	}

	override getWrapperElement(): HTMLElement {
		return this.editor.getDomNode() ?? document.createElement('div');
	}

	// ------------------------------------------------------------------ what the vendored adapter does not answer
	//
	// Each of these is reached by `vim.js` and absent from `cm_adapter.ts`. They are stubbed to
	// the least surprising answer rather than left to throw, and what each one costs while it is a
	// stub is stated. None is on the path of a motion, an operator, insert, visual, search, undo
	// or `:` — the 32 checks cover all of those and pass.

	/** `replaceSelection` is `replaceSelections` of one; the vendored adapter has only the plural. */
	replaceSelection(text: string): void {
		this.replaceSelections([text]);
	}

	/** `>>` / `<<` / `=`. `indentLine` is the vendored adapter's, over the whole selection. */
	indentMore(): void {
		this.triggerEditorAction('editor.action.indentLines');
	}

	indentLess(): void {
		this.triggerEditorAction('editor.action.outdentLines');
	}

	/**
	 * `gi` and `` `. `` — jump to where the last edit ended. Absent, so both land on the cursor.
	 * The engine only ever reads it, so a position is enough to keep them harmless.
	 */
	getLastEditEnd(): { line: number; ch: number } {
		const position = this.editor.getPosition();

		return { line: (position?.lineNumber ?? 1) - 1, ch: (position?.column ?? 1) - 1 };
	}

	/**
	 * A line's identity across edits, which is what a mark follows. Absent, so a mark set with `m`
	 * survives a motion but not an edit above it — the mark is a bookmark either way
	 * (`setBookmark` is the vendored adapter's and does track), and this is only the fallback the
	 * engine reaches for when it wants the *line*.
	 */
	getLineHandle(row: number): { row: number; index: number } {
		return { row, index: row };
	}

	getLineNumber(handle: { row: number } | null): number | null {
		return handle ? handle.row : null;
	}

	releaseLineHandles(): void { }

	/**
	 * `%` skips a bracket inside a string or a comment when the editor can say so. Monaco knows
	 * from its tokens, but not through any API this shim has; answering `''` makes `%` treat every
	 * bracket as code, which is the behaviour of a buffer with no language.
	 */
	getTokenTypeAt(): '' | 'string' | 'comment' {
		return '';
	}

	/**
	 * `gq` — reflow a paragraph to `textwidth`. Absent, so `gq` moves the cursor and changes
	 * nothing. Reported rather than approximated: a wrong reflow is worse than no reflow.
	 */
	hardWrap(): number {
		return 0;
	}

	/** Multi-cursor. This port drives one editor with one selection, so both answers are constant. */
	isInMultiSelectMode(): boolean {
		return false;
	}

	virtualSelectionMode(): boolean {
		return false;
	}

	forEachSelection(command: Function): void {
		command();
	}

	/** The search scrollbar's match annotations, which upstream marks optional. */
	showMatchesOnScrollbar: undefined;
}

/** The vendored adapter's shape, which is JavaScript under `@ts-nocheck` and has no declaration. */
type VimAdapterBase = new (editor: IVimCodeEditor) => {
	editor: IVimCodeEditor;
	state: { vim?: { insertMode?: boolean }; overwrite?: boolean };
	operation<T>(fn: () => T, force?: boolean): T;
	openDialog(template: Element, callback: ((value: string) => void) | undefined, options: { value?: string; onClose?: Function }): (newVal?: string) => void;
	getInputField(): HTMLElement;
	getWrapperElement(): HTMLElement;
	replaceSelections(texts: string[]): void;
	triggerEditorAction(action: string): void;
	on(event: string, handler: Function): void;
	off(event: string, handler: Function): void;
	dispose(): void;
};
