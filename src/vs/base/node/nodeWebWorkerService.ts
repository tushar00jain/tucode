/*---------------------------------------------------------------------------------------------
 *  `IWebWorkerService` over `node:worker_threads`.
 *
 *  Upstream's worker layer is already split at the right seam: `WebWorkerClient` and
 *  `WebWorkerServer` in `base/common/worker/webWorker.ts` are the whole protocol and are
 *  DOM-free, and everything host-specific is behind `IWebWorker` — five members, of which one
 *  sends a message and one tears the worker down. So this substitutes a thread for a
 *  `DedicatedWorkerGlobalScope` and nothing above it changes, which is the same shape as the
 *  `IChannel` swap that carried the Electron→Tauri port.
 *
 *  `getWorkerUrl` is inherited rather than written: tscode's `BundlerWebWorkerService` already
 *  prefers `esmModuleLocationBundler`, which is the specifier `bin/bundler-imports.mjs` answers
 *  with the emitted worker main's own `file:` URL.
 *
 *  **A thread is a child of this process and teardown owns it.** Upstream's background tokenizer
 *  is never disposed — it belongs to a singleton service, and `main.ts` deliberately does not
 *  dispose the services at exit — so the service is disposed with the frontend instead, and
 *  disposing it terminates every thread it started. §16.7 calls a run that finishes and does not
 *  exit a defect, and this was measured as one: `unref()` alone is *not* enough, because
 *  `worker_threads.Worker` creates three `MessagePort`s and `unref` leaves them live —
 *  `async_hooks` reported all three still held after the backend had closed. The `unref` below is
 *  kept anyway, so that a teardown which never runs cannot turn a background tokenizer into a
 *  process that will not exit.
 *
 *  Upstream counterpart: src/vs/platform/webWorker/tauri/bundlerWebWorkerService.ts
 *--------------------------------------------------------------------------------------------*/

import { Worker } from 'node:worker_threads';
import { CancellationError } from '../common/errors.js';
import { Emitter } from '../common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../common/lifecycle.js';
import { IWebWorker, IWebWorkerClient, Message, WebWorkerClient } from '../common/worker/webWorker.js';
import { WebWorkerDescriptor } from '../../platform/webWorker/browser/webWorkerDescriptor.js';
import { BundlerWebWorkerService } from '../../platform/webWorker/tauri/bundlerWebWorkerService.js';

/**
 * The thread every worker actually starts in. It installs the globals a worker main expects —
 * `postMessage` and `onmessage`, which `bootstrapWebWorker` assigns — and then imports the
 * worker main named in `workerData`. One entry point serves every worker for that reason.
 */
const WORKER_MAIN = new URL('./nodeWebWorkerMain.js', import.meta.url);

export class NodeWebWorkerService extends BundlerWebWorkerService implements IDisposable {

	/** Every thread this started, so teardown can end them all. */
	private readonly workers = new DisposableStore();

	override createWorkerClient<T extends object>(workerDescriptor: WebWorkerDescriptor): IWebWorkerClient<T> {
		// A grammar can finish loading after frontend teardown while shared models still exist.
		// Cancel before constructing a thread: adding it to a disposed store would leak it.
		if (this.workers.isDisposed) { throw new CancellationError(); }
		return new WebWorkerClient<T>(this.workers.add(new NodeWebWorker(workerDescriptor, this.getWorkerUrl(workerDescriptor))));
	}

	dispose(): void {
		this.workers.dispose();
	}
}

/**
 * One worker thread, as the protocol sees it. The body is upstream's `WebWorker` with its three
 * DOM handlers replaced by the `worker_threads` events that carry the same things: `message`,
 * `error` and `messageerror`.
 */
class NodeWebWorker extends Disposable implements IWebWorker {

	private static idPool = 0;

	private readonly id = ++NodeWebWorker.idPool;
	private readonly worker: Worker;

	private readonly _onMessage = this._register(new Emitter<Message>());
	readonly onMessage = this._onMessage.event;

	private readonly _onError = this._register(new Emitter<unknown>());
	readonly onError = this._onError.event;

	constructor(descriptor: WebWorkerDescriptor, esmModuleLocation: string) {
		super();

		this.worker = new Worker(WORKER_MAIN, { name: descriptor.label, workerData: { esmModuleLocation } });

		this.worker.on('message', (message: Message) => this._onMessage.fire(message));
		this.worker.on('messageerror', error => this._onError.fire(error));
		this.worker.on('error', error => this._onError.fire(error));

		// Upstream's own extra first message, which `bootstrapWebWorker` swallows in order to
		// initialize on it. Sent here for the same reason and at the same point.
		this.postMessage('-please-ignore-' as unknown as Message, []);

		// After the listeners and the first message, not before: a `message` listener starts the
		// worker's port, and starting a port refs it — so an `unref` from before is undone, the
		// handle survives teardown and the process never exits. Measured as exactly that, with
		// `getActiveResourcesInfo` reporting a lone `MessagePort` after the backend had closed.
		this.worker.unref();

		this._register(toDisposable(() => this.worker.terminate()));
	}

	getId(): number {
		return this.id;
	}

	postMessage(message: Message, transfer: ArrayBuffer[]): void {
		this.worker.postMessage(message, transfer);
	}
}
