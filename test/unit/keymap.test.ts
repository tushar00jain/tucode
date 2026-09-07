/*---------------------------------------------------------------------------------------------
 *  The keymap, asserted as data.
 *
 *  `keymap.ts` is the declaration the app registers from, the keyboard page is generated from, and
 *  `scripts/keymap-drift.mjs` measures against. That only works if the table is machine-readable
 *  and internally consistent, which is what this file checks: the scope expansion is the one in the
 *  module's header, every wall row carries its reason, and no two rows answer the same key under
 *  conditions nothing rules out at once.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KeyCode, KeyMod } from '../../src/vs/base/common/keyCodes.js';
import { ContextKeyExpr } from '../../src/vs/platform/contextkey/common/contextkey.js';
import type { IContext } from '../../src/vs/platform/contextkey/common/contextkey.js';
import type { IKeymapRow, KeymapScope, KeymapSurface } from '../../src/vs/workbench/browser/tauri/keymap.js';
import {
	editorIdOf, expandGuiScope, expandTuiScope, guiRuleId, guiRuleWhen, KEYMAP, KeymapDrift, keysFor, rowsFor, viewIdOf
} from '../../src/vs/workbench/browser/tauri/keymap.js';

/** What a row's `when` clause says, as a string, which is what two expressions compare as. */
function guiWhen(row: IKeymapRow): string {
	return expandGuiScope(row)?.serialize() ?? '';
}

/** The keys named as set, and every other key unset — what a `when` is evaluated against. */
function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T | undefined };
}

function rowsWith(id: string): IKeymapRow[] {
	return KEYMAP.filter(row => row.id === id);
}

describe('keymap · the table', () => {
	it('declares every command the keyboard answers a key with', () => {
		assert.equal(new Set(KEYMAP.map(row => row.id)).size, 76);
	});

	it('gives every row at least one key, primary first', () => {
		for (const row of KEYMAP) {
			assert.ok(row.keys.length > 0, `${row.id} has no key`);
			assert.ok(row.keys.every(key => Number.isInteger(key) && key > 0), `${row.id} has a key that is not a keybinding`);
		}
	});

	it('names a view or an editor pane in every non-global scope', () => {
		for (const row of KEYMAP) {
			const named = viewIdOf(row.scope) ?? editorIdOf(row.scope);
			assert.ok(row.scope === 'global' || (named !== undefined && named.length > 0), `${row.id} has an empty scope`);
		}
	});

	it('marks the rows this frontend already binds identically, and only those', () => {
		assert.deepEqual(KEYMAP.filter(row => row.stock).map(row => row.id), [
			'actions.find',
			'editor.action.nextMatchFindAction',
			'editor.action.previousMatchFindAction',
			'closeFindWidget',
			'notifications.hideToasts',
			'search.focus.nextInputBox',
			'search.focus.previousInputBox',
			'workbench.action.closeActiveEditor',
			'workbench.action.quickOpen',
			'workbench.action.showCommands',
			'workbench.action.terminal.findNext',
			'workbench.action.terminal.findPrevious',
			'workbench.action.terminal.focusFind',
			'workbench.action.terminal.hideFind',
			'workbench.action.terminal.toggleTerminal',
			'workbench.action.terminal.copySelection',
			'workbench.action.terminal.copyAndClearSelection',
			'workbench.action.terminal.paste',
			'workbench.action.terminal.focusNext',
			'workbench.action.terminal.focusPrevious',
			'workbench.action.terminal.scrollUpPage',
			'workbench.action.terminal.scrollDownPage',
			'workbench.action.toggleSidebarVisibility'
		]);
	});

	/**
	 * **A `stock: true` row registers no rule, so anything it declares beyond the chord is enforced
	 * by nothing.** The `Ctrl+W` row said `editorAreaFocus && editorIsOpen` while upstream's own
	 * rule — the one that actually answers the key — carries no `when` at all, and the key closed
	 * an editor tab from inside the explorer's `/` box. The model that replaced it is what this
	 * asserts: a stock row says only "we do not claim this key", and a key wanted somewhere
	 * narrower is claimed there, by a row of ours scoped to that surface.
	 */
	it('leaves a stock row nothing to declare but the chord upstream already answers', () => {
		for (const row of KEYMAP.filter(candidate => candidate.stock)) {
			assert.equal(row.extraWhen, undefined, `${row.id} declares a guard nothing evaluates`);
		}
	});
});

describe('keymap · the scope expansion', () => {
	// `!inputFocus` is not "the user is not typing" in this frontend: a focused Monaco sets the key
	// in every state, including the read-only viewer, so a `global` row on `!inputFocus` alone was
	// dead in an editor — `0`, `?`, `T` and the container digits all of them. `tscodeEditorCommands`
	// is the editor's own correction, and the pair is what `global` means here.
	it('expands `global` to not typing, which is `!inputFocus` or an editor reading commands', () => {
		assert.equal(guiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX] }), 'tscodeEditorCommands || !inputFocus');
	});

	it('expands `view:<id>` to the view being focused and its input not swallowing keys', () => {
		assert.equal(
			guiWhen({ id: 'x', scope: 'view:workbench.scm', keys: [KeyCode.KeyX] }),
			ContextKeyExpr.and(
				ContextKeyExpr.equals('focusedView', 'workbench.scm'),
				ContextKeyExpr.or(ContextKeyExpr.has('inputFocus').negate(), ContextKeyExpr.has('tscodeEditorCommands')))!.serialize());
	});

	// The other half of the same rule, and the one a widening could have broken: a box the user
	// deliberately entered still swallows every single-character row, because nothing publishes
	// `tscodeEditorCommands` while a box has the keyboard.
	it('leaves a focused box no way through, which is what keeps `0` out of a filter', () => {
		const when = ContextKeyExpr.deserialize(guiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX] }))!;

		assert.equal(when.evaluate(context({ inputFocus: true })), false, 'a `/` box types its own digits');
		assert.equal(when.evaluate(context({ inputFocus: true, tscodeEditorCommands: true })), true, 'a viewer is not typing');
		assert.equal(when.evaluate(context({})), true, 'and a focused tree was never typing at all');
	});

	it('expands `editor:<id>` to the pane being active and its text having focus — not to `!inputFocus`', () => {
		const when = guiWhen({ id: 'x', scope: 'editor:workbench.editors.files.textFileEditor', keys: [KeyCode.KeyX] });

		const rule = ContextKeyExpr.deserialize(when)!;
		for (const activeEditor of ['workbench.editors.files.textFileEditor', 'workbench.editors.textResourceEditor']) {
			assert.equal(rule.evaluate(context({ activeEditor, editorTextFocus: true })), true);
			assert.equal(rule.evaluate(context({ activeEditor, editorTextFocus: false })), false);
		}
		assert.equal(rule.evaluate(context({ activeEditor: 'workbench.editors.textDiffEditor', editorTextFocus: true })), false);
		assert.ok(!when.includes('inputFocus'), 'an editor key guarded on `!inputFocus` could never fire');
	});

	it('drops the `!inputFocus` half for a `whileEditing` row', () => {
		assert.equal(guiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX], whileEditing: true }), '');
		assert.equal(
			guiWhen({ id: 'x', scope: 'view:workbench.view.search', keys: [KeyCode.KeyX], whileEditing: true }),
			'focusedView == \'workbench.view.search\'');
	});

	// The expansion this app does not run, and the reason it is declared here anyway: it is what
	// `registerPaneCommand`/`registerTuiCommand` expand a row to, and what `scripts/keymap-drift.mjs`
	// holds a measured registration against. `editor:` has no editor pane to name in that spelling
	// and expands as a view, which is the whole reason `scope` is symbolic rather than a `when`.
	it('expands a row over `focusedView` and `!inputFocus` too', () => {
		const tuiWhen = (row: IKeymapRow) => expandTuiScope(row)?.serialize() ?? '';

		assert.equal(tuiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX] }), '!inputFocus');
		assert.equal(tuiWhen({ id: 'x', scope: 'view:workbench.scm', keys: [KeyCode.KeyX] }), '!inputFocus && focusedView == \'workbench.scm\'');
		assert.equal(
			tuiWhen({ id: 'x', scope: 'editor:workbench.editors.files.textFileEditor', keys: [KeyCode.KeyX] }),
			'!inputFocus && focusedView == \'workbench.editors.files.textFileEditor\'');
		assert.equal(tuiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX], whileEditing: true }), '');
		assert.equal(
			tuiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX], whileEditing: true, extraWhen: ContextKeyExpr.has('scmRepository') }),
			'scmRepository');
	});

	it('conjoins `extraWhen` last, so a row can say more than its scope', () => {
		assert.equal(
			guiWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX], whileEditing: true, extraWhen: ContextKeyExpr.has('scmRepository') }),
			'scmRepository');
	});

	// xterm draws a textarea, so `isEditableElement` counts a focused terminal and `inputFocus` is
	// set the whole time the user is typing at a shell — the same trap the `editor:` scope exists
	// for, one surface along.
	it('leaves no terminal row a guard a focused terminal would switch off', () => {
		const terminal = KEYMAP.filter(row => row.id.startsWith('workbench.action.terminal.'));

		assert.equal(terminal.length, 12, 'the panel\'s keys are find, toggle, the clipboard, the groups and the pages');
		for (const row of terminal) {
			assert.ok(!guiWhen(row).includes('inputFocus'), `${row.id} could never fire inside a terminal`);
		}
	});

	// The pair that closes the hole a stock row's guard used to pretend to fill: the key belongs to
	// the box that has the keyboard, and to upstream's rule everywhere else. `Ctrl+W` in a `/` box
	// closed an editor tab here, in a box where it should have erased a word.
	it('claims the two editing keys on a text box that is neither the editor area nor a shell', () => {
		const claimed = [
			['tscode.deleteWordLeft', KeyMod.CtrlCmd | KeyCode.KeyW],
			['tscode.deleteAllLeft', KeyMod.CtrlCmd | KeyCode.KeyU]
		] as const;

		for (const [id, chord] of claimed) {
			const [row] = rowsWith(id);
			const when = ContextKeyExpr.deserialize(guiWhen(row))!;

			assert.deepEqual([...keysFor(row, 'gui')], [chord]);
			assert.equal(when.evaluate(context({ inputFocus: true })), true, `${id} does not reach the box it exists for`);
			assert.equal(when.evaluate(context({ inputFocus: true, editorAreaFocus: true })), false, 'the editor area keeps upstream\'s `Ctrl+W`');
			assert.equal(when.evaluate(context({ inputFocus: true, terminalFocusInAny: true })), false, 'a shell reads its own control bytes');
			assert.equal(when.evaluate(context({})), false, 'a focused tree has no text to delete from');
		}
	});

	it('stands `Escape` down wherever the terminal owns it, so the shell and the find widget get it', () => {
		const [row] = rowsWith('tscode.stopEditingInput');
		const when = guiWhen(row);

		assert.ok(when.includes('!terminalFocusInAny'), '`Escape` at a shell prompt is the shell\'s');
		assert.ok(when.includes('!terminalFindFocused'), '`Escape` in the find box is the widget\'s own keyup');
		// The editor's find is the same shape one surface along, and here weight alone would have
		// got it wrong: `closeFindWidget` is registered at `EditorContrib`, below `KEYMAP_WEIGHT`.
		assert.ok(when.includes('!findWidgetVisible'), '`Escape` over an open find widget is upstream\'s own');
	});

	it('guards `Enter` in the source control box on the box, and nothing wider', () => {
		const [row] = rowsWith('tscode.scm.acceptInput');
		const when = ContextKeyExpr.deserialize(guiWhen(row))!;

		assert.deepEqual([...row.keys], [KeyCode.Enter]);
		assert.equal(row.forwards, 'scm.acceptInput');
		assert.equal(when.evaluate(context({
			focusedView: 'workbench.scm',
			inputFocus: true,
			scmRepository: true
		})), true);
		assert.equal(when.evaluate(context({
			focusedView: 'workbench.explorer.fileView',
			inputFocus: false,
			scmRepository: true
		})), false, 'an open repository must not consume Explorer Return');
		assert.equal(when.evaluate(context({
			focusedView: 'workbench.scm',
			inputFocus: false,
			scmRepository: true
		})), false, 'the SCM list keeps Return while its input is not being edited');
	});
});

describe('keymap · the overlays no row applies inside', () => {
	/**
	 * Accessibility stays on, and the accessible view and the accessibility help are the two places
	 * where its keyboard and this table's would otherwise both answer — an embedded editor plus a
	 * toolbar, whose `Tab` is the toolbar's. Standing every row down inside them is the same move
	 * `tscode.stopEditingInput` already makes for the quick pick, and it costs no key: the
	 * `stock: true` chords are upstream's own rules, which this frontend never re-registers.
	 */
	it('stands every registered row down while an accessibility overlay is up', () => {
		for (const row of rowsFor('gui').filter(candidate => !candidate.stock)) {
			const when = guiRuleWhen(row)?.serialize() ?? '';

			assert.ok(when.includes('!accessibleViewIsShown'), `${row.id} answers a key while the accessible view is up`);
			assert.ok(when.includes('!accessibilityHelpIsShown'), `${row.id} answers a key while the accessibility help is up`);
		}
	});

	it('conjoins the scope expansion rather than replacing it', () => {
		const row: IKeymapRow = { id: 'x', scope: 'view:workbench.scm', keys: [KeyCode.KeyX] };

		assert.equal(guiRuleWhen(row)!.serialize(), ContextKeyExpr.and(
			expandGuiScope(row),
			ContextKeyExpr.has('accessibleViewIsShown').negate(),
			ContextKeyExpr.has('accessibilityHelpIsShown').negate())!.serialize());
	});

	it('guards a row whose scope expands to nothing at all', () => {
		assert.equal(
			guiRuleWhen({ id: 'x', scope: 'global', keys: [KeyCode.KeyX], whileEditing: true })!.serialize(),
			ContextKeyExpr.and(
				ContextKeyExpr.has('accessibleViewIsShown').negate(),
				ContextKeyExpr.has('accessibilityHelpIsShown').negate())!.serialize());
	});
});

describe('keymap · the walls', () => {
	/** Whether a row differs between the surfaces at all — by not being on one, or by its chord. */
	const drifts = (row: IKeymapRow) => row.only !== undefined || row.guiKeys !== undefined;

	it('gives every drifting row a reason', () => {
		for (const row of KEYMAP.filter(drifts)) {
			assert.ok(row.reason && row.reason.length > 20, `${row.id} declares a divergence with no reason`);
		}
	});

	it('leaves a reason only where one is owed', () => {
		for (const row of KEYMAP.filter(candidate => candidate.reason !== undefined)) {
			assert.ok(drifts(row), `${row.id} carries a reason and declares no divergence`);
		}
	});

	/**
	 * **The divergence a row cannot declare.** `only` and `guiKeys` are what this table states, so
	 * `reason` covers them and the two tests above hold them to it. `surfaceDrift` is the other
	 * kind: a difference in a registration outside this repo, visible only to
	 * `scripts/keymap-drift.mjs`. So this file can check that each entry is keyed to a real
	 * comparison and says something, and the instrument checks the half that needs the measurement —
	 * that every difference has an entry, and every entry still has a difference.
	 */
	it('keys every per-surface reason to a comparison the instrument makes, and says something', () => {
		const kinds = new Set<string>(Object.values(KeymapDrift));

		for (const row of KEYMAP.filter(candidate => candidate.surfaceDrift !== undefined)) {
			for (const [kind, prose] of Object.entries(row.surfaceDrift!)) {
				assert.ok(kinds.has(kind), `${row.id} explains ${JSON.stringify(kind)}, which nothing measures`);
				assert.ok(prose && prose.length > 20, `${row.id}'s ${kind} reason says nothing`);
			}
		}
	});

	// The two rows a measured registration guards differently, listed the way the walls above are:
	// a row that grows or loses one is a line in this diff rather than a silent change to what the
	// gate lets through.
	it('carries a per-surface reason on the two rows whose guards are not this table\'s', () => {
		assert.deepEqual(
			KEYMAP.filter(row => row.surfaceDrift).map(row => `${row.id} · ${Object.keys(row.surfaceDrift!).join(', ')}`),
			[
				'tscode.stopEditingInput · extra guard terms',
				'workbench.action.closeActiveEditor · extra guard terms'
			]);
	});

	it('keeps the terminal-only rows out of this frontend, and everything else in', () => {
		const terminalOnly = KEYMAP.filter(row => row.only === 'tui').map(row => row.id);

		assert.deepEqual([...new Set(terminalOnly)], [
			'markdown.showPreviewToSide',
			'markdown.showSource',
			'tscode.editFile',
			'tscode.quit',
			'tscode.showContextMenu'
		]);
		for (const id of terminalOnly) {
			assert.ok(!rowsFor('gui').some(row => row.id === id), `${id} is a terminal-only row and this frontend carries it`);
		}
		assert.equal(rowsFor('tui').length + rowsFor('gui').length, KEYMAP.length + KEYMAP.filter(row => row.only === undefined).length);
	});

	// The other wall, walked in the other direction. Most of these are the terminal panel, which
	// needs a panel region, and the editor's find widget, which needs a window to be drawn in; the
	// two editing keys are the other shape `only: 'gui'` takes — a behaviour a box has anywhere,
	// where only a window can carry it as a row.
	it('keeps this frontend\'s own rows out of the other surface, and every one of them in it', () => {
		const guiOnly = KEYMAP.filter(row => row.only === 'gui').map(row => row.id);

		assert.deepEqual(guiOnly, [
			'actions.find',
			'editor.action.nextMatchFindAction',
			'editor.action.previousMatchFindAction',
			'closeFindWidget',
			'notifications.hideToasts',
			'tscode.deleteAllLeft',
			'tscode.deleteWordLeft',
			'workbench.action.terminal.findNext',
			'workbench.action.terminal.findPrevious',
			'workbench.action.terminal.focusFind',
			'workbench.action.terminal.hideFind',
			'workbench.action.terminal.toggleTerminal',
			'workbench.action.terminal.copySelection',
			'workbench.action.terminal.copyAndClearSelection',
			'workbench.action.terminal.paste',
			'workbench.action.terminal.focusNext',
			'workbench.action.terminal.focusPrevious',
			'workbench.action.terminal.scrollUpPage',
			'workbench.action.terminal.scrollDownPage'
		]);
		for (const id of guiOnly) {
			assert.ok(rowsFor('gui').some(row => row.id === id), `${id} is this frontend's row and it does not carry it`);
			assert.ok(!rowsFor('tui').some(row => row.id === id), `${id} reaches a frontend with no terminal panel`);
		}
	});
});

describe('keymap · one key, one command', () => {
	/**
	 * Whether nothing in the two rows' guards can hold at once. Three things prove it by reading,
	 * and they are the three the map itself relies on:
	 *
	 * - two `view:` scopes, because `focusedView` holds one id;
	 * - an `editor:` scope against one scoped to a view, because a focused editor is not a focused
	 *   view;
	 * - a term against its own negation, which is the split upstream puts `Tab` and `0` on.
	 *
	 * **An `editor:` scope no longer rules out a `global` row**, and that is the point of
	 * `tscodeEditorCommands`: a global key is live in the viewer now, so the two are separated by
	 * their keys or not at all. The terms are read off `extraWhen` rather than off the serialized
	 * `when`, because the scope's own half is an `or` that `ContextKeyExpr.and` distributes — and a
	 * scope has never been what tells two rows apart anyway; the arms above are.
	 */
	function disjoint(a: IKeymapRow, b: IKeymapRow): boolean {
		const [viewA, viewB] = [viewIdOf(a.scope), viewIdOf(b.scope)];
		if (viewA !== undefined && viewB !== undefined) {
			return viewA !== viewB;
		}

		const [editorA, editorB] = [editorIdOf(a.scope), editorIdOf(b.scope)];
		for (const [editor, other] of [[editorA, b], [editorB, a]] as const) {
			if (editor !== undefined && viewIdOf(other.scope) !== undefined) {
				return true;
			}
		}

		const terms = (row: IKeymapRow) => row.extraWhen?.serialize().split(' && ') ?? [];

		return terms(a).some(term => terms(b).includes(term.startsWith('!') ? term.slice(1) : `!${term}`));
	}

	/**
	 * Two rows clash when they answer the same key and neither `when` rules the other out. The keys
	 * are read through `keysFor`, because a row's chord is a question with a surface in it: the two
	 * cycling pairs collide with `tscode.completeFilter` on the terminal's bare `Tab` and are told
	 * apart by `tscodeFiltering`, and here they are not on that key at all.
	 */
	function clashes(rows: readonly IKeymapRow[], surface: KeymapSurface = 'gui'): string[] {
		const found: string[] = [];
		for (let i = 0; i < rows.length; i++) {
			for (let j = i + 1; j < rows.length; j++) {
				const shared = keysFor(rows[i], surface).filter(key => keysFor(rows[j], surface).includes(key));
				if (shared.length === 0 || rows[i].id === rows[j].id || disjoint(rows[i], rows[j])) {
					continue;
				}

				found.push(`${rows[i].id} and ${rows[j].id} both answer ${shared[0]} under ${guiWhen(rows[i])} / ${guiWhen(rows[j])}`);
			}
		}

		return found;
	}

	it('leaves no key two commands both answer in this frontend', () => {
		assert.deepEqual(clashes(rowsFor('gui').filter(row => !row.stock)), []);
	});

	it('leaves no key two commands both answer on the other surface either', () => {
		assert.deepEqual(clashes(rowsFor('tui').filter(row => !row.stock), 'tui'), []);
	});

	// **Bare `Tab` is the browser's again**, everywhere but the one box that has no traversal to
	// hand back to it. Browser focus traversal is a default action rather than a rule, so no
	// resolver could ever have filtered it — the port had it half-taken instead, swallowed where a
	// row matched and walking to the next button where none did. The cycling rows carry the
	// modifier now, which is also what makes them live in an editor and in a text box.
	it('leaves this frontend one bare `Tab`, and it is the `/` box\'s completion', () => {
		const tab = rowsFor('gui').filter(row => keysFor(row, 'gui').includes(KeyCode.Tab));
		const shiftTab = rowsFor('gui').filter(row => keysFor(row, 'gui').includes(KeyMod.Shift | KeyCode.Tab));

		assert.deepEqual(tab.map(row => row.id), ['tscode.completeFilter']);
		assert.deepEqual(shiftTab.map(row => row.id), ['tscode.completeFilterBack']);
	});

	// The other half of the same split, and the first chord in the table a wire cannot carry: a
	// control byte is a letter's, so `Ctrl+Tab` is `Tab` on the wire.
	it('splits the cycling gesture on the part that has the keyboard, at `Ctrl+Tab`', () => {
		const cycling = rowsFor('gui').filter(row => keysFor(row, 'gui').includes(KeyMod.CtrlCmd | KeyCode.Tab));
		const back = rowsFor('gui').filter(row => keysFor(row, 'gui').includes(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Tab));

		assert.deepEqual(cycling.map(row => row.id), ['tscode.focusNextView', 'workbench.action.nextEditor']);
		assert.deepEqual(back.map(row => row.id), ['tscode.focusPreviousView', 'workbench.action.previousEditor']);
		assert.deepEqual(clashes([...cycling, ...back]), []);
	});

	// And the unsplit chord is untouched: `guiKeys` is a second chord, never a move.
	it('leaves every one of those rows on bare `Tab` where the chord did not split', () => {
		const tui = rowsFor('tui');
		const on = (key: number) => tui.filter(row => keysFor(row, 'tui').includes(key)).map(row => row.id);

		assert.deepEqual(on(KeyCode.Tab), ['tscode.completeFilter', 'tscode.focusNextView', 'workbench.action.nextEditor']);
		assert.deepEqual(on(KeyMod.Shift | KeyCode.Tab), ['tscode.completeFilterBack', 'tscode.focusPreviousView', 'workbench.action.previousEditor']);
		assert.deepEqual(on(KeyMod.CtrlCmd | KeyCode.Tab), [], 'a terminal cannot deliver a chord `Tab` already is');
	});

	it('reads a row\'s chord per surface, and only where the row names a second one', () => {
		const [cycle] = rowsWith('tscode.focusNextView');
		const [complete] = rowsWith('tscode.completeFilter');

		assert.deepEqual([...keysFor(cycle, 'tui')], [KeyCode.Tab]);
		assert.deepEqual([...keysFor(cycle, 'gui')], [KeyMod.CtrlCmd | KeyCode.Tab]);
		assert.deepEqual([...keysFor(complete, 'gui')], [...keysFor(complete, 'tui')]);
	});

	it('splits `0` the same way', () => {
		const zero = rowsFor('gui').filter(row => row.keys.includes(KeyCode.Digit0));

		assert.deepEqual(zero.map(row => row.id), ['tscode.focusEditorArea', 'workbench.action.focusSideBar']);
		assert.deepEqual(clashes(zero), []);
	});

	it('gives each of the nine container digits its own argument', () => {
		const digits = rowsWith('tscode.showViewContainer');

		assert.deepEqual(digits.map(row => row.keys[0]), [
			KeyCode.Digit1, KeyCode.Digit2, KeyCode.Digit3, KeyCode.Digit4, KeyCode.Digit5,
			KeyCode.Digit6, KeyCode.Digit7, KeyCode.Digit8, KeyCode.Digit9
		]);
		assert.deepEqual(digits.map(row => row.args), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe('keymap · what stands in for what', () => {
	it('forwards to a command this tree has, wherever a row is a wrapper', () => {
		assert.deepEqual(KEYMAP.filter(row => row.forwards).map(row => `${row.id} → ${row.forwards}`), [
			'tscode.file.toggleFold → editor.toggleFold',
			'tscode.file.toggleWordWrap → editor.action.toggleWordWrap',
			'tscode.focusEditorArea → workbench.action.focusActiveEditorGroup',
			'tscode.sapling.refresh → sapling.refresh',
			'tscode.scm.acceptInput → scm.acceptInput',
			'tscode.scm.refresh → git.refresh',
			'tscode.scm.stage → git.stage',
			'tscode.scm.unstage → git.unstage',
			'tscode.scmGraph.refresh → workbench.scm.action.graph.refresh'
		]);
	});

	it('leaves `?` on upstream\'s own id, which this tree registers nowhere', () => {
		const [keys] = rowsWith('workbench.action.openGlobalKeybindings');

		assert.equal(keys.scope, 'global');
		assert.equal(keys.keys[0], KeyMod.Shift | KeyCode.Slash);
		assert.equal(keys.keys.length, 2, '`Ctrl+K Ctrl+S` is upstream\'s own chord and stays the second binding');
	});

	// The takeover filter keeps only the commands it is told about, so the id a row's rule is
	// registered under and the id named to the keep-set have to be one string. They are: the
	// contribution derives both from this function inside one loop body, which is the shape that
	// makes "a row was added and not declared" impossible rather than merely caught. What is left
	// to assert is that the derivation is total — every row yields an id to name.
	it('derives one command id per row for the rule and the keep-set alike', () => {
		const implemented = new Set(['tscode.scm.stage']);

		for (const row of rowsFor('gui').filter(candidate => !candidate.stock)) {
			assert.ok(guiRuleId(row, implemented).length > 0, `${row.id} binds no command`);
		}

		assert.equal(guiRuleId(rowsWith('tscode.scm.stage')[0], implemented), 'tscode.scm.stage');
		assert.equal(guiRuleId(rowsWith('tscode.scm.unstage')[0], implemented), 'git.unstage');
		assert.equal(guiRuleId(rowsWith('toggleSearchRegex')[0], implemented), 'toggleSearchRegex');
	});

	it('scopes every pane key to a view id the workbench actually publishes', () => {
		const known = new Set<KeymapScope>([
			'view:workbench.explorer.fileView',
			'view:workbench.scm',
			'view:workbench.scm.history',
			'view:workbench.view.search',
			'view:workbench.sapling.smartlogView',
			'view:terminal',
			'view:workbench.editor.markdownPreview',
			'editor:workbench.editors.files.textFileEditor',
			'global'
		]);

		for (const row of KEYMAP) {
			assert.ok(known.has(row.scope), `${row.id} is scoped to ${row.scope}, which no view publishes`);
		}
	});
});
