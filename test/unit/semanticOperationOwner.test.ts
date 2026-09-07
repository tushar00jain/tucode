/*---------------------------------------------------------------------------------------------
 *  Shared semantic-operation ownership contracts.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Queue } from '../../src/vs/base/common/async.js';
import { PendingWork } from '../../src/vs/workbench/browser/tauri/pendingWork.js';

test('queued semantic work remains owned through the queue drain edge', async () => {
	const owner = new PendingWork('semantic');
	const queue = new Queue<void>();
	let release!: () => void;
	const task = owner.queue(queue, () => new Promise<void>(resolve => { release = resolve; }), 'navigator.toggle');

	assert.equal(owner.idle, false);
	assert.equal(owner.diagnostics()[0]?.label, 'navigator.toggle');
	release();
	await task;
	await owner.whenSettled();
	assert.equal(queue.size, 0);
	assert.equal(owner.idle, true);
	assert.deepEqual(owner.diagnostics(), []);
});

test('queued semantic failures settle ownership and remain visible to the caller', async () => {
	const owner = new PendingWork('semantic');
	const queue = new Queue<void>();
	const expected = new Error('semantic failure');
	const task = owner.queue(queue, async () => { throw expected; }, 'command.run');

	await assert.rejects(task, expected);
	await owner.whenSettled();
	assert.equal(queue.size, 0);
	assert.equal(owner.idle, true);
});

test('disposal drops ownership immediately and rejects new queued semantics', async () => {
	const owner = new PendingWork('semantic');
	const queue = new Queue<void>();
	let release!: () => void;
	const task = owner.queue(queue, () => new Promise<void>(resolve => { release = resolve; }), 'stale');
	owner.dispose();

	assert.equal(owner.idle, true);
	assert.deepEqual(owner.diagnostics(), []);
	assert.throws(() => owner.queue(queue, async () => undefined), /disposed/);
	release();
	await task;
});

test('bounded repeated queue cycles settle without retained live-operation history', async () => {
	const owner = new PendingWork('semantic');
	const queue = new Queue<void>();
	for (let cycle = 0; cycle < 1_000; cycle++) {
		await owner.queue(queue, async () => undefined, `cycle:${cycle}`);
	}
	await owner.whenSettled();
	assert.equal(owner.seen, 1_000);
	assert.equal(owner.size, 0);
	assert.deepEqual(owner.diagnostics(), []);
});
