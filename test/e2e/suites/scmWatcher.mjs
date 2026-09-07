// Source control against a repository that is being written to: the claim that a change made
// outside the app reaches the view even while the watcher is delivering events continuously.
//
// **This is the wiring, which is where the defect was.** `CoalescingRefresh` has its own unit
// test and it passes against either wiring — what shipped the bug was the contribution batching
// watcher events through a `RunOnceScheduler`, whose `schedule` cancels the pending timer before
// setting a new one. A stream of triggers closer together than the window therefore deferred the
// poll for as long as the stream lasted, and a commit made in a shell outside the app was never
// picked up at all. Nothing below reads `CoalescingRefresh`; the whole test is "commit outside the
// app, with the tree being written to, and look at the view".

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitAll, SCM_WATCHER } from '../lib/fixture.mjs';
import { scmResources } from '../lib/probes.mjs';
import { delay } from '../lib/wait.mjs';

/**
 * What the view is given to correct itself in, from the commit landing.
 *
 * Measured on this app: the batching window is 500 ms and the poll behind it is tens of
 * milliseconds on a repository this size, so a healthy correction is around 600 ms — and 800 ms on
 * a 20,000-file repository under the same churn. This is about five times the healthy case, which
 * is enough for a cold first `gix` walk and CI jitter and still small enough to bite: a regression
 * that merely *slowed* the path down — a wider window, a poll that waits out the churn — fails
 * here rather than passing under a bound that would have hidden it. Well under `--test-timeout`
 * too, so a failure is this assertion's message and not the tool's silence.
 */
const CORRECTION_TIMEOUT = 3_000;

/** Churn before the commit, so the window the old wiring restarts is already open when it lands. */
const CHURN_LEAD_MS = 3 * SCM_WATCHER.churnIntervalMs;

/** Every writer this file has started, so a failure or an aborted hook cannot leave one running. */
const writers = new Set();

/**
 * A writer inside the repository, at a rate the batching window has to absorb. The timer is
 * `unref`ed, so it can never be the reason the run does not exit — a leaked writer would hold the
 * fixture directory busy and take the teardown down with it.
 */
function startChurn(directory) {
	const path = join(directory, 'churn.tmp');
	let tick = 0;
	const timer = setInterval(() => writeFileSync(path, String(tick++)), SCM_WATCHER.churnIntervalMs);
	timer.unref();
	writers.add(timer);

	return {
		stop() {
			clearInterval(timer);
			writers.delete(timer);
		}
	};
}

export default function registerScmWatcherSuite(context) {
	describe('source control watcher', () => {
		after(() => {
			for (const timer of writers) {
				clearInterval(timer);
			}
			writers.clear();
		});

		it('picks up a commit made outside the app while the repository is being written to', async () => {
			const repository = context.fixture.root;

			// The working set the view is showing before anything happens — a modification, an
			// addition and a deletion, which are the three shapes a stale view goes on drawing.
			assert.deepEqual(await scmResources(context.page, SCM_WATCHER.working), [...SCM_WATCHER.working].sort());

			const churn = startChurn(join(repository, '.git', SCM_WATCHER.churnDirectory));
			try {
				await delay(CHURN_LEAD_MS);
				commitAll(repository, 'committed outside the app');

				// Asserted *while* the churn is still running: stopping it first would let the
				// window close on the silence and the old wiring would pass.
				assert.deepEqual(
					await scmResources(context.page, [], { timeoutMs: CORRECTION_TIMEOUT }),
					[],
					'the working set is empty once the commit has landed'
				);
			} finally {
				churn.stop();
			}
		});
	});
}
