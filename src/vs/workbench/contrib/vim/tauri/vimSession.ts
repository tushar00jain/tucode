/*---------------------------------------------------------------------------------------------
 *  The engine bound to this frontend's adapter, and the keys that reach it.
 *
 *  The seam is one function. `initVim(TauriVimAdapter)` is called **once**, at module load,
 *  because the engine keeps its registers, its macros, its `:` history and its `:map`s in one
 *  `vimGlobalState` — which is vim's own semantics, where yanking in one buffer and putting in
 *  another is the point — and calling it twice would give the second editor an empty clipboard.
 *
 *  What crosses after that is `enterVimMode(adapter)` and `handleKey(adapter, key, 'user')`, and
 *  nothing else.
 *
 *  **Insert mode is not the engine's**, and that is upstream's design rather than a shortcut:
 *  `handleKey` answers false for a printable character in insert mode, and the editor is expected
 *  to insert it — which is what Monaco's own `type` handler does, through the cursor that already
 *  knows about tabs, surrogate pairs and the read-only guard.
 *
 *  **The engine installs no keymap.** It never assigns `CM.keyMap.vim`, so the vendored adapter's
 *  `attach()` and `handleKeyDown` — which route through exactly that — are unreachable here and
 *  are not called. Key dispatch is `vim.contribution.ts`'s, which is why the policy above it can
 *  be one module that names no editor.
 *
 *  This file is the half of `vimEditorPolicy.ts` that owns the pixels.
 *
 *  Upstream counterpart: none — there is no vim mode in VS Code.
 *--------------------------------------------------------------------------------------------*/

import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { initVim } from '../../../../../vendor/codemirror-vim/vim.js';
import type { CM5EditorInterface, CodeMirrorConstructor } from '../../../../../vendor/codemirror-vim/types.js';
import { IVimPrompt, TauriVimAdapter } from './vimAdapter.js';
import { asVimCodeEditor } from './vimCodeEditor.js';
import { IVimSession, VimEngineMode } from './vimEditorPolicy.js';
import { vimKeyName } from './vimKeys.js';

/**
 * The engine, bound once. `vimGlobalState` — the registers, the macros, the `:` history, the
 * `:map`s — lives inside this closure, so a second `initVim` would be a second clipboard.
 */
// The cast is history rather than a gap: `CodeMirrorConstructor` declares `new (host: any)`
// because CodeMirror 5's editor was constructed by the engine's host, and **`vim.js` contains no
// `new CM(` at all** — verified at the pinned revision. Only the statics are ever reached.
const Vim = initVim(TauriVimAdapter as unknown as CodeMirrorConstructor);

// `:w` is the engine's own (`ex.write` calls `CM.commands.save`); `:q` and `:wq` are not, because
// what closing a buffer means belongs to whatever opened it. Defined once, beside the one
// `initVim`, for the same reason: the ex map is global state inside that closure.
Vim.defineEx('quit', 'q', cm => { (cm as unknown as TauriVimAdapter).quit?.(); });
Vim.defineEx('wq', 'wq', cm => { const adapter = cm as unknown as TauriVimAdapter; adapter.save?.(); adapter.quit?.(); });

/**
 * One editor's vim session: the adapter, the keys, and what the mode line says because of them.
 *
 * `handleKey` answers whether the key was consumed, which is what tells the contribution not to
 * let the window-level resolver see it.
 */
export class VimSession extends Disposable implements IVimSession<IKeyboardEvent> {

	private readonly adapter: TauriVimAdapter;

	/**
	 * The adapter as the engine's own contract names it. The cast is the measured gap and not a
	 * shrug: `cm_adapter.ts` answers 50 of `CM5EditorInterface`'s 82 members and this subclass
	 * supplies the ones `vim.js` reaches, so the object satisfies the engine by behaviour while
	 * the declaration still lists members neither half provides. `vimAdapter.ts` says which.
	 */
	private get cm(): CM5EditorInterface {
		return this.adapter as unknown as CM5EditorInterface;
	}

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _mode: VimEngineMode = 'normal';
	private _prompt: IVimPrompt | undefined;

	constructor(private readonly editor: ICodeEditor, save: () => void, quit: () => void) {
		super();

		// The adapter's constructor calls `createContextKey`, which only the standalone editor has;
		// `vimCodeEditor.ts` is where that member comes from.
		this.adapter = new TauriVimAdapter(asVimCodeEditor(editor));
		this.adapter.save = save;
		this.adapter.quit = quit;
		this.adapter.prompt = prompt => {
			this._prompt = prompt;
			this._onDidChange.fire();
		};

		// `vim-mode-change` is the engine's own event, and it is the only statement of the mode
		// that is not a guess: `vim.insertMode` and `vim.visualMode` are two booleans that do not
		// name replace mode at all.
		this.adapter.on('vim-mode-change', (event: { mode: VimEngineMode }) => {
			this._mode = event.mode;
			this._onDidChange.fire();
		});

		Vim.enterVimMode(this.cm);

		this._register(toDisposable(() => {
			Vim.leaveVimMode?.(this.cm);
			this.adapter.dispose();
		}));

		this._register(editor.onDidChangeModelContent(() => this._onDidChange.fire()));
		this._register(editor.onDidChangeCursorPosition(() => this._onDidChange.fire()));
	}

	get mode(): VimEngineMode {
		return this._mode;
	}

	/** The open `:`, `/` or `?` box, or nothing. Rendered in the mode line, never focused. */
	get openPrompt(): IVimPrompt | undefined {
		return this._prompt;
	}

	/**
	 * One key. Answers whether vim took it.
	 *
	 * The order is the engine's: it is offered the key first in every mode, and only a printable
	 * character it declined while in insert mode is typed — which is how a `<C-o>` or an `<Esc>`
	 * keeps working while the letters around it reach the buffer.
	 */
	handleKey(key: IKeyboardEvent): boolean {
		if (this._prompt) {
			return this.handlePromptKey(key);
		}

		const name = vimKeyName(key);

		if (!name) {
			return false;
		}

		if (Vim.handleKey(this.cm, name, 'user')) {
			this._onDidChange.fire();

			return true;
		}

		if (!this.adapter.state.vim?.insertMode) {
			return false;
		}

		return this.type(name);
	}

	/** Insert mode's own keys: the character, the newline, and the delete to the left. */
	private type(name: string): boolean {
		if (name === '<CR>') {
			this.editor.trigger('vim', 'type', { text: '\n' });
		} else if (name === '<Tab>') {
			this.editor.trigger('vim', 'tab', {});
		} else if (name === '<BS>') {
			// `<BS>` at the start of a line joins it to the one before, which is what a delete of
			// the character to the left is — so it is the cursor's own delete rather than an edit.
			this.editor.trigger('vim', 'deleteLeft', {});
		} else if (name.length === 1 && name >= ' ') {
			this.editor.trigger('vim', 'type', { text: name });
		} else {
			return false;
		}

		this._onDidChange.fire();

		return true;
	}

	/**
	 * The `:` / `/` box.
	 *
	 * It is a value and two keys rather than a focused widget, because the editor has to keep the
	 * keyboard: a real `<input>` would take `<Esc>` and every editing chord with it.
	 */
	private handlePromptKey(key: IKeyboardEvent): boolean {
		const prompt = this._prompt!;
		const name = vimKeyName(key);

		if (name === '<Esc>') {
			this._prompt = undefined;
			prompt.close();
		} else if (name === '<CR>') {
			this._prompt = undefined;
			prompt.commit(prompt.value);
		} else if (name === '<BS>') {
			this._prompt = { ...prompt, value: prompt.value.slice(0, -1) };
		} else if (name && name.length === 1 && name >= ' ') {
			this._prompt = { ...prompt, value: prompt.value + name };
		} else {
			return false;
		}

		this._onDidChange.fire();

		return true;
	}
}
