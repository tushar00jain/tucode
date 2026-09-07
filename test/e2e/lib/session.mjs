// The run itself: one fixture, one application, one launch.
//
// Both entry points own the same lifecycle and differ only in which binary they
// drive, what their fixture is, and what has to happen before the suites can
// assert — so that difference is what they pass in, and everything around it
// lives here.

import assert from 'node:assert/strict';
import { after, before } from 'node:test';

import { launchApp } from './app.mjs';
import { REPO_ROOT, readyExe } from './exe.mjs';
import { EXIT_TIMEOUT, STEP_TIMEOUT } from './wait.mjs';

const log = (...parts) => console.log('#', ...parts);

/** How many distinct console errors a run prints before the rest are elided. */
const REPORTED_ERRORS = 20;

/**
 * What the boot hook is allowed to take. `--test-timeout` in the npm script bounds each `it`; a
 * hook is not a test and is not covered by it, so an unbounded `before` is where a wedged run
 * hides — which is the whole of `PLAN` §3.5.
 *
 * It is a *sum*, not a round number, and it has to stay larger than the bounds inside it: a hook
 * bound that fires first cancels the launch mid-way and reports `test timed out`, which names
 * neither the step that hung nor what the app printed. Measured here: the fixture is by far the
 * largest part at ~19 s (`BULK_FILES`), the attach and the workbench mount are a few seconds each,
 * and the terminal entry adds two reloads.
 *
 * What `open` costs is the entry point's own and is added to this rather than folded into it — the
 * editor entry warms the search corpus there and the terminal entry opens no workspace at all, so
 * one number for both would be forty seconds too loose for whichever does less.
 */
const BEFORE_TIMEOUT = 20_000 + 4 * STEP_TIMEOUT;

/**
 * Registers the `before`/`after` that fill and empty `context`.
 *
 * @param {{ app: unknown, page: unknown, fixture: unknown }} context handed to every suite
 * @param {object} options
 * @param {string} options.binary which application to launch
 * @param {number} options.port the WebView2 debugging port to attach over
 * @param {() => { root: string, dispose: () => void }} options.createFixture
 * @param {(app: object, fixture: object) => Promise<void>} options.open puts the
 *   booted app into the state the suites assert against
 * @param {number} [options.openTimeout] what `open` is allowed to take, on top of the boot
 */
export function registerSession(context, { binary, port, createFixture, open, openTimeout = 0 }) {
	before(async () => {
		// Before the fixture: a stale or missing build is certain to fail and cheap to detect, and
		// the fixture is twenty seconds of work that a refused run would only throw away.
		const exe = readyExe(REPO_ROOT, binary, log);

		const started = Date.now();
		context.fixture = createFixture();
		log(`fixture ${context.fixture.root} — built in ${Date.now() - started} ms`);
		const launched = Date.now();
		context.app = await launchApp({ binary, port, log, exe });
		await open(context.app, context.fixture);
		context.page = context.app.page;
		log(`booted and opened in ${Date.now() - launched} ms`);
	}, { timeout: BEFORE_TIMEOUT + openTimeout });

	after(async () => {
		if (context.app) {
			const errors = [...new Set(context.app.consoleErrors)];
			log(`console errors during the run: ${errors.length}`);
			for (const error of errors.slice(0, REPORTED_ERRORS)) {
				log(`  ${error.slice(0, 200)}`);
			}
			const { owned, survivors, exit } = await context.app.close();
			log(`processes the app owned: ${owned.map(entry => entry.name).sort().join(', ') || '(none)'}`);
			assert.equal(exit, undefined, `the app exited on its own during the run (${JSON.stringify(exit)}), so every assertion after that point was made against an application that was gone`);
			assert.deepEqual(survivors, [], `these processes outlived the app: ${JSON.stringify(survivors)}`);
		}
		context.fixture?.dispose();
	}, { timeout: 3 * EXIT_TIMEOUT });
}
