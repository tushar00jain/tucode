/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What a burst of file-watcher events is batched over before the poll it asks for runs. */
const BATCH_DELAY = 500;

export interface ICoalescingRefreshScheduler {
	schedule(callback: () => void | Promise<void>, delay: number): { dispose(): void };
}

const timeoutScheduler: ICoalescingRefreshScheduler = {
	schedule(callback, delay) {
		const handle = setTimeout(callback, delay);
		return { dispose: () => clearTimeout(handle) };
	}
};

/**
 * One poll at a time, and never a missed trigger. A `refresh()` arriving while one is in flight
 * is folded into it — the caller is handed the running promise and the body is re-run once it
 * lands — so a mutation that interleaves with a poll can never leave a view showing the snapshot
 * taken before it, and a burst of triggers costs one extra pass rather than one pass each.
 *
 * The body answers whether its snapshot was **stale**: a read the backend raced describes neither
 * state, so it is re-read rather than painted. Stale is a miss, never a wrong answer.
 *
 * `schedule()` is the same promise for a trigger that arrives as a *stream* — a recursive watch on
 * a working tree — and it lives here rather than at the call sites because a batching window that
 * restarts is a refresh that never happens. See its own comment.
 *
 * This is a type rather than a convention because the halves are a pairing — the flag cleared at
 * the top of the loop and the flag tested at the bottom, the window opened by the first trigger
 * and left alone by the rest — and a copy that kept only one half would drop refreshes silently,
 * with nothing to fail. It imports nothing for the same reason: that is what keeps it inside
 * `test:unit`, which is the thing that fails.
 */
export class CoalescingRefresh {

	private running: Promise<void> | undefined;
	private again = false;

	/** The open batching window, if there is one. */
	private window: { dispose(): void } | undefined;

	constructor(private readonly body: () => Promise<boolean>, private readonly batchDelay = BATCH_DELAY,
		private readonly scheduler: ICoalescingRefreshScheduler = timeoutScheduler) { }

	dispose(): void {
		this.window?.dispose();
		this.window = undefined;
	}

	refresh(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}

		this.running = this.loop().finally(() => { this.running = undefined; });
		return this.running;
	}

	/**
	 * A refresh within `batchDelay` of *this* trigger, and one refresh for the burst it belongs to.
	 * The first trigger after a quiet moment opens the window; a trigger inside one is already
	 * covered by the poll that is coming, so it leaves the window where it is.
	 *
	 * **The window is never restarted**, and a `RunOnceScheduler` is therefore the wrong shape for
	 * it: its `schedule` cancels the pending timer before setting a new one, so a stream of triggers
	 * closer together than the delay defers the poll for as long as the stream lasts. That is what
	 * this was found as — a recursive watch on a working tree something writes into a few times a
	 * second (a dev server, a build watcher, `sl` under `.git/sl`) never let the source control
	 * view poll at all, so a commit made outside the app was never picked up.
	 */
	schedule(): void {
		if (this.window !== undefined) {
			return;
		}

		this.window = this.scheduler.schedule(() => {
			this.window = undefined;
			return this.refresh();
		}, this.batchDelay);
	}

	private async loop(): Promise<void> {
		let stale: boolean;

		do {
			this.again = false;
			stale = await this.body();
		} while (stale || this.again);
	}
}
