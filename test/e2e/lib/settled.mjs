// Asking the app whether it has finished, which is the one thing the driver does between steps.
//
// A terminal driver can follow each step's keys with a private CSI and have the app answer it
// once those keys are dispatched *and* `Workbench.whenSettled` resolves — so a step costs what the
// app costs rather than a flat window, and a reading is never of the frame before the work. This
// is that handshake over CDP: `src/vs/workbench/browser/tauri/settled.ts` publishes the same
// question as `window.__tscodeSettled`, and this is the call.
//
// Two facts about the answer shape what a caller may conclude from it, and both are stated in that
// file: it does not cover a **child process**, and it does not cover a **timer that has not fired
// yet** — search-on-type is a `Delayer`, so between the keystroke and the delay expiring the app is
// genuinely idle and says so. `GRACE` is what that costs: a condition still unmet once the app has
// reported settled is given that long to become true before the wait is called a failure. It is
// longer than the debounce it is standing in for, and it is what turns a failing step from the
// tool's 15 s bound into about a second.

import { POLL, READ_TIMEOUT, waitFor } from './wait.mjs';

/**
 * What one settle question is allowed to take. Under it the app answers `settled: false` and names
 * what was still running, which is a fact a caller can act on rather than a wait it must sit out.
 *
 * Well under `READ_TIMEOUT`, so a wedged read gets several questions and at least one *reading*
 * inside its bound. At the two being equal, the first question ate the whole budget and the failure
 * reported `Last observation: undefined` — the one thing it exists to say.
 */
export const SETTLE_TIMEOUT = 2_000;

/**
 * How long a condition is given after the app has reported settled. Longer than
 * `search.searchOnTypeDebouncePeriod` (300 ms), which is the widest arming window the suites drive
 * through — the app is idle while a debounce is armed and would otherwise be believed.
 */
export const GRACE = 800;

/**
 * Whether the workbench has finished what the last keys started.
 *
 * @returns {Promise<{ settled: boolean, outstanding: string[], waitedMs: number }>}
 */
export async function whenSettled(page, { timeoutMs = SETTLE_TIMEOUT } = {}) {
	return page.evaluate(
		ms => globalThis.__tscodeSettled?.(ms) ?? { settled: false, outstanding: ['no settled signal in this build'], waitedMs: 0 },
		timeoutMs
	);
}

/**
 * Waits for a reading of the page to satisfy `terminal`, with the app asked whether it is finished
 * before every reading.
 *
 * The difference from polling alone is what a *false* condition then means. The app reporting
 * settled while the condition is unmet is the statement that nothing is running that could still
 * make it true, so the wait ends in `GRACE` rather than in the step bound — which is where most of
 * a failing run's wall clock used to go.
 *
 * `quietMs` turns the question off and settles on silence instead. It is only ever right where the
 * reading has no completion signal to ask for: a shell painting into an xterm buffer, which is the
 * fork's `child: true`.
 *
 * @param {object} page the playwright page
 * @param {object} options
 * @param {(arg: unknown) => unknown} options.read evaluated in the page, once per pass
 * @param {unknown} [options.readArg] passed to `read`
 * @param {(value: unknown) => boolean} options.terminal whether the reading is the final one
 * @param {string} options.what named in the failure
 * @param {number} [options.quietMs] silence a *child process* has to hold before it counts
 * @param {number} [options.timeoutMs] the bound on the whole wait
 */
export async function settledRead(page, { read, readArg, terminal, what, quietMs = 0, timeoutMs = READ_TIMEOUT }) {
	let lastKey;
	let changedAt = Date.now();
	let idleSince;
	let outstanding = [];
	try {
		return await waitFor(async () => {
			if (quietMs === 0) {
				const answer = await whenSettled(page);
				outstanding = answer.outstanding;
				if (answer.settled) {
					idleSince ??= Date.now();
				} else {
					idleSince = undefined;
				}
			}

			const last = await page.evaluate(read, readArg);
			const key = JSON.stringify(last);
			if (key !== lastKey) {
				lastKey = key;
				changedAt = Date.now();
				// A reading that moved is work that was under way after all, so the grace starts
				// again from the change rather than from the answer that preceded it.
				idleSince = undefined;
			}
			if (terminal(last) && Date.now() - changedAt >= quietMs) {
				return last;
			}
			if (idleSince !== undefined && Date.now() - idleSince >= GRACE) {
				throw new Error(`${what} never settled: the app reported nothing outstanding for ${GRACE} ms and the reading was still not the one waited for`);
			}

			return undefined;
		}, { what: `${what} never settled`, timeoutMs, poll: POLL });
	} catch (error) {
		const running = outstanding.length > 0 ? `. Still running: ${outstanding.join(', ')}` : '';
		throw new Error(`${error.message}. Last observation: ${lastKey}${running}`);
	}
}
