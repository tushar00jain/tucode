/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IProcessEnvironment } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { whenSubscribed } from '../../../base/parts/ipc/tauri/ipc.tauri.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IProcessProperty, IProcessPropertyMap, IProcessReadyEvent, IProcessReadyWindowsPty, IShellLaunchConfig, ITerminalChildProcess, ITerminalLaunchError, ITerminalLaunchResult, ITerminalProcessOptions, ProcessPropertyType, TerminalShellType } from '../common/terminal.js';
import { getShellIntegrationInjection } from './terminalEnvironment.js';

/**
 * The channel `src-tauri/crates/tscode-app/src/channels/pty.rs` serves. It is pinned here for the same reason
 * `FILE_CHANNEL_NAME` is pinned in `tauriFileSystemProvider.ts`: the process, the backend and
 * the shell environment service all address it, so the name has one home.
 */
export const PTY_CHANNEL_NAME = 'pty';

/**
 * The `{ error }` arm of `start`'s result. `null` is stock's `undefined`, and a launch failure
 * is data rather than a channel error because the frontend renders the message inside the
 * terminal.
 */
interface IStartFailure {
	readonly error: ITerminalLaunchError;
}

/**
 * `ITerminalChildProcess` over the `pty` channel — the only implementation of the seam this
 * port replaces, standing where `node/terminalProcess.ts` stands upstream. Everything above it
 * is vendored: `PersistentTerminalProcess` holds one of these, and `LocalPty` reaches it
 * through `PtyService`.
 *
 * A pty is created lazily, in `start()`, because that is where shell-integration injection is
 * resolved and the injected argv and environment have to reach the backend with the rest of the
 * launch config. Everything that can only follow a launch therefore addresses `ptyId`.
 */
export class TauriTerminalProcess extends Disposable implements ITerminalChildProcess {
	readonly id = 0;
	readonly shouldPersist = false;

	/** Resolves with the backend's pty id once `create` has answered. */
	private _ptyId: Promise<number> | undefined;
	/**
	 * Keeps commands in the order the terminal produced them. Two `invoke` calls are two
	 * independent futures on the backend's runtime, so a write and the resize that followed it
	 * would otherwise be free to land the other way around.
	 */
	private _queue: Promise<unknown> = Promise.resolve();

	private _currentTitle: string = '';
	private _shellType: TerminalShellType | undefined;
	private _hasChildProcesses: boolean = false;
	private _windowsPty: IProcessReadyWindowsPty | undefined;

	get currentTitle(): string { return this._currentTitle; }
	get shellType(): TerminalShellType | undefined { return this._shellType; }
	get hasChildProcesses(): boolean { return this._hasChildProcesses; }

	private readonly _onProcessData = this._register(new Emitter<string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;
	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	constructor(
		readonly shellLaunchConfig: IShellLaunchConfig,
		private readonly _initialCwd: string,
		private readonly _cols: number,
		private readonly _rows: number,
		private readonly _env: IProcessEnvironment,
		private readonly _executableEnv: IProcessEnvironment,
		private readonly _options: ITerminalProcessOptions,
		private readonly _channel: IChannel,
		private readonly _fileChannel: IChannel,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
		private readonly _productService: IProductService
	) {
		super();
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		// Port of `TerminalProcess.start`'s injection block. The cwd and executable validation
		// either side of it is the backend's, since both read the filesystem it owns.
		const injection = await getShellIntegrationInjection(this.shellLaunchConfig, this._options, this._env, this._logService, this._productService, this._fileService, this._channel, this._fileChannel);
		if (injection.type === 'injection') {
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.UsedShellIntegrationInjection, value: true });
			if (injection.envMixin) {
				for (const [key, value] of Object.entries(injection.envMixin)) {
					this._env[key] = value;
				}
			}
			if (injection.filesToCopy) {
				for (const f of injection.filesToCopy) {
					try {
						// `IFileService.copy` creates the target's parent, so upstream's `mkdir`
						// is not needed here.
						await this._fileService.copy(URI.file(f.source), URI.file(f.dest), true);
					} catch {
						// Swallow error, this should only happen when multiple users are on the same
						// machine. Since the shell integration scripts rarely change, plus the other user
						// should be using the same version of the server in this case, assume the script is
						// fine if copy fails and swallow the error.
					}
				}
			}
		} else {
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.FailedShellIntegrationActivation, value: true });
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.ShellIntegrationInjectionFailureReason, value: injection.reason });
			// Even if shell integration injection failed, still set the nonce if one was provided
			// This allows extensions to use shell integration with custom shells
			if (this._options.shellIntegration.nonce) {
				this._env['VSCODE_NONCE'] = this._options.shellIntegration.nonce;
			}
		}

		const newArgs = injection.type === 'injection' ? injection.newArgs : undefined;
		const ptyId = await this._create(newArgs);
		const failure = await this._channel.call<IStartFailure | null>('start', { ptyId });
		if (failure) {
			return failure.error;
		}
		// The backend answers `null` on success: it never sees the injected argv as anything but
		// part of the launch config, so the result stock derives from it is synthesised here.
		return newArgs ? { injectedArgs: newArgs } : undefined;
	}

	/**
	 * Mints the pty and attaches its four event streams, and does not answer until the backend
	 * holds all four.
	 *
	 * `PtyChannel` drops an event nobody has subscribed to, and `start` spawns the shell — so
	 * the wait is what keeps a launch from outrunning its own subscriptions. It cannot be left
	 * to ordering: a subscription is two round-trips to `start`'s one, so `start` wins every
	 * time. The event at stake is `onProcessReady`, and losing it strands
	 * `TerminalProcessManager.ptyProcessReady` — every keystroke is swallowed by the `await` in
	 * front of `write` while output still arrives.
	 */
	private async _create(newArgs: string[] | undefined): Promise<number> {
		const shellLaunchConfig = newArgs ? { ...this.shellLaunchConfig, args: newArgs } : this.shellLaunchConfig;
		this._ptyId = this._channel.call<number>('create', {
			shellLaunchConfig,
			cwd: this._initialCwd,
			cols: this._cols,
			rows: this._rows,
			env: this._env,
			executableEnv: this._executableEnv,
			options: this._options
		});

		const ptyId = await this._ptyId;
		const arg = { ptyId };
		this._register(this._channel.listen<string>('onProcessData', arg)(data => this._onProcessData.fire(data)));
		this._register(this._channel.listen<IProcessReadyEvent>('onProcessReady', arg)(e => {
			this._windowsPty = e.windowsPty;
			this._onProcessReady.fire(e);
		}));
		this._register(this._channel.listen<IProcessProperty>('onDidChangeProperty', arg)(property => this._handleDidChangeProperty(property)));
		this._register(this._channel.listen<number | undefined>('onProcessExit', arg)(code => {
			this._onProcessExit.fire(code);
			// The backend has already forgotten the pty, so the subscriptions above have nothing
			// left to carry.
			this.dispose();
		}));

		await whenSubscribed(this._channel);

		return ptyId;
	}

	/** Mirrors the properties stock's `TerminalProcess` answers from its own state. */
	private _handleDidChangeProperty({ type, value }: IProcessProperty): void {
		switch (type) {
			case ProcessPropertyType.Title:
				this._currentTitle = value as IProcessPropertyMap[ProcessPropertyType.Title];
				break;
			case ProcessPropertyType.ShellType:
				this._shellType = value as IProcessPropertyMap[ProcessPropertyType.ShellType];
				break;
			case ProcessPropertyType.HasChildProcesses:
				this._hasChildProcesses = value as IProcessPropertyMap[ProcessPropertyType.HasChildProcesses];
				break;
		}
		this._onDidChangeProperty.fire({ type, value });
	}

	/**
	 * A command that answers. Only ever called once the terminal is running, so an absent pty
	 * is a programming error rather than a race.
	 */
	private async _call<T>(command: string, args: object = {}): Promise<T> {
		if (!this._ptyId) {
			throw new Error(`pty#${command} was called before the process was created`);
		}
		return this._channel.call<T>(command, { ptyId: await this._ptyId, ...args });
	}

	/**
	 * A command that does not answer, queued behind the ones before it. Anything that arrives
	 * before `start()` has no pty to reach and is dropped, as stock drops a write issued before
	 * `node-pty` has spawned.
	 */
	private _send(command: string, args: object = {}): Promise<void> {
		if (!this._ptyId) {
			this._logService.trace(`pty#${command} was called before the process was created`);
			return Promise.resolve();
		}
		const pending = this._queue.then(() => this._call<void>(command, args));
		this._queue = pending.catch(err => this._logService.error(`pty#${command}`, err));
		return pending;
	}

	shutdown(immediate: boolean): Promise<void> {
		return this._send('shutdown', { immediate });
	}

	input(data: string): void {
		this._send('input', { data });
	}

	sendSignal(signal: string): void {
		this._send('sendSignal', { signal });
	}

	processBinary(data: string): Promise<void> {
		return this._send('processBinary', { data });
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		this._send('resize', { cols, rows, pixelWidth, pixelHeight });
	}

	clearBuffer(): void {
		this._send('clearBuffer');
	}

	acknowledgeDataEvent(charCount: number): void {
		this._send('acknowledgeDataEvent', { charCount });
	}

	/**
	 * Not part of `ITerminalChildProcess`: `PersistentTerminalProcess.triggerReplay` calls it on
	 * the concrete process, so the vendored copy reaches this directly.
	 */
	clearUnacknowledgedChars(): void {
		this._send('clearUnacknowledgedChars');
	}

	async setUnicodeVersion(version: '6' | '11'): Promise<void> {
		// No-op
	}

	getInitialCwd(): Promise<string> {
		return Promise.resolve(this._initialCwd);
	}

	async getCwd(): Promise<string> {
		if (!this._ptyId) {
			return this._initialCwd;
		}
		return this._call<string>('getCwd');
	}

	getWindowsPty(): IProcessReadyWindowsPty | undefined {
		return this._windowsPty;
	}

	async refreshProperty<T extends ProcessPropertyType>(type: T): Promise<IProcessPropertyMap[T]> {
		return this._call<IProcessPropertyMap[T]>('refreshProperty', { property: type });
	}

	async updateProperty<T extends ProcessPropertyType>(type: T, value: IProcessPropertyMap[T]): Promise<void> {
		await this._send('updateProperty', { property: type, value });
	}
}
