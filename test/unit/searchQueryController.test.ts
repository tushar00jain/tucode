import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { SearchQueryController } from '../../src/vs/workbench/contrib/search/common/searchQueryController.js';

test('queries supersede pending validation and serialize model requests', async () => {
	const cancelled: (boolean | undefined)[] = [];
	const controller = new SearchQueryController(newSearch => cancelled.push(newSearch));
	const started = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	const prepared = new DeferredPromise<void>();
	const results: string[] = [];
	try {
		controller.trigger(0, version => controller.enqueue(version, async () => {
			await started.complete(); await release.p;
			if (controller.isCurrent(version)) { results.push('old'); }
		}));
		await started.p;
		const oldVersion = controller.currentVersion;
		controller.trigger(0, async version => {
			void controller.enqueue(version, async () => { results.push('new'); });
			await prepared.complete();
		});
		await prepared.p;
		assert.equal(controller.isCurrent(oldVersion), false);
		assert.equal(results.length, 0, 'the new model request waits for the canceled request to finish');
		await controller.enqueue(oldVersion, async () => { results.push('stale validation'); });
		await release.complete();
		await controller.whenSettled();
		assert.deepEqual(results, ['new']);
		assert.deepEqual(cancelled, [true, true]);
	} finally { await release.complete(); controller.dispose(); }
});

test('rapid input coalesces and cancellation prevents a delayed query from starting', async () => {
	const controller = new SearchQueryController(() => {});
	const results: string[] = [];
	try {
		controller.trigger(0, async () => { results.push('intermediate'); });
		controller.trigger(0, async () => { results.push('latest'); });
		await controller.whenSettled();
		assert.deepEqual(results, ['latest']);
		controller.trigger(0, async () => { results.push('canceled'); });
		controller.cancel();
		await controller.whenSettled();
		assert.deepEqual(results, ['latest']);
	} finally { controller.dispose(); }
});

test('query errors are reported and do not poison subsequent searches', async () => {
	const errors: unknown[] = [];
	const controller = new SearchQueryController(() => {}, error => errors.push(error));
	const failure = new Error('query failed');
	try {
		controller.trigger(0, version => controller.enqueue(version, async () => { throw failure; }));
		await controller.whenSettled();
		assert.deepEqual(errors, [failure]);
		let completed = false;
		controller.trigger(0, version => controller.enqueue(version, async () => { completed = true; }));
		await controller.whenSettled();
		assert.equal(completed, true);
	} finally { controller.dispose(); }
});

test('disposing during a search suppresses late results and further queries', async () => {
	const started = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	const results: string[] = [];
	const controller = new SearchQueryController(() => {});
	controller.trigger(0, version => controller.enqueue(version, async () => {
		await started.complete(); await release.p;
		if (controller.isCurrent(version)) { results.push('late'); }
	}));
	await started.p;
	controller.dispose();
	controller.trigger(0, async () => { results.push('disposed'); });
	await release.complete();
	await controller.whenSettled();
	assert.deepEqual(results, []);
});
