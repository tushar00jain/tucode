/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CoalescingRefresh } from '../../src/vs/workbench/contrib/scm/tauri/coalescingRefresh.js';

/**
 * The two promises `CoalescingRefresh` makes: one poll at a time, and never a missed trigger —
 * the second of which the batching window is part of, and where it was once broken.
 *
 * Real timers, and a window short enough that a test is quick but long enough that scheduler
 * jitter cannot reorder the assertions: every bound below is a multiple of `WINDOW`, never a
 * count of milliseconds picked to fit one machine.
 */

const WINDOW = 50;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A body that records its calls and answers "not stale", which is the ordinary case. */
function counting(stale: () => boolean = () => false) {
	const calls = { count: 0 };
	const refresher = new CoalescingRefresh(async () => {
		calls.count++;
		return stale();
	}, WINDOW);

	return { calls, refresher };
}

describe('CoalescingRefresh', () => {

	it('runs the body once per refresh', async () => {
		const { calls, refresher } = counting();

		await refresher.refresh();
		await refresher.refresh();

		assert.equal(calls.count, 2);
		refresher.dispose();
	});

	it('folds a refresh that arrives during one into a single extra pass', async () => {
		let calls = 0;
		let release = () => { };
		const refresher = new CoalescingRefresh(async () => {
			calls++;
			await new Promise<void>(resolve => { release = resolve; });
			return false;
		});

		const first = refresher.refresh();
		await delay(WINDOW / 5);
		assert.equal(calls, 1, 'the first pass is in flight');

		// Three triggers during that pass, which is one extra pass and not three.
		const folded = [refresher.refresh(), refresher.refresh(), refresher.refresh()];
		assert.equal(calls, 1, 'a trigger during a pass never starts a second one');

		release();
		await delay(WINDOW / 5);
		assert.equal(calls, 2, 'the burst costs exactly one more pass');

		release();
		await Promise.all([first, ...folded]);
		assert.equal(calls, 2);
		refresher.dispose();
	});

	it('re-runs the body while its snapshot answers stale', async () => {
		let calls = 0;
		const refresher = new CoalescingRefresh(async () => {
			calls++;
			return calls < 3;
		});

		await refresher.refresh();

		assert.equal(calls, 3, 'a stale snapshot is re-read rather than painted');
		refresher.dispose();
	});

	it('batches a burst of scheduled triggers into one pass', async () => {
		const { calls, refresher } = counting();

		for (let i = 0; i < 5; i++) {
			refresher.schedule();
		}

		assert.equal(calls.count, 0, 'the window has not closed yet');
		await delay(WINDOW * 3);
		assert.equal(calls.count, 1, 'one pass for the burst');
		refresher.dispose();
	});

	/**
	 * The regression. A restarting window — `RunOnceScheduler.schedule`'s own behaviour — defers
	 * the poll for as long as the triggers keep coming, which for a recursive watch on a working
	 * tree something writes into is forever. Triggers arrive here at a fifth of the window for
	 * six windows' worth of time, and the body has to have run.
	 */
	it('still refreshes under a trigger stream faster than the window', async () => {
		const { calls, refresher } = counting();

		const stream = setInterval(() => refresher.schedule(), WINDOW / 5);
		await delay(WINDOW * 6);
		clearInterval(stream);

		assert.ok(calls.count >= 3, `a continuous stream starved the poll: ${calls.count} passes`);
		refresher.dispose();
	});

	it('opens a new window for the next trigger after one closes', async () => {
		const { calls, refresher } = counting();

		refresher.schedule();
		await delay(WINDOW * 3);
		assert.equal(calls.count, 1);

		refresher.schedule();
		await delay(WINDOW * 3);
		assert.equal(calls.count, 2);
		refresher.dispose();
	});

	it('drops a window that has not closed when disposed', async () => {
		const { calls, refresher } = counting();

		refresher.schedule();
		refresher.dispose();

		await delay(WINDOW * 3);
		assert.equal(calls.count, 0);
	});
});
