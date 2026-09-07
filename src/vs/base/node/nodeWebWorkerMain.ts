/*---------------------------------------------------------------------------------------------
 *  The entry point of every worker `NodeWebWorkerService` starts.
 *
 *  A worker main written for a browser talks to its host through two globals — it assigns
 *  `globalThis.onmessage` and calls `globalThis.postMessage` (`base/common/worker/
 *  webWorkerBootstrap.ts`) — and a worker thread has `parentPort` instead. So this bridges the
 *  two and then imports the worker main it was told to run, which keeps every vendored worker
 *  main unedited and needs one entry point rather than one per worker.
 *
 *  `onmessage` is read at delivery time rather than captured: the worker main assigns it while
 *  loading, which is after this file runs.
 *
 *  Upstream counterpart: none — a browser worker's entry is its own module and the bundler wires it up; a worker thread needs a bridge, and nothing in tscode is one.
 *--------------------------------------------------------------------------------------------*/

import { parentPort, workerData } from 'node:worker_threads';
import './browserGlobals.js';

interface INodeWebWorkerData {
	/** The worker main to run, as `IWebWorkerService.getWorkerUrl` resolved it. */
	readonly esmModuleLocation: string;
}

const globals = globalThis as unknown as { postMessage: (message: unknown) => void; onmessage?: (event: { data: unknown }) => void };
const port = parentPort!;

globals.postMessage = message => port.postMessage(message);
port.on('message', data => globals.onmessage?.({ data }));

await import((workerData as INodeWebWorkerData).esmModuleLocation);
