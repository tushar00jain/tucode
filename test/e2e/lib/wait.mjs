// The waiting discipline: bound every wait to what a step should take, wait on a condition rather
// than on the clock, and treat a run that finishes its work and does not exit as a defect. The
// rules and the reasons behind them are in `test/e2e/README.md`, *Waiting fails fast, on purpose*;
// what is here is the implementation.
//
// The bodies are shared with any other harness that drives this app. A driver's own half differs — that
// one writes keys down a pipe and reads a frame back, this one attaches to a WebView2 over CDP —
// but waiting is not a driver concern, and this is the half that transfers. What was cut is the
// paint buffer and the `SYNC` handshake `waitFor` closed over there, which are the driver half.

/** Silence that means a *child process* has stopped painting. Nothing else settles on it. */
export const QUIET = 250;

/** How often what has arrived is looked at. A poll interval, not a window anything settles on. */
export const POLL = 10;

/**
 * What a step is allowed to take. Boot is the slowest and everything else is well under one
 * second, so this is a few times the worst case — near enough to bite, which is the only kind of
 * bound that detects a hang rather than delaying it.
 */
export const STEP_TIMEOUT = 15_000;

/**
 * What one wait *inside* a step is allowed to take. `STEP_TIMEOUT` is what a whole step costs — it
 * is the boot bounds in `app.mjs` and the term `session.mjs` sums its hook bound out of; this is
 * the bound on each of the several waits a step is made of.
 *
 * `STEP_TIMEOUT - 2000` was the first attempt and it did not bite: a step reaches its wedged wait
 * after a second or two of working waits, so a thirteen-second bound still lands past
 * `--test-timeout` and the tool's silence wins the race — four steps of the run reported
 * `test timed out after 15000ms` under it. So this is §3.5's number rather than the tool's: the
 * slowest healthy wait the suite makes is a settled read of a text search at about two seconds, and
 * this is a bit over twice that. A run that blows it is the finding.
 */
export const READ_TIMEOUT = 5_000;

/** Teardown is a process kill and a log flush. */
export const EXIT_TIMEOUT = 10_000;

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A bound, which is the same wait with one difference that matters: `unref` says it is not itself a
 * reason to keep the process alive. Without it the ten seconds this suite is *allowed* to spend
 * waiting for the app to exit are ten seconds it always spends, because the timer outlives the race
 * it lost.
 */
export const bound = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

/**
 * Waits for `condition`, and turns the app dying or the bound expiring into the failure.
 *
 * `condition` may be async — over CDP every read is a round trip — and its last value is what the
 * caller gets back, so a probe polls and reads in one pass rather than reading twice.
 *
 * @param {() => unknown | Promise<unknown>} condition truthy when the thing has happened
 * @param {object} options
 * @param {string} options.what named in the failure: "the search view never …"
 * @param {number} [options.timeoutMs] the bound, which should be near what the wait should take
 * @param {number} [options.poll] how often `condition` is asked
 * @param {() => string | undefined} [options.alive] a reason the app is gone, if it is
 */
export async function waitFor(condition, { what, timeoutMs = READ_TIMEOUT, poll = POLL, alive = () => undefined }) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const gone = alive();
		if (gone) {
			throw new Error(`${what}: ${gone}`);
		}
		const value = await condition();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`${what} within ${timeoutMs} ms`);
		}
		await delay(poll);
	}
}

/**
 * Whether `promise` lost a race against its bound. The bound is `unref`ed, so a promise that wins
 * costs nothing — which is what makes it safe to give a wait the time it is allowed rather than the
 * time it usually takes.
 */
export async function timedOut(promise, timeoutMs) {
	return Promise.race([promise.then(() => false), bound(timeoutMs).then(() => true)]);
}

// Below this line is this harness's own, because playwright is this driver's:
// `page.waitForSelector` and `page.waitForFunction` are waits of the same kind as `waitFor` above,
// and left as they come they are §3.5's failure twice over. Their default bound is playwright's
// 30 s — longer than `--test-timeout`, so the tool's 15 s always fires first — and their failure
// names the *call* ("Timeout 30000ms exceeded") rather than the condition. Three steps of the run
// paid the full 15 s at one of these and reported node's silence instead of what never happened.

/**
 * Waits for an element, under this suite's bound and with this suite's failure.
 *
 * @param {object} page the playwright page
 * @param {string} selector what to wait for
 * @param {object} options
 * @param {string} options.what named in the failure: "the search view never …"
 * @param {'attached' | 'visible'} [options.state] which state the element has to reach
 * @param {number} [options.timeoutMs] the bound, which should be near what the wait should take
 */
export async function waitForElement(page, selector, { what, state = 'attached', timeoutMs = READ_TIMEOUT }) {
	try {
		return await page.waitForSelector(selector, { state, timeout: timeoutMs });
	} catch {
		throw new Error(`${what} within ${timeoutMs} ms: nothing matching ${JSON.stringify(selector)} was ${state}`);
	}
}

/**
 * Waits for a reading of the page to satisfy `holds` — `settledRead` without the settle question,
 * for the readings that have no completion signal to ask about.
 *
 * `page.waitForFunction` is what this replaces, and the reason is the failure: it reports that a
 * function returned falsy, which is the one thing already known. This reports the reading itself,
 * so a wait that never came true names what the page held instead.
 *
 * @param {object} page the playwright page
 * @param {object} options
 * @param {(arg: unknown) => unknown} options.read evaluated in the page, once per pass
 * @param {unknown} [options.readArg] passed to `read`
 * @param {(value: unknown) => boolean} options.holds whether the reading is the one waited for
 * @param {string} options.what named in the failure: "the search view never …"
 * @param {number} [options.timeoutMs] the bound, which should be near what the wait should take
 */
export async function waitForRead(page, { read, readArg, holds, what, timeoutMs = READ_TIMEOUT }) {
	let last;
	try {
		return await waitFor(async () => {
			last = await page.evaluate(read, readArg);
			return holds(last) ? last : undefined;
		}, { what, timeoutMs });
	} catch (error) {
		throw new Error(`${error.message}. Last observation: ${JSON.stringify(last)}`);
	}
}
