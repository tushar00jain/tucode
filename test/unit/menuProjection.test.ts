import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Event } from '../../src/vs/base/common/event.js';
import { toDisposable } from '../../src/vs/base/common/lifecycle.js';
import { IMenuProjectionScheduler, MenuProjectionController } from '../../src/workbench/menuProjection.js';

function deferred() {
	const queue: Array<{ live: boolean; callback: () => void }> = [];
	const scheduler: IMenuProjectionScheduler = { schedule: callback => {
		const entry = { live: true, callback }; queue.push(entry);
		return toDisposable(() => { entry.live = false; });
	} };
	return { scheduler, run: () => { const entry = queue.shift(); assert.ok(entry); if (entry.live) { entry.callback(); } }, size: () => queue.length };
}

describe('neutral immutable menu projection', () => {
	it('keeps stable hierarchical identities while rebuilding mutable presentation state', () => {
		let enabled = false; let checked = false;
		const controller = new MenuProjectionController('menu', () => [{
			id: 'file', kind: 'submenu', label: '&File', role: 'help', items: [
				{ id: 'save', kind: 'command', label: 'Save', key: { characters: 's', modifiers: 8, label: '⌘S' }, enabled, checked, activate() { } },
				{ id: 'separator', kind: 'separator' }, { id: 'save', kind: 'command', label: 'Save As', enabled: true, activate() { } }
			]
		}]);
		const first = controller.snapshot;
		const ids = [...first.items.keys()];
		enabled = true; checked = true; const second = controller.rebuild();

		assert.deepEqual([...second.items.keys()], ids);
		assert.ok(Object.isFrozen(second));
		assert.ok(Object.isFrozen(second.context));
		const save = [...second.items.values()].find(item => item.actionId === 'save' && item.order === 0)!;
		assert.equal(save.enabled, true); assert.equal(save.checked, true); assert.equal(save.key?.label, '⌘S');
		assert.equal(new Set(ids).size, ids.length, 'duplicate command and separator identities stay distinct');
		controller.dispose();
	});

	it('publishes one committed generation for repeated equivalent root-menu update requests', async () => {
		const queue = deferred();
		let label = 'Build'; let activationVersion = 1; let captures = 0; const runs: number[] = [];
		const controller = new MenuProjectionController('menu-update-reducer', () => {
			captures++;
			const capturedActivation = activationVersion;
			return [{ id: 'tools', kind: 'submenu', label: 'Tools', items: [
				{ id: 'build', kind: 'command', label, enabled: true, activate: () => { runs.push(capturedActivation); } }
			] }];
		}, queue.scheduler);
		const initial = controller.snapshot; const publications: number[] = [];
		const listener = controller.onDidSnapshot(snapshot => publications.push(snapshot.generation));

		for (let index = 0; index < 8; index++) { assert.equal(controller.rebuild(), initial); }
		assert.equal(captures, 9, 'each authoritative rebuild request must still refresh dynamic command closures');
		assert.deepEqual(publications, []);

		activationVersion = 2;
		assert.equal(controller.rebuild(), initial, 'callback-only refresh must not fabricate a presentation generation');
		const commandId = initial.order.find(id => initial.items.get(id)?.actionId === 'build')!;
		const completed = Event.toPromise(Event.filter(controller.onDidSnapshot,
			snapshot => snapshot.command.state === 'completed'));
		assert.equal(controller.dispatch({ generation: initial.generation, type: 'activate', id: commandId }), true);
		queue.run(); await completed;
		assert.deepEqual(runs, [2], 'semantic no-op retained the stale activation closure');

		const beforeChange = controller.snapshot; publications.length = 0; label = 'Build All';
		const changed = controller.rebuild();
		for (let index = 0; index < 8; index++) { assert.equal(controller.rebuild(), changed); }
		assert.notEqual(changed.generation, beforeChange.generation);
		assert.equal([...changed.items.values()].find(item => item.actionId === 'build')?.label, 'Build All');
		assert.deepEqual(publications, [changed.generation],
			'repeated equivalent menu-tree update requests published more than one committed generation');
		listener.dispose(); controller.dispose();
	});

	it('normalizes open/highlight/activate/close and rejects stale generations', async () => {
		const queue = deferred(); let runs = 0;
		const controller = new MenuProjectionController('context', () => [
			{ id: 'run', kind: 'command', label: 'Run', enabled: true, activate: () => { runs++; } }
		], queue.scheduler);
		const initial = controller.snapshot; const id = initial.roots[0];
		assert.equal(controller.dispatch({ generation: initial.generation, type: 'open', targetId: 'row', focusedId: id }), true);
		assert.equal(controller.dispatch({ generation: initial.generation, type: 'activate', id }), false, 'opening publishes a replacement generation');
		const opened = controller.snapshot;
		assert.equal(controller.dispatch({ generation: opened.generation, type: 'highlight', id }), true);
		const highlighted = controller.snapshot;
		assert.equal(controller.dispatch({ generation: highlighted.generation, type: 'activate', id }), true);
		const commandCompleted = Event.toPromise(Event.filter(controller.onDidSnapshot,
			snapshot => snapshot.command.state === 'completed'));
		assert.equal(runs, 0); queue.run(); await commandCompleted; assert.equal(runs, 1);
		const completed = controller.snapshot;
		assert.equal(completed.command.state, 'completed');
		assert.equal(controller.dispatch({ generation: completed.generation, type: 'close', cancelled: false }), true);
		assert.equal(controller.snapshot.terminal, 'completed'); assert.equal(controller.snapshot.context.focused, false);
		controller.dispose();
	});

	it('cancels replaced async work and ignores stale completion and failure', async () => {
		const queue = deferred(); const failures: unknown[] = []; let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let resolveFirstFinished!: () => void;
		const firstFinished = new Promise<void>(resolve => { resolveFirstFinished = resolve; });
		let first = true;
		const controller = new MenuProjectionController('commands', () => [{ id: 'run', kind: 'command', label: 'Run', enabled: true,
			activate: () => first ? (first = false, gate.finally(resolveFirstFinished)) : undefined }], queue.scheduler, error => failures.push(error));
		let snapshot = controller.snapshot; const id = snapshot.roots[0];
		controller.dispatch({ generation: snapshot.generation, type: 'activate', id }); queue.run();
		snapshot = controller.snapshot;
		const currentCompleted = Event.toPromise(Event.filter(controller.onDidSnapshot,
			value => value.command.state === 'completed'));
		controller.dispatch({ generation: snapshot.generation, type: 'activate', id }); queue.run();
		await currentCompleted; release(); await firstFinished;
		assert.equal(controller.snapshot.command.state, 'completed'); assert.deepEqual(failures, []); assert.equal(queue.size(), 0);
		controller.dispose();
	});

	it('owns context replacement, close teardown and focus restoration', () => {
		const calls: string[] = []; const queue = deferred();
		const controller = new MenuProjectionController('context-lifecycle', () => []);
		const lifecycle = (name: string) => ({
			disposeMenu: () => calls.push(`${name}:menu`), disposeActions: () => calls.push(`${name}:actions`),
			onHide: (cancelled: boolean) => calls.push(`${name}:hide:${cancelled}`), didHide: () => calls.push(`${name}:didHide`),
			restoreFocus: () => calls.push(`${name}:focus`)
		});
		controller.attachContextLifecycle(lifecycle('first'));
		controller.attachContextLifecycle(lifecycle('second'));
		assert.deepEqual(calls, ['first:menu', 'first:hide:true', 'first:didHide', 'first:actions', 'first:focus']);
		controller.closeAfterTracking(false, queue.scheduler); queue.run();
		assert.deepEqual(calls.slice(-5), ['second:menu', 'second:hide:false', 'second:didHide', 'second:actions', 'second:focus']);
		controller.dispose();
	});
});
