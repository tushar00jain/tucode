/*---------------------------------------------------------------------------------------------
 *  The modal text editor: a viewer until `V`, and the mode line that says which state it is in.
 *
 *  Every code editor opens **read-only**, per editor rather than by the global setting, so a file
 *  is a thing you read and the editor-scoped letters of the shared keymap — `F`, `W`, `P`, `V`,
 *  `Tab` — mean what they mean everywhere else. `tscode.file.edit` (`V`, bound in
 *  `browser/tauri/keymap.ts`) attaches vim; `:q` detaches. **Insert is the only
 *  state in which typing reaches the buffer**, which the keyboard commits to
 *  (`docs/ARCHITECTURE.md`) and
 *  the reason click-into-a-file-and-type no longer works.
 *
 *  **Precedence is the editor's, before the window.** `WorkbenchKeybindingService` listens at
 *  window level in the bubble phase, so a handler on the editor runs first; when the policy says
 *  this editor consumes the key, the event is stopped there and the resolver never sees it. That
 *  precedence is what makes the `editor:` scope rows live in the viewer: their keys are the bare
 *  letters `F`, `W`, `P` and `V`, which the engine claims in every state it is attached in.
 *
 *  The state machine itself is not here — it is `vimEditorPolicy.ts`, which decides and draws
 *  nothing. This file is the wiring beneath it: which editors, which services, which pixels.
 *
 *  Upstream counterpart: none — VS Code's editor has no modal state and no vim mode.
 *--------------------------------------------------------------------------------------------*/

import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { EditorCommandsContext } from '../../../browser/tauri/keymap.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { keepReason } from '../../../services/keybinding/tauri/keyboardTakeover.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { VimEditorPolicy } from './vimEditorPolicy.js';
import { vimKeyName } from './vimKeys.js';
import { VimSession } from './vimSession.js';

const STATUS_ENTRY_ID = 'status.vimMode';

/** One editor's policy, and the session under it while there is one to read the prompt from. */
interface IModalEditor extends IDisposable {
	readonly policy: VimEditorPolicy<IKeyboardEvent>;
	session: VimSession | undefined;
}

export class VimContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriVim';

	/** The live instance, so `tscode.file.edit` can reach the focused editor's policy. */
	static instance: VimContribution | undefined;

	private readonly modal = new Map<ICodeEditor, IModalEditor>();
	private modeEntry: IStatusbarEntryAccessor | undefined;
	private readonly editorCommands: IContextKey<boolean>;

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IStatusbarService private readonly statusbarService: IStatusbarService
	) {
		super();

		this.editorCommands = EditorCommandsContext.bindTo(contextKeyService);

		VimContribution.instance = this;
		this._register({ dispose: () => { VimContribution.instance = undefined; } });

		for (const editor of this.codeEditorService.listCodeEditors()) {
			this.add(editor);
		}
		this._register(this.codeEditorService.onCodeEditorAdd(editor => this.add(editor)));
		this._register(this.codeEditorService.onCodeEditorRemove(editor => this.remove(editor)));
		this._register({ dispose: () => { for (const editor of [...this.modal.keys()]) { this.remove(editor); } } });
	}

	/** The editor the keyboard is in, which is what `V` acts on. */
	focused(): IModalEditor | undefined {
		const editor = this.codeEditorService.getFocusedCodeEditor();

		return editor ? this.modal.get(editor) : undefined;
	}

	/**
	 * The editor whose **buffer** has the keyboard, which is a stricter question than `focused()`
	 * and the only one `tscodeEditorCommands` may be published from.
	 *
	 * `getFocusedCodeEditor` falls back to the editor with *widget* focus
	 * (`abstractCodeEditorService.ts:115`), and that flag is debounced — `dom.trackFocus` defers a
	 * blur by a turn, so it still reads `true` inside the blur this contribution reacts to. Asking
	 * it left the key set after the keyboard had gone to a quick input or a `/` box, where every
	 * `global` row is a bare letter: typing a path opened a terminal editor on its `t`.
	 * `hasTextFocus` is the view's own state and has no such window.
	 */
	private commanding(): IModalEditor | undefined {
		for (const [editor, modal] of this.modal) {
			if (editor.hasTextFocus()) {
				return modal;
			}
		}

		return undefined;
	}

	/**
	 * Whether the modal state is this editor's. A simple widget — the commit message box, a find
	 * input — and a diff side are code editors this port does not own, and read-only is not a
	 * setting either of them asked about.
	 */
	private owns(editor: ICodeEditor): boolean {
		return !editor.isSimpleWidget && !editor.getOption(EditorOption.inDiffEditor);
	}

	private add(editor: ICodeEditor): void {
		if (!this.owns(editor)) {
			return;
		}

		const store = new DisposableStore();
		const modal: IModalEditor = {
			policy: new VimEditorPolicy<IKeyboardEvent>({
				createSession: quit => {
					modal.session = new VimSession(editor, () => this.save(editor), quit);

					return modal.session;
				},
				// The keep-set the takeover filter already resolves with, asked by command alone —
				// which is every reason it has that a command id can answer. Its `when`-shaped
				// reasons are a focused input and a quick pick up, and neither is a question about
				// an editor that vim is attached to.
				//
				// Not `commandsToSkipShell`: that set was assembled for a shell, it holds neither
				// `workbench.action.closeActiveEditor` nor `workbench.action.toggleSidebarVisibility`,
				// and reading it here would leave `Ctrl+W` and `Ctrl+B` dead in every vim state.
				keepsCommand: id => !!id && keepReason({ command: id, when: undefined }) !== undefined
			}),
			session: undefined,
			dispose: () => store.dispose()
		};

		store.add(modal.policy);
		store.add(modal.policy.onDidChangeState(() => {
			if (!modal.policy.editing) {
				modal.session = undefined;
			}
			this.applyReadOnly(editor, modal);
			this.refresh();
		}));
		store.add(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly)) {
				this.applyReadOnly(editor, modal);
			}
		}));
		store.add(editor.onKeyDown(event => this.onKeyDown(modal, event)));
		// `ICodeEditorService` publishes no "the focused editor changed" event, so the state
		// follows each editor's own focus instead — which is the same moment.
		store.add(editor.onDidFocusEditorText(() => this.refresh()));
		store.add(editor.onDidBlurEditorText(() => this.refresh()));

		this.modal.set(editor, modal);
		this.applyReadOnly(editor, modal);
		// An editor this contribution learns about *while* it has the keyboard — the restored one
		// at `AfterRestored`, before any focus event of its own — is a state no listener above will
		// publish.
		this.refresh();
	}

	/**
	 * Read-only, per editor rather than through `editor.readOnly` in configuration, and asserted
	 * on every change rather than once: `textEditor.ts` re-applies `readOnly` from its input on
	 * every `setInput`, configuration change and show, so an editor set read-only when it was
	 * created is editable again as soon as a file is opened in it.
	 */
	private applyReadOnly(editor: ICodeEditor, modal: IModalEditor): void {
		const readOnly = !modal.policy.editing;

		if (editor.getOption(EditorOption.readOnly) !== readOnly) {
			editor.updateOptions({ readOnly });
		}
	}

	private remove(editor: ICodeEditor): void {
		this.modal.get(editor)?.dispose();
		this.modal.delete(editor);
		this.refresh();
	}

	/**
	 * The editor's chance at the key, before the window-level resolver bubbles it.
	 *
	 * The two frontend facts the policy decides on are both supplied here: the engine's name for the
	 * key, and the command the resolver would run. Resolving the keystroke is only asked for once
	 * vim is attached, because in the viewer the answer is always "the workbench's" and
	 * `softDispatch` is the expensive half.
	 */
	private onKeyDown(modal: IModalEditor, event: IKeyboardEvent): void {
		// A prefix already accepted by VS Code owns the rest of its chord, even
		// when the next key is a printable Vim key (for example Cmd-K, V).
		if (this.keybindingService.inChordMode) { return; }
		const consumes = modal.policy.consumesKey(vimKeyName(event), () => {
			const resolved = this.keybindingService.softDispatch(event, event.target);

			return resolved.kind === ResultKind.KbFound ? resolved.commandId ?? undefined : undefined;
		});

		if (consumes && modal.policy.handleKey(event)) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	private save(editor: ICodeEditor): void {
		editor.getAction('workbench.action.files.save')?.run();
	}

	/**
	 * Everything the focused editor's state is published as, in the one place the state can change:
	 * `tscodeEditorCommands`, which is what tells the shared keymap the user is not typing, and the
	 * mode line. The two travel together because they are one fact read twice — a refresh that
	 * moved only the mode line is a workbench whose keys do not match what it says the state is.
	 *
	 * The mode line names the viewer too, and not only vim's own modes: `viewer` is a state of the
	 * same machine, and it is the one state Monaco cannot show by itself — it draws a cursor in a
	 * read-only editor exactly as it does in an editable one.
	 *
	 * It carries the open `:` or `/` box as well as the mode, because the box is rendered rather
	 * than focused — the editor keeps the keyboard, so this is the only place what was typed can
	 * appear.
	 */
	private refresh(): void {
		// No buffer has the keyboard, so `inputFocus` is telling the truth again and the key must
		// say nothing — a stale `true` puts every `global` key inside the next box the user types
		// in.
		const commanding = this.commanding();
		this.editorCommands.set(!!commanding && !commanding.policy.typing);

		const modal = this.focused();

		if (!modal) {
			this.modeEntry?.dispose();
			this.modeEntry = undefined;

			return;
		}

		const prompt = modal.session?.openPrompt;
		const text = prompt
			? `${prompt.prefix}${prompt.value}`
			: localize('vim.mode', "-- {0} --", modal.policy.state.toUpperCase());
		const entry = { name: localize('vim.mode.name', "Vim Mode"), text, ariaLabel: text };

		if (this.modeEntry) {
			this.modeEntry.update(entry);
		} else {
			this.modeEntry = this.statusbarService.addEntry(entry, STATUS_ENTRY_ID, StatusbarAlignment.RIGHT, 100);
		}
	}
}

/**
 * `V` — vim on, or off again. Declared here and bound in `browser/tauri/keymap.ts`, which is the
 * sole author of keybindings; this file registers no `keybinding` of its own.
 */
class ToggleVimAction extends Action2 {

	static readonly ID = 'tscode.file.edit';

	constructor() {
		super({
			id: ToggleVimAction.ID,
			title: localize2('vim.toggle.title', "Toggle Vim Mode"),
			category: localize2('vim.category', "Editor"),
			f1: true
		});
	}

	run(_accessor: ServicesAccessor): void {
		VimContribution.instance?.focused()?.policy.toggle();
	}
}

registerAction2(ToggleVimAction);
registerWorkbenchContribution2(VimContribution.ID, VimContribution, WorkbenchPhase.AfterRestored);
