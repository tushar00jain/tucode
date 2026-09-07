import assert from 'node:assert/strict';
import test from 'node:test';
import { Event } from '../../src/vs/base/common/event.js';
import type { IStorageService } from '../../src/vs/platform/storage/common/storage.js';
import { StatusbarAlignment, StatusbarProjectionController } from '../../src/workbench/statusbarProjection.js';

function storage(): IStorageService {
	const values = new Map<string, string>();
	return {
		get: (key: string) => values.get(key), store: (key: string, value: unknown) => { values.set(key, String(value)); },
		remove: (key: string) => { values.delete(key); },
		onDidChangeValue: () => Event.None
	} as unknown as IStorageService;
}

const entry = (text: string, command?: string) => ({ name: text, text, ariaLabel: text, command });

test('status-bar projection owns stable identity, order, replacement, visibility and normalized activation', async () => {
	const actions: string[] = [];
	const controller = new StatusbarProjectionController(storage(), {
		execute: async (id, args) => { actions.push(`${id}:${args.join(',')}`); }, report: error => actions.push(`error:${error}`),
		telemetry: id => actions.push(`telemetry:${id}`)
	});
	const left = controller.addEntry(entry('$(git-branch) main', 'branch.open'), 'branch', StatusbarAlignment.LEFT, 10);
	const right = controller.addEntry(entry('UTF-8'), 'encoding', StatusbarAlignment.RIGHT, 20);
	const relative = controller.addEntry(entry('sync'), 'sync', StatusbarAlignment.LEFT,
		{ primary: { location: { id: 'branch', priority: 0 }, alignment: StatusbarAlignment.RIGHT, compact: true }, secondary: 1 });
	const firstId = controller.snapshot.entries.find(value => value.sourceId === 'branch')!.id;
	assert.deepEqual(controller.snapshot.left.map(id => controller.snapshot.entries.find(value => value.id === id)!.sourceId), ['branch', 'sync']);
	assert.deepEqual(controller.snapshot.right.map(id => controller.snapshot.entries.find(value => value.id === id)!.sourceId), ['encoding']);
	assert.equal(controller.snapshot.entries.find(value => value.id === firstId)!.text, ' main');
	assert.equal(Object.isFrozen(controller.snapshot.entries), true);
	left.update({ ...entry('$(git-branch) trunk', 'branch.open'), showProgress: 'syncing', tooltip: 'Open $(link)' });
	assert.equal(controller.snapshot.entries.find(value => value.sourceId === 'branch')!.id, firstId);
	assert.equal(controller.snapshot.entries.find(value => value.sourceId === 'branch')!.progress, 'syncing');
	controller.setEntryVisibility('encoding', false);
	assert.deepEqual(controller.snapshot.right, []);
	const generation = controller.snapshot.generation;
	const completed = Event.toPromise(Event.filter(controller.onDidSnapshot,
		snapshot => snapshot.generation > generation && snapshot.pendingActionId === undefined));
	assert.equal(controller.dispatch({ generation, type: 'activate', id: firstId }), true);
	await completed;
	assert.deepEqual(actions, ['telemetry:branch.open', 'branch.open:']);
	assert.equal(controller.dispatch({ generation, type: 'activate', id: firstId }), false, 'stale generation activated');
	relative.dispose(); right.dispose(); left.dispose();
	assert.equal(controller.snapshot.entries.length, 0);
	controller.dispose(); controller.dispose();
	assert.equal(controller.snapshot.terminal, 'disposed');
});

test('status-bar command failures settle once and stale completion cannot revive disposal', async () => {
	let reject!: (error: Error) => void;
	const reports: string[] = [];
	let resolveReport!: () => void;
	const reported = new Promise<void>(resolve => { resolveReport = resolve; });
	const controller = new StatusbarProjectionController(storage(), {
		execute: () => new Promise<void>((_, rejectPromise) => { reject = rejectPromise; }),
		report: value => { reports.push(value); resolveReport(); }
	});
	const registration = controller.addEntry(entry('Run', 'run'), 'run', StatusbarAlignment.LEFT);
	const id = controller.snapshot.left[0];
	controller.dispatch({ generation: controller.snapshot.generation, type: 'activate', id });
	controller.dispose();
	reject(new Error('failure'));
	await reported;
	assert.deepEqual(reports, ['failure']);
	assert.equal(controller.snapshot.terminal, 'disposed');
	registration.dispose();
});
