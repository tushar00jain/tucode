/*---------------------------------------------------------------------------------------------
 *  Who answers a key while vim has the buffer, asserted without a window.
 *
 *  `vimEditorPolicy.ts` is the one part of the modal editor that is testable on its own: the
 *  frontend supplies the engine's name for the key and the command the resolver would run, and
 *  everything after that is the policy's. So the rig is a stub session that says which state the
 *  editor is in, and the **real** takeover keep-set for what the workbench claims — the cross
 *  between the two is exactly what the escape table is derived from, and asserting it against a
 *  made-up keep-set would prove nothing about this port.
 *
 *  Every contested chord is asserted in **both** directions, with the same chord answered
 *  differently in two states. A flat rule — any flat rule — fails these: it has to give `Ctrl+W`
 *  one answer for both insert and normal.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `event.ts` and `cancellation.ts` import each other and `cancellation.ts` reads `Event.None` at
// module scope, so it has to be the one entered first — which it is in the bundled graph and is
// not when a test names `event.js` itself.
import '../../src/vs/base/common/cancellation.js';
import { Event } from '../../src/vs/base/common/event.js';
import type { IVimSession, VimEditorState, VimEngineMode } from '../../src/vs/workbench/contrib/vim/tauri/vimEditorPolicy.js';
import { ALWAYS_WORKBENCH_COMMANDS, engineContextOf, VimEditorPolicy, vimClaimsKey } from '../../src/vs/workbench/contrib/vim/tauri/vimEditorPolicy.js';
import { keepReason, registerTakeoverKeepCommand } from '../../src/vs/workbench/services/keybinding/tauri/keyboardTakeover.js';

/**
 * The keymap rows this file's chords resolve to, declared here as `keymap.contribution.ts`
 * declares them: its own registration cannot run under Node, and a keep-set missing them would
 * make every one of these chords uncontested and the assertions vacuous.
 */
for (const id of ['tscode.file.edit', 'tscode.file.toggleWordWrap', 'tscode.stopEditingInput', 'workbench.action.nextEditor']) {
	registerTakeoverKeepCommand(id);
}

/** The engine, reduced to the one thing the policy reads off it. */
class StubSession implements IVimSession<string> {
	readonly onDidChange = Event.None;
	constructor(public mode: VimEngineMode) { }
	handleKey(): boolean { return true; }
	dispose(): void { }
}

/** An editor in `state`, answering `keepsCommand` from the real takeover keep-set. */
function editorIn(state: VimEditorState): VimEditorPolicy<string> {
	const policy = new VimEditorPolicy<string>({
		createSession: () => state === 'viewer' ? undefined : new StubSession(state),
		keepsCommand: id => !!id && keepReason({ command: id, when: undefined }) !== undefined
	});

	if (state !== 'viewer') {
		policy.toggle();
		assert.equal(policy.state, state, 'the stub session is what the policy reports');
	}

	return policy;
}

/** Whether the editor takes `key`, given the command the resolver would run for it. */
function takes(state: VimEditorState, key: string | undefined, command: string | undefined): boolean {
	return editorIn(state).consumesKey(key, () => command);
}

/** The chords both sides claim, each with the command the workbench's rule runs. */
const CLOSE_EDITOR = 'workbench.action.closeActiveEditor';
const TOGGLE_SIDEBAR = 'workbench.action.toggleSidebarVisibility';
const NEXT_EDITOR = 'workbench.action.nextEditor';
const STOP_EDITING = 'tscode.stopEditingInput';
const EDIT_FILE = 'tscode.file.edit';
const QUICK_OPEN = 'workbench.action.quickOpen';
const SHOW_COMMANDS = 'workbench.action.showCommands';

const ATTACHED: readonly VimEditorState[] = ['normal', 'insert', 'replace', 'visual'];

describe('vimEditorPolicy · the viewer', () => {

	it('takes nothing at all, because there is no vim to own anything', () => {
		for (const [key, command] of [['<C-w>', CLOSE_EDITOR], ['<C-b>', TOGGLE_SIDEBAR], ['<Esc>', STOP_EDITING], ['V', EDIT_FILE]]) {
			assert.equal(takes('viewer', key, command), false, `${key} is the workbench's in the viewer`);
		}
	});

	it('takes nothing even where no command resolves, which is the key it would own in any other state', () => {
		assert.equal(takes('viewer', 'x', undefined), false);
		assert.equal(takes('normal', 'x', undefined), true, 'and the same key is the editor\'s once vim is attached');
	});
});

// What `tscodeEditorCommands` is published from, and the reason a `global` key was dead in an
// editor until it existed: a focused Monaco sets `inputFocus` in every one of these states, and in
// four of the five the letters are commands rather than text.
describe('vimEditorPolicy · whether a keystroke is text', () => {

	it('is only insert and replace, which is where the buffer changes', () => {
		for (const state of ['viewer', 'normal', 'visual'] as const) {
			assert.equal(editorIn(state).typing, false, `${state} reads a letter as a command`);
		}
		for (const state of ['insert', 'replace'] as const) {
			assert.equal(editorIn(state).typing, true, `${state} puts a letter in the buffer`);
		}
	});

	it('is not `editing`, which vim attached in normal mode also answers', () => {
		const normal = editorIn('normal');

		assert.equal(normal.editing, true, 'vim is attached');
		assert.equal(normal.typing, false, 'and the user is not typing');
	});
});

describe('vimEditorPolicy · a contested chord, both ways', () => {

	it('gives `Ctrl+W` to vim while typing and to the workbench in normal mode', () => {
		assert.equal(takes('insert', '<C-w>', CLOSE_EDITOR), true, 'erase the word before the cursor');
		assert.equal(takes('normal', '<C-w>', CLOSE_EDITOR), false, 'the engine\'s normal-mode row is `idle`, so the editor closes');
	});

	it('gives `Ctrl+B` to vim in normal mode and to the workbench while typing', () => {
		assert.equal(takes('normal', '<C-b>', TOGGLE_SIDEBAR), true, 'page up');
		assert.equal(takes('insert', '<C-b>', TOGGLE_SIDEBAR), false, 'the engine binds nothing here, so the side bar toggles');
	});

	it('gives `Tab` to vim while typing and to the workbench in normal mode', () => {
		assert.equal(takes('insert', '<Tab>', NEXT_EDITOR), true, 'indent');
		assert.equal(takes('normal', '<Tab>', NEXT_EDITOR), false, 'the engine binds no `<Tab>` outside insert');
	});

	it('keeps `Escape` vim\'s in every state, which is the one gesture no state may lose', () => {
		for (const state of ATTACHED) {
			assert.equal(takes(state, '<Esc>', STOP_EDITING), true, `<Esc> leaves ${state}`);
		}
		assert.equal(takes('viewer', '<Esc>', STOP_EDITING), false, 'and the box-closing rule is the viewer\'s');
	});
});

describe('vimEditorPolicy · the states that share a context', () => {

	it('answers replace mode as insert, because the engine matches it against insert\'s rows', () => {
		assert.equal(takes('replace', '<C-w>', CLOSE_EDITOR), true);
		assert.equal(takes('replace', '<C-b>', TOGGLE_SIDEBAR), false);
		assert.equal(engineContextOf('replace'), 'insert');
	});

	it('answers visual mode as normal, because a contextless row matches both', () => {
		assert.equal(takes('visual', '<C-b>', TOGGLE_SIDEBAR), true);
		assert.equal(takes('visual', '<C-w>', CLOSE_EDITOR), false);
		assert.equal(engineContextOf('visual'), 'visual');
	});

	it('has no context for the viewer at all', () => {
		assert.equal(engineContextOf('viewer'), undefined);
	});
});

describe('vimEditorPolicy · the two commands the workbench keeps everywhere', () => {

	it('keeps the quick pick and the command palette in every state, over chords the engine binds', () => {
		assert.equal(vimClaimsKey('<C-p>', 'normal'), true, '`<C-p>` is `k` — so this is the exception, not a gap in the table');

		for (const state of ATTACHED) {
			assert.equal(takes(state, '<C-p>', QUICK_OPEN), false, `Ctrl+P opens the quick pick in ${state}`);
			assert.equal(takes(state, '<F1>', SHOW_COMMANDS), false, `F1 opens the command palette in ${state}`);
		}
	});

	it('names commands rather than chords, so a secondary binding is covered by the row it belongs to', () => {
		assert.deepEqual([...ALWAYS_WORKBENCH_COMMANDS].sort(), [SHOW_COMMANDS, QUICK_OPEN].sort());
		assert.equal(takes('normal', '<C-e>', QUICK_OPEN), false, '`Ctrl+E` is the quick pick\'s second chord and the engine\'s line scroll');
	});
});

describe('vimEditorPolicy · what is never contested', () => {

	it('gives the editor every key no rule resolves for, in every attached state', () => {
		for (const state of ATTACHED) {
			assert.equal(takes(state, '<C-y>', undefined), true, `an unbound chord is the editor's in ${state}`);
			assert.equal(takes(state, 'x', undefined), true, `a bare character is the editor's in ${state}`);
		}
	});

	it('gives the editor a key whose command the takeover already dropped', () => {
		const dropped = 'editor.action.formatDocument';
		assert.equal(keepReason({ command: dropped, when: undefined }), undefined, 'not in the keep-set');
		assert.equal(takes('insert', '<C-i>', dropped), true);
	});

	it('gives the editor a bare character even where the workbench keeps a rule for it', () => {
		assert.notEqual(keepReason({ command: EDIT_FILE, when: undefined }), undefined, '`V` is a keymap row');
		assert.equal(takes('normal', 'V', EDIT_FILE), true, 'visual-line — so `:q` is the way back to the viewer');
		assert.equal(takes('insert', 'W', 'tscode.file.toggleWordWrap'), true, 'and a `W` typed is a `W`');
	});
});

describe('vimEditorPolicy · the engine\'s own table', () => {

	it('claims a chord only in the contexts `vim.js` gives it a live row in', () => {
		assert.deepEqual(ATTACHED.map(state => vimClaimsKey('<C-w>', state)), [false, true, true, false],
			'`<C-w>`: normal is the `idle` row, insert and replace erase a word, visual has nothing');
		assert.deepEqual(ATTACHED.map(state => vimClaimsKey('<C-b>', state)), [true, false, false, true],
			'`<C-b>`: a contextless row, so normal and visual and never insert');
		assert.deepEqual(ATTACHED.map(state => vimClaimsKey('<C-u>', state)), [true, true, true, true],
			'`<C-u>`: two rows — scroll outside insert, delete to line start inside it');
	});

	it('claims every printable character wherever vim is attached, and nothing in the viewer', () => {
		for (const key of ['x', 'V', '/', '1']) {
			assert.equal(vimClaimsKey(key, 'insert'), true);
			assert.equal(vimClaimsKey(key, 'normal'), true);
			assert.equal(vimClaimsKey(key, 'viewer'), false);
		}
	});

	it('claims nothing for a chord it has no row for, or for a key the frontend could not spell', () => {
		assert.equal(vimClaimsKey('<C-F5>', 'normal'), false);
		assert.equal(vimClaimsKey('<S-Tab>', 'insert'), false, '`<Tab>` is insert\'s; its shifted form is not');
		assert.equal(vimClaimsKey(undefined, 'normal'), false);
	});
});
