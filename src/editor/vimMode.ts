/*---------------------------------------------------------------------------------------------
 *  Vim mode: the engine bound to this fork's adapter, and the keys that reach it.
 *
 *  The seam is one function. `initVim(TerminalCodeMirror)` is called **once**, at module load,
 *  because the engine keeps its registers, its macros, its `:` history and its `:map`s in one
 *  `vimGlobalState` — which is vim's own semantics, where yanking in one buffer and putting in
 *  another is the point — and calling it twice would give the second editor an empty clipboard.
 *
 *  What crosses after that is `enterVimMode(adapter)` and `handleKey(adapter, key, 'user')`, and
 *  nothing else.
 *
 *  **Insert mode is not the engine's**, and that is upstream's design rather than a shortcut:
 *  `handleKey` answers false for a printable character in insert mode, and the editor is expected
 *  to insert it — which is what `viewModel.type` does, through the cursor that already knows
 *  about tabs, surrogate pairs and the read-only guard.
 *
 *  Upstream counterpart: none — there is no vim mode in tscode. §15 records the divergence.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../vs/base/common/event.js';
import { OffsetRange } from '../vs/editor/common/core/ranges/offsetRange.js';
import { initVim } from '../vendor/codemirror-vim/vim.js';
import type { CodeMirrorConstructor } from '../vendor/codemirror-vim/types.js';
import type { INormalizedKey as IKey } from '../input/key.js';
import { editValue } from '../input/editValue.js';
import { TextView } from './textView.js';
import { IVimPrompt, TerminalCodeMirror, VimAdapter } from './vimAdapter.js';
import { vimKeyName } from './vimKey.js';
export { vimKeyName } from './vimKey.js';

/**
 * The engine, bound once. `vimGlobalState` — the registers, the macros, the `:` history, the
 * `:map`s — lives inside this closure, so a second `initVim` would be a second clipboard.
 */
// The cast is the one place the CM5 contract does not describe this fork, and it is history
// rather than a gap: `CodeMirrorConstructor` declares `new (host: any)` because CodeMirror 5's
// editor was constructed by the engine's host, and **`vim.js` contains no `new CM(` at all**. So
// `TerminalCodeMirror` is a namespace with statics, and the constructor half is never called.
const Vim = initVim(TerminalCodeMirror as unknown as CodeMirrorConstructor);

// `:w` is the engine's own (`ex.write` calls `CM.commands.save`); `:q` and `:wq` are not, because
// what closing a buffer means belongs to whatever opened it. Defined once, beside the one
// `initVim`, for the same reason: the ex map is global state inside that closure.
Vim.defineEx('quit', 'q', cm => { (cm as unknown as VimAdapter).quit?.(); });
Vim.defineEx('wq', 'wq', cm => { const adapter = cm as unknown as VimAdapter; adapter.save?.(); adapter.quit?.(); });

/** What the status bar says, which is what vim's own `showmode` says. */
export type VimModeName = 'normal' | 'insert' | 'replace' | 'visual';

/**
 * One editor's vim mode: the adapter, the keys, and what the pane paints because of them.
 *
 * The pane owns the frame; this owns the buffer's state. `handleKey` answers whether the key was
 * consumed, which is what tells the pane not to hand it to the workbench.
 */
export class VimMode extends Disposable {

	private readonly adapter: VimAdapter;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the rows, the cursor or the mode changed — the pane repaints on it. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _mode: VimModeName = 'normal';
	private _pending = '';
	private _prompt: IVimPrompt | undefined;
	private _message: string | undefined;

	constructor(view: TextView, save: () => void, quit: () => void) {
		super();

		this.adapter = new VimAdapter(view);
		this.adapter.save = save;
		this.adapter.quit = quit;
		this.adapter.prompt = prompt => {
			this._prompt = prompt;
			this._onDidChange.fire();
		};

		// `vim-mode-change` is the engine's own event, and it is the only statement of the mode
		// that is not a guess: `vim.insertMode` and `vim.visualMode` are two booleans that do not
		// name replace mode at all.
		// The handler takes the *event*, not the editor: `CM.signal(emitter, type, ...args)` calls
		// each handler with the arguments after `type`, and the engine signals this one as
		// `CM.signal(cm, 'vim-mode-change', { mode })`.
		this.adapter.on('vim-mode-change', (event: { mode: VimModeName }) => {
			this._mode = event.mode;
			this._onDidChange.fire();
		});

		Vim.enterVimMode(this.adapter);

		this._register(toDisposable(() => {
			Vim.leaveVimMode?.(this.adapter);
			this.adapter.destroy();
		}));

		// The model's own change stream, which is what `.` repeats an insert from and what a mark
		// follows. `curOp` is flushed by `onChange` itself when no vim command is running.
		this._register(view.model.onDidChangeContent(event => {
			this.adapter.onChange(event.changes);
			this._onDidChange.fire();
		}));

		this._register(view.viewModel.onEvent(event => {
			// `OutgoingViewModelEventKind.CursorStateChanged` is 7. The enum is a const enum, so
			// its names do not survive type stripping in a unit test (§13.4) and the number is
			// what the probes read back.
			if (event.kind === 7) {
				this.adapter.onSelectionChange();
				this._onDidChange.fire();
			}
		}));
	}

	get mode(): VimModeName {
		return this._mode;
	}

	/** The keys typed so far that have not made a command — vim's own bottom-right display. */
	get pending(): string {
		return this._pending;
	}

	/** The open `:`, `/` or `?` box, or nothing. */
	get openPrompt(): IVimPrompt | undefined {
		return this._prompt;
	}

	/** What the engine last said, which is an error from `:` or nothing. */
	get message(): string | undefined {
		return this._message;
	}

	/** The search overlay's matches on one model line, as `renderRow`'s `highlights` reads them. */
	highlights(lineContent: string): OffsetRange[] {
		const query = this.adapter.overlay;

		if (!query) {
			return [];
		}

		const ranges: OffsetRange[] = [];
		const re = new RegExp(query.source, query.flags.includes('g') ? query.flags : query.flags + 'g');

		for (const match of lineContent.matchAll(re)) {
			if (match[0].length) {
				ranges.push(new OffsetRange(match.index, match.index + match[0].length));
			}
		}

		return ranges;
	}

	/**
	 * One key. Answers whether vim took it.
	 *
	 * The order is the engine's: it is offered the key first in every mode, and only a printable
	 * character it declined while in insert mode is typed — which is how a `<C-o>` or an `<Esc>`
	 * keeps working while the letters around it reach the buffer.
	 */
	handleKey(key: IKey): boolean {
		if (this._prompt) {
			return this.handlePromptKey(key);
		}

		const name = vimKeyName(key);

		if (!name) {
			return false;
		}

		this._message = undefined;

		if (Vim.handleKey(this.adapter, name, 'user')) {
			this._pending = pendingKeys(this.adapter);
			this._onDidChange.fire();

			return true;
		}

		this._pending = pendingKeys(this.adapter);

		if (!this.adapter.state.vim?.insertMode) {
			return false;
		}

		return this.type(name, key);
	}

	/** Insert mode's own keys: the character, the newline, and the two deletes. */
	private type(name: string, key: IKey): boolean {
		const viewModel = this.adapter.view.viewModel;

		if (name === '<CR>') {
			viewModel.type('\n', 'keyboard');
		} else if (name === '<Tab>') {
			viewModel.type('\t', 'keyboard');
		} else if (name === '<BS>') {
			// `<BS>` at the start of a line joins it to the one before, which is what a delete of
			// the character to the left is — so it is the cursor's own delete rather than an edit.
			this.adapter.execCommand('deleteLeft');
		} else if (name === '<Space>') {
			viewModel.type(' ', 'keyboard');
		} else if (key.char && key.char.length === 1 && key.char >= ' ' && !key.ctrl) {
			if (this.adapter.state.overwrite) {
				this.adapter.overWriteSelection(key.char);
			} else {
				viewModel.type(key.char, 'keyboard');
			}
		} else {
			return false;
		}

		this._onDidChange.fire();

		return true;
	}

	/** The `:` / `/` box, which is a value and two keys rather than a widget (§4.7). */
	private handlePromptKey(key: IKey): boolean {
		const prompt = this._prompt!;

		if (key.name === 'escape') {
			this._prompt = undefined;
			prompt.close();
		} else if (key.name === 'enter') {
			const value = this._prompt!.value;
			this._prompt = undefined;
			prompt.commit(value);
		} else {
			// `inputBox.editValue` is the fork's one answer to what a keystroke does to a box's
			// value (§4.7), so `Ctrl+W` and `Ctrl+U` mean here what they mean in the search pane.
			const edited = editValue(key, prompt.value);

			if (!edited) {
				return false;
			}
			this._prompt = { ...prompt, value: edited };
		}

		this._onDidChange.fire();

		return true;
	}
}

/** What the engine has buffered but not yet made a command of. */
function pendingKeys(adapter: VimAdapter): string {
	return adapter.state.vim?.inputState?.keyBuffer?.join('') ?? '';
}
