/*---------------------------------------------------------------------------------------------
 *  The policy behind `?`, asserted without a resolver.
 *
 *  `keysPolicy.ts` decides which rows a user is shown, in which order, under which group — the
 *  half of `?` that no paint is in. The two lookups it does not own arrive through `IKeysSource`,
 *  so a stub source is the whole test rig: the live resolver's "no rule of this applies here" and
 *  the command registries' "nothing registers this" are both an `undefined` from the source, and
 *  what this file checks is what the policy does with them.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KeyCode } from '../../src/vs/base/common/keyCodes.js';
import type { IKeymapRow } from '../../src/vs/workbench/browser/tauri/keymap.js';
import { editorIdOf, KEYMAP, rowsFor, viewIdOf } from '../../src/vs/workbench/browser/tauri/keymap.js';
import type { IKeyFocus, IKeysSource } from '../../src/vs/workbench/contrib/keybindings/tauri/keysPolicy.js';
import { KEY_GROUPS, keyEntries, keyGroupOf, rowInFocus } from '../../src/vs/workbench/contrib/keybindings/tauri/keysPolicy.js';

/**
 * The command a frontend's rule for a row binds, as both of them answer it: the row's own id where
 * the frontend implements its wrapper, and what it forwards to where it does not. The stub takes
 * the second arm, so a forwarding row's entry names a command that is not its `id`.
 */
const forwarding: IKeysSource['command'] = row => row.forwards ?? row.id;

/** A source that answers for everything: the key is the row's id, the title is its id upper-cased. */
const answersAll: IKeysSource = {
	command: forwarding,
	key: row => row.id,
	title: row => row.id.toUpperCase()
};

/** A source that answers for everything but the ids given, in the half named. */
function silentOn(half: 'key' | 'title', ...ids: string[]): IKeysSource {
	return {
		command: forwarding,
		key: row => half === 'key' && ids.includes(row.id) ? undefined : row.id,
		title: row => half === 'title' && ids.includes(row.id) ? undefined : row.id.toUpperCase()
	};
}

function row(id: string, scope: IKeymapRow['scope']): IKeymapRow {
	return { id, scope, keys: [KeyCode.KeyA] };
}

/** The keyboard in no view and no editor, which is every `global` row and nothing else. */
const nowhere: IKeyFocus = { viewId: undefined, editorId: undefined };

/** The keyboard in the thing a scope names, so a case about the group is not also one about focus. */
function focusOn(scope: IKeymapRow['scope']): IKeyFocus {
	return { viewId: viewIdOf(scope), editorId: editorIdOf(scope) };
}

/** Every `global` row of the real map, which is the half of it no focus can take away. */
const globalIds = new Set(rowsFor('gui').filter(candidate => candidate.scope === 'global').map(candidate => candidate.id));

describe('keysPolicy · the group', () => {

	it('is the focused thing\'s for a view row and an editor row, and the workbench\'s for a global one', () => {
		assert.equal(keyGroupOf(row('a', 'view:workbench.scm')), 'focused');
		assert.equal(keyGroupOf(row('b', 'editor:workbench.editors.files.textFileEditor')), 'focused');
		assert.equal(keyGroupOf(row('c', 'global')), 'workbench');
	});

	it('orders the focused thing\'s keys before the ones that work anywhere', () => {
		assert.deepEqual(KEY_GROUPS, ['focused', 'workbench']);

		const entries = keyEntries([
			row('global-first', 'global'),
			row('scoped-second', 'view:workbench.scm')
		], answersAll, focusOn('view:workbench.scm'));

		assert.deepEqual(entries.map(entry => entry.id), ['scoped-second', 'global-first']);
		assert.deepEqual(entries.map(entry => entry.group), ['focused', 'workbench']);
	});

	it('keeps the map\'s own order within a group', () => {
		const entries = keyEntries([
			row('second', 'global'),
			row('first', 'global')
		], answersAll, nowhere);

		assert.deepEqual(entries.map(entry => entry.id), ['second', 'first']);
	});
});

describe('keysPolicy · what is left off', () => {

	it('leaves off a row the resolver gives no key — a rule the takeover dropped, or a `when` that does not hold', () => {
		const rows = [row('bound', 'global'), row('unbound', 'global')];

		assert.deepEqual(keyEntries(rows, silentOn('key', 'unbound'), nowhere).map(entry => entry.id), ['bound']);
	});

	it('leaves off a row whose command nothing registers, which is a phase that has not landed yet', () => {
		const rows = [row('landed', 'global'), row('unlanded', 'global')];

		assert.deepEqual(keyEntries(rows, silentOn('title', 'unlanded'), nowhere).map(entry => entry.id), ['landed']);
	});

	it('lists a command once however many rows it has', () => {
		const digits = KEYMAP.filter(candidate => candidate.id === 'tscode.showViewContainer');
		assert.equal(digits.length, 9, 'the nine digits are still nine rows');

		assert.deepEqual(keyEntries(digits, answersAll, nowhere).map(entry => entry.id), ['tscode.showViewContainer']);
	});

	it('never reaches a row the other surface keeps to itself, even from a source that answers for everything', () => {
		const ids = new Set(keyEntries(rowsFor('gui'), answersAll, focusOn('editor:workbench.editors.files.textFileEditor'))
			.map(entry => entry.id));

		for (const id of ['tscode.quit', 'tscode.editFile', 'tscode.showContextMenu']) {
			assert.ok(!ids.has(id), `${id} is an \`only: 'tui'\` row and does nothing here`);
			assert.ok(KEYMAP.some(candidate => candidate.id === id), `${id} is still a row of the map`);
		}
	});
});

describe('keysPolicy · the entry', () => {

	it('carries the row\'s own id, the source\'s key and the source\'s title', () => {
		const [entry] = keyEntries([row('tscode.scm.stage', 'view:workbench.scm')], {
			command: () => 'tscode.scm.stage',
			key: () => 'A',
			title: () => 'Stage Changes'
		}, focusOn('view:workbench.scm'));

		assert.deepEqual(entry, {
			id: 'tscode.scm.stage',
			command: 'tscode.scm.stage',
			args: undefined,
			key: 'A',
			title: 'Stage Changes',
			group: 'focused'
		});
	});

	it('takes every row of the real map that a source can answer for and the keyboard is in', () => {
		const focus = focusOn('view:workbench.scm');
		const entries = keyEntries(rowsFor('gui'), answersAll, focus);
		const reachable = new Set(rowsFor('gui').filter(candidate => rowInFocus(candidate, focus)).map(candidate => candidate.id));
		const ids = new Set(rowsFor('gui').map(candidate => candidate.id));

		assert.equal(entries.length, reachable.size);
		assert.ok(entries.length > 20, 'the source control pane and the workbench are not a handful');
		assert.ok(reachable.size < ids.size, 'and they are not the whole map either');
	});
});

describe('keysPolicy · what accepting an entry runs', () => {

	it('is the command the frontend\'s rule binds, which for a forwarding row is not the row\'s id', () => {
		const [stage] = keyEntries(KEYMAP.filter(candidate => candidate.id === 'tscode.scm.stage'),
			answersAll, focusOn('view:workbench.scm'));

		assert.equal(stage.id, 'tscode.scm.stage');
		assert.equal(stage.command, 'git.stage', 'the source names the command, and the entry carries its answer');
	});

	it('carries the rule\'s own argument, which is how one command takes nine keys', () => {
		const digits = KEYMAP.filter(candidate => candidate.id === 'tscode.showViewContainer');
		const [entry] = keyEntries(digits, answersAll, nowhere);

		assert.equal(digits.length, 9);
		assert.equal(entry.args, digits[0].args, 'the entry is the first row, so it runs with the first row\'s argument');
		assert.equal(entry.args, 0, 'the first container is index 0 — an argument a falsy check would drop');
	});

	it('carries no argument for a row whose rule has none, which is not the same as one that is `undefined`', () => {
		const [entry] = keyEntries([row('tscode.scm.filter', 'view:workbench.scm')], answersAll, focusOn('view:workbench.scm'));

		assert.equal('args' in entry, true);
		assert.equal(entry.args, undefined);
	});
});

describe('keysPolicy · the panel the keyboard is in', () => {

	it('is where a `view:` row has to be for the row to be on the list', () => {
		assert.ok(rowInFocus(row('a', 'view:workbench.scm'), focusOn('view:workbench.scm')));
		assert.ok(!rowInFocus(row('a', 'view:workbench.scm'), focusOn('view:workbench.view.search')));
		assert.ok(!rowInFocus(row('a', 'view:workbench.scm'), nowhere));
	});

	it('is where an `editor:` row has to be too — an editor that is open but not focused is not it', () => {
		const editor = 'editor:workbench.editors.files.textFileEditor' as const;

		assert.ok(rowInFocus(row('a', editor), focusOn(editor)));
		assert.ok(!rowInFocus(row('a', editor), focusOn('view:workbench.explorer.fileView')));
		assert.ok(!rowInFocus(row('a', editor), nowhere));
	});

	it('never takes a `global` row away, whatever has the keyboard', () => {
		for (const focus of [nowhere, focusOn('view:workbench.scm'), focusOn('editor:workbench.editors.files.textFileEditor')]) {
			assert.ok(rowInFocus(row('a', 'global'), focus));
		}
	});

	it('leaves off the other panels\' rows and keeps its own and the workbench\'s', () => {
		const ids = new Set(keyEntries(rowsFor('gui'), answersAll, focusOn('view:workbench.scm')).map(entry => entry.id));

		for (const id of ['tscode.scm.stage', 'tscode.scm.filter', 'scm.setActiveProvider']) {
			assert.ok(ids.has(id), `${id} is a key of the pane that has the keyboard`);
		}
		for (const id of ['tscode.search.filter', 'tscode.filterExplorer', 'tscode.sapling.refresh', 'tscode.scmGraph.refresh', 'tscode.file.edit']) {
			assert.ok(!ids.has(id), `${id} belongs to a panel that does not have the keyboard`);
		}
		for (const id of globalIds) {
			assert.ok(ids.has(id), `${id} works anywhere`);
		}
	});

	// The mirror of the row above, on the first rows this frontend keeps to *itself*: an
	// `only: 'gui'` row is a row of `rowsFor('gui')` like any other, and the list treats it as one.
	it('lists the panel rows, and only where the panel has the keyboard', () => {
		const find = ['workbench.action.terminal.focusFind', 'workbench.action.terminal.findNext', 'workbench.action.terminal.hideFind'];
		const terminal = new Set(keyEntries(rowsFor('gui'), answersAll, focusOn('view:terminal')).map(entry => entry.id));
		const elsewhere = new Set(keyEntries(rowsFor('gui'), answersAll, focusOn('view:workbench.scm')).map(entry => entry.id));

		for (const id of find) {
			assert.ok(terminal.has(id), `${id} is a key of the panel that has the keyboard`);
			assert.ok(!elsewhere.has(id), `${id} is offered from a pane that has no find widget`);
		}

		// The toggle is the one that is not the panel's: it is what reaches a panel that is not on
		// screen, so it is a `global` row and the list says so in both places.
		for (const ids of [terminal, elsewhere]) {
			assert.ok(ids.has('workbench.action.terminal.toggleTerminal'), 'the toggle works anywhere');
		}
	});

	it('does not let a row it left off take the place of one the focused panel has', () => {
		const rows = [row('shared', 'view:workbench.view.search'), row('shared', 'view:workbench.scm')];

		assert.deepEqual(keyEntries(rows, answersAll, focusOn('view:workbench.scm')).map(entry => entry.id), ['shared']);
	});
});
