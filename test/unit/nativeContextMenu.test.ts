import assert from 'node:assert/strict';
import test from 'node:test';
import { Action, ActionRunner, Separator, SubmenuAction } from '../../src/vs/base/common/actions.js';
import { NativeContextMenuSession, NativeSubmenuAction } from '../../src/editor/nativeContextMenu.js';

test('native menu preserves action identities, submenus, states, labels and custom runner context', async () => {
	const first = new Action('duplicate', '&&First');
	const second = new Action('duplicate', 'Second');
	second.checked = true;
	const disabled = new Action('disabled', 'Disabled', undefined, false);
	const calls: unknown[] = [];
	class Runner extends ActionRunner {
		protected override async runAction(action: Action, context?: unknown): Promise<void> { calls.push(action, context); }
	}
	const runner = new Runner();
	const session = new NativeContextMenuSession({
		getAnchor: () => ({ x: 1, y: 2 }),
		getActions: () => [first, new Separator(), new SubmenuAction('sub', 'More', [second, disabled])],
		actionRunner: runner,
		getActionsContext: event => ({ event, original: true })
	}, () => ({ characters: '', modifiers: 0, label: '⌘K ⌘C' }), cancelled => calls.push(cancelled), error => { throw error; }, action => calls.push(action.id));
	assert.equal(session.items[0].label, 'First');
	assert.equal(session.items[0].keyLabel, '⌘K ⌘C');
	assert.deepEqual(session.items[1], { separator: true });
	assert.equal(session.items[2].children![0].checked, true);
	assert.equal(session.items[2].children![1].enabled, false);
	const event = { altKey: true };
	session.finish(session.items[2].children![0].id, event);
	session.finish(session.items[0].id);
	await Promise.resolve();
	assert.deepEqual(calls, [false, 'duplicate', second, { event, original: true }]);
	// The delegate owns its runner: it must remain usable after the menu closes.
	await runner.run(first);
	assert.equal(calls[4], first);
	runner.dispose();
});

test('cancel, unknown ids and disabled selections dismiss exactly once without running', () => {
	for (const id of [undefined, 999, 0]) {
		const action = new Action('disabled', 'Disabled', undefined, false, async () => { assert.fail('disabled action ran'); });
		const hidden: boolean[] = [];
		const session = new NativeContextMenuSession({ getAnchor: () => ({ x: 0, y: 0 }), getActions: () => [action] },
			() => undefined, cancelled => hidden.push(cancelled), () => assert.fail(), () => assert.fail());
		session.finish(id);
		session.finish(id);
		assert.deepEqual(hidden, [true]);
	}
});

test('default runner reports action failures after closing the native menu', async () => {
	const error = new Error('command failed');
	const events: unknown[] = [];
	const action = new Action('error', 'Error', undefined, true, async () => { throw error; });
	const session = new NativeContextMenuSession({
		getAnchor: () => ({ x: 0, y: 0 }), getActions: () => [action], skipTelemetry: true
	}, () => undefined, value => events.push(value), value => events.push(value), () => assert.fail());
	session.finish(0);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(events, [false, error]);
});

test('native submenus load once on demand, preserve icons and run the selected child', async () => {
	let loads = 0;
	let opens = 0;
	const child = new Action('file', 'file.ts', undefined, true, async () => { opens++; });
	const folder = new NativeSubmenuAction('folder', 'Folder', async () => { loads++; return [child]; }, '/repo/Folder');
	const hidden: boolean[] = [];
	const session = new NativeContextMenuSession({ getAnchor: () => ({ x: 0, y: 0 }), getActions: () => [folder] },
		() => undefined, cancelled => hidden.push(cancelled), error => { throw error; }, () => {});
	assert.equal(loads, 0);
	assert.equal(session.items[0].lazy, true);
	assert.equal(session.items[0].iconResource, '/repo/Folder');
	const first = session.expand(session.items[0].id!);
	assert.equal(session.expand(session.items[0].id!), first);
	const items = (await first)!;
	assert.equal(loads, 1);
	assert.notEqual(items[0].id, session.items[0].id);
	session.finish(items[0].id);
	await Promise.resolve();
	assert.equal(opens, 1);
	assert.deepEqual(hidden, [false]);
});

test('closing a native menu discards in-flight submenu results', async () => {
	let resolve!: (actions: Action[]) => void;
	const folder = new NativeSubmenuAction('folder', 'Folder', () => new Promise(r => { resolve = r; }));
	const session = new NativeContextMenuSession({ getAnchor: () => ({ x: 0, y: 0 }), getActions: () => [folder] },
		() => undefined, () => {}, error => { throw error; }, () => {});
	const loading = session.expand(0);
	session.finish();
	resolve([new Action('late', 'Late')]);
	assert.equal(await loading, undefined);
	assert.equal(await session.expand(0), undefined);
});
