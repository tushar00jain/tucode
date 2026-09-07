/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: src/vs/base/parts/ipc/tauri/ipc.tauri.ts
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, Interface } from 'node:readline';
import { checkoutRoot } from '../../../node/checkout.js';

/**
 * The backend as a child process, presented as the two functions
 * `@tauri-apps/api` presented — so `ipc.tauri.ts` above it changed by its import
 * line and nothing else, and `IChannel` never noticed the host swap.
 *
 * The wire is `src-tauri/crates/tscode-app/src/host.rs`: one JSON object per
 * line, `{ id, cmd, args }` out and `{ id, result }` / `{ id, error }` /
 * `{ event, payload }` back. `invoke` rejects with the raw `error` **string**,
 * as Tauri does, because that string is `ChannelError::to_wire`'s JSON and
 * `toChannelError` is what rehydrates it.
 */

/** Where to find the host binary, for a build that is not beside this checkout. */
const HOST_PATH_VARIABLE = 'TSCODE_HOST_PATH';

/**
 * Newest first: `npm run build` writes `dev-small`, and a bare `cargo build` still writes `debug`,
 * so either is something a developer has just produced.
 */
const CARGO_PROFILES = ['dev-small', 'debug', 'release'];

/**
 * How long teardown waits for what is still in flight, matching the two seconds `host.rs`
 * gives its own writer. A call that never answers must not hold the exit up.
 */
const DRAIN_TIMEOUT = 2_000;

/**
 * How long the host gets to reap its shells and exit once its stdin closes, matching the six
 * seconds `host.rs` bounds its own `shutdown_all` with. A host past it is killed, which is where
 * this started.
 */
const EXIT_TIMEOUT = 6_000;

export type UnlistenFn = () => void;

/** Stock Tauri's `Event<T>`, less the fields nothing above this reads. */
export interface IHostEvent<T> {
	readonly event: string;
	readonly payload: T;
}

export type EventCallback<T> = (event: IHostEvent<T>) => void;

/** The three lines `host.rs` writes, before they are told apart. */
export interface IHostMessage {
	readonly id?: number;
	readonly result?: unknown;
	readonly error?: string;
	readonly event?: string;
	readonly payload?: unknown;
}

/** Parse one wire record without letting a malformed backend line disturb neighboring records. */
export function parseHostMessageLine(line: string, report: (message: string) => void = message => console.error(message)): IHostMessage | undefined {
	try {
		return JSON.parse(line) as IHostMessage;
	} catch (error) {
		report(`ipc.host: unparseable line from the backend: ${error}`);
		return undefined;
	}
}

interface IPendingRequest {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: unknown) => void;
}

class HostProcess {

	private readonly child: ChildProcess;
	private readonly closeBoundary: HostProcessCloseBoundary;
	private readonly stdout: Interface;
	private readonly pending = new Map<number, IPendingRequest>();
	/** Every call in flight, settled either way, so teardown can wait for it. */
	private readonly inFlight = new Set<Promise<void>>();
	private readonly listeners = new Map<string, Set<EventCallback<any>>>();
	private nextRequestId = 0;

	/** Set once the host is gone; every later call rejects with it. */
	private gone: string | undefined;

	/** Exact child id captured from Node's spawn result; used only for owned-process accounting. */
	get pid(): number | undefined { return this.child.pid; }

	constructor(executable: string) {
		this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
		this.closeBoundary = new HostProcessCloseBoundary(this.child);
		if (!this.child.stdin || !this.child.stdout) {
			throw new Error(`${executable} was spawned without a stdio pipe`);
		}

		this.stdout = createInterface({ input: this.child.stdout });
		this.stdout.on('line', line => this.receive(line));
		this.child.on('error', error => this.die(`cannot run ${executable}: ${error}`));
		// Node's `close` follows both process exit and stdio closure, so every complete stdout line
		// has already been delivered through readline before the host is declared gone.
		this.child.on('close', (code, signal) => {
			const reason = `${executable} exited (code ${code}, signal ${signal})`;
			this.die(reason);
		});
		// A write to a host that has gone is a rejected call, not a dead frontend. Without this
		// the `EPIPE` reaches the process as an unhandled `error` event and takes it down —
		// hiding whatever killed the host behind the broken pipe.
		this.child.stdin.on('error', error => this.die(`${executable} closed its input: ${error}`));
	}

	invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
		if (this.gone) {
			return Promise.reject(this.gone);
		}

		const id = this.nextRequestId++;

		const call = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
			this.child.stdin!.write(`${JSON.stringify({ id, cmd, args })}\n`);
		});

		const settled = call.then(() => { }, () => { /* the caller's rejection is the caller's */ });
		this.inFlight.add(settled);
		settled.then(() => this.inFlight.delete(settled));

		return call;
	}

	/**
	 * Registration is local, so a listener is attached before this returns and a
	 * payload emitted the instant `channel_listen` reaches the backend still has
	 * somewhere to land.
	 */
	listen<T>(eventName: string, handler: EventCallback<T>): UnlistenFn {
		let handlers = this.listeners.get(eventName);
		if (!handlers) {
			handlers = new Set();
			this.listeners.set(eventName, handlers);
		}

		handlers.add(handler);

		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.listeners.delete(eventName);
			}
		};
	}

	/**
	 * Drains what is in flight, then ends the host. `die` first, so a call issued after this
	 * point is rejected with a reason instead of writing to a closed pipe.
	 *
	 * Closing stdin is what *starts* the host's teardown; its `close` event is what finishes it,
	 * after both process exit and stdio closure. The host
	 * kills its shells and closes their pseudoconsoles before it goes, so a `kill()` issued here
	 * pre-empts that — which is how a `conhost.exe --headless` and its shell outlive the run,
	 * holding whatever they had as a cwd. The kill is what a host past its bound gets instead.
	 */
	async stop(): Promise<void> {
		await this.drain();

		this.die('the host was stopped');
		this.stdout.close();
		this.child.stdin?.end();

		await this.closeBoundary.waitForClose(this.whenExited(), this.expired(EXIT_TIMEOUT));
	}

	/** Resolves when the host process is gone, immediately if it already is. */
	private whenExited(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			return Promise.resolve();
		}

		return new Promise(resolve => this.child.once('exit', () => resolve()));
	}

	/** Whichever comes first: nothing left in flight, or the timeout. */
	private drain(): Promise<unknown> {
		return Promise.race([this.whenIdle(), this.expired(DRAIN_TIMEOUT)]);
	}

	/**
	 * Resolves once no call is in flight and no reply's continuation has issued another.
	 *
	 * The second half is what the yield is for: `ILogger.flush()` is `void` in upstream's
	 * interface, so a log write can still be a `readFile` away from being issued when boot
	 * asks for teardown, and a drain that stopped at the first empty moment would close the
	 * host between the two calls.
	 */
	private async whenIdle(): Promise<void> {
		// A `do`, not a `while`: at the instant teardown starts there may be nothing in flight
		// *yet* — `FileLogger.flush()` suspends on its own `initializePromise` before it issues
		// the first read — so one full turn always passes before this concludes idle.
		do {
			await Promise.all([...this.inFlight]);
			await new Promise(resolve => setImmediate(resolve));
		} while (this.inFlight.size);
	}

	/** `unref`, so winning the race is what ends the wait rather than the timer expiring. */
	private expired(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms).unref());
	}

	private receive(line: string): void {
		const message = parseHostMessageLine(line);
		if (!message) { return; }
		try { this.deliver(message); }
		catch (error) { this.die(`cannot deliver a host message: ${error}`); }
	}

	private deliver(message: IHostMessage): void {
		if (message.event !== undefined) {
			// A copy, because a handler is free to unlisten while it runs.
			for (const handler of [...this.listeners.get(message.event) ?? []]) {
				handler({ event: message.event, payload: message.payload });
			}

			return;
		}

		const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
		if (!pending) {
			console.error(`ipc.host: a reply with no request: ${JSON.stringify(message)}`);
			return;
		}

		this.pending.delete(message.id!);
		if (message.error !== undefined) {
			pending.reject(message.error);
		} else {
			pending.resolve(message.result);
		}
	}

	/**
	 * The host cannot come back — it holds the watchers, the repositories and the
	 * shells — so every request in flight fails and every later one fails the same
	 * way rather than hanging.
	 */
	private die(reason: string): void {
		this.gone ??= reason;
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) {
			request.reject(this.gone);
		}
	}
}

interface IHostProcessCloseTarget {
	once(event: 'close', listener: () => void): unknown;
	kill(): boolean;
}

/**
 * A child process's `exit` means its process ended; only `close` means the process and all stdio
 * handles are closed. The close listener is installed with ownership construction so even a child
 * that exits before shutdown begins cannot race past the teardown promise.
 */
export class HostProcessCloseBoundary {
	private readonly closed: Promise<void>;

	constructor(private readonly child: IHostProcessCloseTarget) {
		this.closed = new Promise(resolve => child.once('close', resolve));
	}

	async waitForClose(exited: Promise<void>, deadline: Promise<void>): Promise<void> {
		if (await Promise.race([exited.then(() => false), deadline.then(() => true)])) {
			this.child.kill();
		}
		await this.closed;
	}
}

let host: HostProcess | undefined;

function hostProcess(): HostProcess {
	host ??= new HostProcess(hostExecutable());

	return host;
}

/**
 * The host binary: whatever `TSCODE_HOST_PATH` names, else a `cargo build`
 * output.
 *
 * `CARGO_TARGET_DIR` comes first among the build outputs because cargo obeys it
 * too. A `target-dir` set only in a `.cargo/config.toml` is not read — that would
 * mean parsing TOML here — so a checkout redirected that way names the binary
 * with `TSCODE_HOST_PATH` instead.
 */
function hostExecutable(): string {
	const configured = process.env[HOST_PATH_VARIABLE];
	if (configured) {
		return configured;
	}

	const executable = process.platform === 'win32' ? 'tscode-host.exe' : 'tscode-host';
	const targets = [process.env['CARGO_TARGET_DIR'], checkoutRoot() && join(checkoutRoot()!, 'src-tauri', 'target')];
	const candidates = targets
		.filter((target): target is string => !!target)
		.flatMap(target => CARGO_PROFILES.map(profile => join(target, profile, executable)));

	const built = candidates.find(candidate => existsSync(candidate));
	if (!built) {
		throw new Error(`no tscode-host binary — build one with \`npm run build\`, or set ${HOST_PATH_VARIABLE}. Looked in:\n${candidates.join('\n')}`);
	}

	return built;
}

/** `invoke` from `@tauri-apps/api/core`. */
export function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	return hostProcess().invoke<T>(cmd, args);
}

/** `listen` from `@tauri-apps/api/event`. */
export function listen<T>(eventName: string, handler: EventCallback<T>): Promise<UnlistenFn> {
	return Promise.resolve(hostProcess().listen(eventName, handler));
}

/**
 * Ends the host, once what is in flight has been answered. Closing its stdin is what tells it
 * the frontend is gone, so its watchers, searches and shells stop with it — the teardown a
 * window's destruction used to perform.
 *
 * The reference is kept rather than cleared, and every later call rejects instead: a cleared
 * one would let `hostProcess()` lazily spawn a *second* host for whatever a teardown issues
 * after this, and that host has nobody left to stop it — the child and its two pipes then hold
 * the event loop open for ever, which is a boot that hangs after it has finished.
 */
export function stopHost(): Promise<void> {
	return host?.stop() ?? Promise.resolve();
}

/** Read-only lifetime diagnostic; does not create a host if no channel has needed one. */
export function hostProcessId(): number | undefined {
	return host?.pid;
}
