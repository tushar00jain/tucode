/*---------------------------------------------------------------------------------------------
 *  "Has the work a keystroke started finished?" — as a question the running window can be asked.
 *
 *  The model: a set of pending promises per holder of work, a loop that re-reads every holder
 *  after each one finishes (because one part's work starts another's), and a box waiting for a
 *  *keystroke* counted as settled while a box waiting for its own results is not. The holder is
 *  `pendingWork.ts`, which knows nothing about where work is registered; this file is both halves
 *  of the rest. Every work-start site here is upstream's, and upstream is copied unmodified — so
 *  the registration is a wrapper installed over the three prototypes that start it. **And the
 *  loop is a policy over the holder rather than part of it**: what a part is, and that a deadline
 *  and a busy quick input end the wait, are decisions this file makes and `pendingWork.ts` does
 *  not carry.
 *
 *  **What this covers**, and nothing else claims to be covered:
 *
 *  - `AsyncDataTree.setInput` / `updateChildren` / `expand` / `expandTo` — every asynchronous tree
 *    fetch in the explorer, source control and search views, including the sub-tree refreshes they
 *    funnel through `_updateChildren`.
 *  - `SearchService.textSearchSplitSyncAsync` and its `textSearch` / `fileSearch` / `aiTextSearch`
 *    siblings — a provider still streaming. The split call is the search view's own query and the
 *    plain ones are the quick input file picker's, since `AnythingQuickAccessProvider` asks this
 *    same service.
 *  - `Limiter.queue`, which is what `Queue` is — the `/` box's arm queue among them, so a filter
 *    rebuild queued behind the last one is outstanding work rather than a gap.
 *  - A quick input that is *busy*: upstream renders `IQuickPick.busy` as the widget's own progress
 *    bar, and `PickerQuickAccessProvider` raises it around every slow `_getPicks`.
 *  - The Sapling views' `sl` reads, through `trackSlWork` — the graph's refresh, which is discovery
 *    plus the smartlog, and the commit-info view's second read for a commit's changed files. They
 *    repaint a whole view off a channel round trip rather than off a tree, so nothing else here
 *    holds them.
 *
 *  **What it deliberately does not cover.** A signal that answers "settled" while something is
 *  still fetching is worse than a poll, because it will be trusted — so these are named rather
 *  than hoped about:
 *
 *  - **A child process.** A shell paints when it likes and no promise in this window is holding
 *    its output. The terminal is an exemption, stated rather than assumed:
 *    a reading of an xterm buffer settles on quiet, never on this.
 *  - **A timer that has not fired yet.** Search-on-type is a `Delayer`, and between the keystroke
 *    and the delay expiring there is no pending work at all, so this answers "settled" in that
 *    window. Arming is not tracked, because tracking every `Delayer` in the workbench would make
 *    the answer hostage to whichever one is armed for a reason unconnected to the keystroke. The
 *    driver closes that window instead — `test/e2e/lib/settled.mjs` gives a settled-but-unmet
 *    condition a grace period longer than the debounce before it calls it a failure.
 *  - **What a view does with results after its query resolves.** The search view redraws its rows
 *    on its own scheduler; the query being over is what this reports.
 *
 *  It answers `{ settled: false, outstanding }` rather than hanging when the bound passes, so the
 *  driver can fall back to polling and name what was still running instead of waiting out its own
 *  timeout on a question that will never be answered.
 *--------------------------------------------------------------------------------------------*/

import { AsyncDataTree } from '../../../base/browser/ui/tree/asyncDataTree.js';
import { Limiter } from '../../../base/common/async.js';
import { mainWindow } from '../../../base/browser/window.js';
import { SearchService } from '../../services/search/common/searchService.js';
import { PendingWork } from './pendingWork.js';

/** How long `whenSettled` waits before answering that it could not settle. */
const SETTLE_TIMEOUT = 5_000;

/** How often the flags that are read rather than awaited — the quick input's — are looked at. */
const POLL = 10;

/** The global the driver asks through. */
const SETTLED = '__tscodeSettled';

/** What a wait answers with: whether it settled, and what was outstanding if it did not. */
export interface ISettledResult {
	readonly settled: boolean;
	readonly outstanding: readonly string[];
	readonly waitedMs: number;
	/**
	 * How much work each holder has registered since the window booted. A signal that is silent
	 * because nothing is running and one that is silent because its wrapper is not on the path the
	 * app actually takes look identical from outside; this is what tells them apart.
	 */
	readonly seen: Record<string, number>;
}

const trees = new PendingWork('tree');
const searches = new PendingWork('search');
const queues = new PendingWork('queue');
const sl = new PendingWork('sl');

/** Every holder of work a keystroke can start. */
const parts = [trees, searches, queues, sl];

/**
 * Registers the work a method starts, for a method this fork does not own. The wrapper is
 * transparent — the caller gets the original return value, with the original rejection — so the
 * only thing it changes is that somebody else now knows the work is outstanding.
 *
 * `promiseOf` is which part of that value is the wait. Most methods *are* the promise; the search
 * service's split call answers synchronously with the results it already had and a promise for the
 * rest, and it is the rest that a query still streaming means.
 */
function trackWork(prototype: object, name: string, work: PendingWork, promiseOf: (result: unknown) => unknown = result => result): void {
	const record = prototype as Record<string, unknown>;
	const original = record[name];
	if (typeof original !== 'function') {
		throw new Error(`${name} is not a method of ${prototype.constructor?.name ?? 'that prototype'}, so the settled signal cannot see it`);
	}

	record[name] = function (this: unknown, ...args: unknown[]): unknown {
		const result = (original as (...rest: unknown[]) => unknown).apply(this, args);
		const promise = promiseOf(result);
		if (promise instanceof Promise) {
			work.track(promise);
		}

		return result;
	};
}

/**
 * Registers an `sl` read, and hands the caller's own promise back.
 *
 * The Sapling views are this port's own code, so they say what they started rather than being
 * wrapped from outside — which is the only shape that can name the read that *ends with the
 * paint* rather than the channel call inside it.
 */
export function trackSlWork<T>(work: Promise<T>): Promise<T> {
	return sl.track(work);
}

/**
 * Whether a quick input is filling itself. Upstream's own rendering of `IQuickPick.busy` is the
 * progress bar inside the visible widget — the workbench holds several widgets, all but one of
 * them permanently hidden, which is why the visible one has to be picked out first.
 */
function quickInputBusy(): boolean {
	const widget = [...mainWindow.document.querySelectorAll('.quick-input-widget')]
		.find(candidate => (candidate as HTMLElement).style.display !== 'none' && candidate.getBoundingClientRect().height > 0);

	return !!widget?.querySelector('.monaco-progress-container.active');
}

/** The next frame, which is where a list that spliced its rows this turn has drawn them. */
function nextFrame(): Promise<void> {
	return new Promise(resolve => mainWindow.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => mainWindow.setTimeout(resolve, ms));
}

function seen(): Record<string, number> {
	return Object.fromEntries(parts.map(part => [part.name, part.seen]));
}

function outstanding(): string[] {
	const busy = parts.filter(part => !part.idle).map(part => `${part.name}×${part.size}`);

	return quickInputBusy() ? [...busy, 'quickInput'] : busy;
}

/**
 * Resolves once nothing tracked is outstanding and the frame after it has been drawn.
 *
 * **Re-read after every part that finishes, because one part's work starts another's** — a tree
 * refresh resolves and the view queues the next one, and a pick whose `sl log` fills the graph
 * moves a selection, which sends a second pane after its files. Every holder read once, in one
 * pass, answers "idle" before that second pane has started.
 */
export async function whenSettled(timeoutMs: number = SETTLE_TIMEOUT): Promise<ISettledResult> {
	const started = Date.now();
	const deadline = started + timeoutMs;

	for (;;) {
		const busy = parts.filter(part => !part.idle);
		if (busy.length === 0 && !quickInputBusy()) {
			// A rendered frame, and then the question again: the splice a refresh ended with can
			// start the next one, and a reading taken before the paint is a reading of the frame
			// before it.
			await nextFrame();
			if (parts.every(part => part.idle) && !quickInputBusy()) {
				return { settled: true, outstanding: [], waitedMs: Date.now() - started, seen: seen() };
			}
			continue;
		}

		if (Date.now() > deadline) {
			return { settled: false, outstanding: outstanding(), waitedMs: Date.now() - started, seen: seen() };
		}

		// Raced against a poll, because the quick input's flag is read rather than awaited and a
		// wait on the promises alone would not look at it again until one of them finished.
		await Promise.race([...busy.map(part => part.whenSettled()), delay(POLL)]);
	}
}

/**
 * Installs the tracking and publishes the question. Called from the boot file, for every window
 * rather than only a driven one: a signal that exists only under a flag is one nobody can ask for
 * when something is wedged in front of them.
 */
export function installSettledSignal(): void {
	for (const method of ['setInput', 'updateChildren', 'expand', 'expandTo']) {
		trackWork(AsyncDataTree.prototype, method, trees);
	}
	for (const method of ['textSearch', 'fileSearch', 'aiTextSearch']) {
		trackWork(SearchService.prototype, method, searches);
	}
	// The search view's own query, which `textSearch` is only the joined form of.
	trackWork(SearchService.prototype, 'textSearchSplitSyncAsync', searches, result => (result as { asyncResults?: unknown }).asyncResults);
	trackWork(Limiter.prototype, 'queue', queues);

	(mainWindow as unknown as Record<string, unknown>)[SETTLED] = whenSettled;
}
