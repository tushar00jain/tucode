/*---------------------------------------------------------------------------------------------
 *  Work a keystroke started that has not finished, and the wait for it.
 *
 *  One holder of work, and **only** the holder: *where* the work is registered is not this file's
 *  question. Here every work-start site is upstream's, so the registration is a wrapper installed
 *  over the prototypes that start it (`settled.ts`). So this file names no window, no tree and no
 *  service — it answers two questions and nothing about who asked them.
 *
 *  **A rejection is neutralised as it is tracked.** The tracker is not always the code that
 *  started the work: a wrapper around somebody else's promise that then awaited it would produce
 *  an unhandled rejection the app never had. The caller's own promise is handed back untouched,
 *  so the failure still reaches whoever asked for it.
 *
 *  Upstream counterpart: none — the antecedent is `Limiter`/`Queue` (`async.ts`), which serialise
 *  work rather than answer whether any is outstanding.
 *--------------------------------------------------------------------------------------------*/

export class PendingWork {

	private readonly pending = new Set<Promise<unknown>>();

	/** Everything ever registered here, which is what says the tracking is on the live path. */
	private tracked = 0;

	constructor(readonly name: string) { }

	/** Registers `work` and hands back the caller's own promise, untouched. */
	track<T>(work: Promise<T>): Promise<T> {
		this.tracked++;
		const tracked: Promise<void> = work.then(() => undefined, () => undefined).finally(() => this.pending.delete(tracked));
		this.pending.add(tracked);

		return work;
	}

	/** Nothing started here is outstanding — which is what a *second* holder of work has to ask. */
	get idle(): boolean {
		return this.pending.size === 0;
	}

	get size(): number {
		return this.pending.size;
	}

	/**
	 * How much work has been registered since the holder was made. A signal that is silent because
	 * nothing is running and one that is silent because nothing ever reaches it look identical from
	 * outside; this is what tells them apart.
	 */
	get seen(): number {
		return this.tracked;
	}

	/** Resolves once nothing that was started is still outstanding. */
	async whenSettled(): Promise<void> {
		while (this.pending.size) {
			await Promise.all([...this.pending]);
		}
	}
}
