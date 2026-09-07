/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { IProcessEnvironment, isMacintosh, isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProcessPropertyMap, IPtyHostController, IPtyHostLatencyMeasurement, IPtyService, IShellLaunchConfig, ITerminalBackend, ITerminalBackendRegistry, ITerminalChildProcess, ITerminalEnvironment, ITerminalLogService, ITerminalProcessOptions, ITerminalProfile, ITerminalProfileObject, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, ITerminalUnsafePath, LocalReconnectConstants, ProcessPropertyType, TerminalExtensions, TerminalSettingId, TitleEventSource } from '../../../../platform/terminal/common/terminal.js';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, ISetTerminalLayoutInfoArgs } from '../../../../platform/terminal/common/terminalProcess.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalInstanceService, ITerminalService } from '../browser/terminal.js';
import { ITerminalProfileResolverService } from '../common/terminal.js';
import { TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import { LocalPty } from '../electron-browser/localPty.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IShellEnvironmentService } from '../../../services/environment/tauri/shellEnvironmentService.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import * as terminalEnvironment from '../common/terminalEnvironment.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IEnvironmentVariableService } from '../common/environmentVariable.js';
import { BaseTerminalBackend } from '../browser/baseTerminalBackend.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { PtyService } from '../../../../platform/terminal/tauri/ptyService.js';
import { PTY_CHANNEL_NAME } from '../../../../platform/terminal/tauri/tauriTerminalProcess.js';
import { FILE_CHANNEL_NAME } from '../../../services/files/tauri/tauriFileSystemProvider.js';
import { mark, PerformanceMark } from '../../../../base/common/performance.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { memoize } from '../../../../base/common/decorators.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { shouldUseEnvironmentVariableCollection } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { resolveTerminalProfilePaths } from '../common/terminalProfilePaths.js';

export class TauriTerminalBackendContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriTerminalBackend';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@ITerminalService terminalService: ITerminalService
	) {
		const backend = instantiationService.createInstance(TauriTerminalBackend);
		Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
		terminalInstanceService.didRegisterBackend(backend);
		// `TerminalService` reads process support off `!isWeb || a remote connection`, and this
		// workbench is neither: it runs in a webview with the pty host in front of it. Stock's
		// web build says so through this same call, from the extension host this port has not.
		terminalService.registerProcessSupport(true);
	}
}

/**
 * There is no pty host to supervise, so the events `BaseTerminalBackend` attaches to never
 * fire and restarting is a no-op. `getProfiles` is the one member with something behind it —
 * discovery is the backend's, and stock reaches it through this interface.
 */
class TauriPtyHostController implements IPtyHostController {
	readonly onPtyHostExit = Event.None;
	readonly onPtyHostStart = Event.None;
	readonly onPtyHostUnresponsive = Event.None;
	readonly onPtyHostResponsive = Event.None;
	readonly onPtyHostRequestResolveVariables = Event.None;

	constructor(private readonly _channel: IChannel) { }

	async restartPtyHost(): Promise<void> { }

	async acceptPtyHostResolvedVariables(requestId: number, resolved: string[]): Promise<void> { }

	getProfiles(workspaceId: string, profiles: unknown, defaultProfile: unknown, includeDetectedProfiles?: boolean): Promise<ITerminalProfile[]> {
		return this._channel.call<ITerminalProfile[]>('detectProfiles', { profiles, defaultProfile, includeDetectedProfiles });
	}
}

class TauriTerminalBackend extends BaseTerminalBackend implements ITerminalBackend {
	readonly remoteAuthority = undefined;

	private readonly _ptys: Map<number, LocalPty> = new Map();

	/**
	 * Upstream reaches its pty host over a `MessagePort`; here `PtyService` is a plain object in
	 * this window, so the proxy is the service itself.
	 */
	private readonly _proxy: IPtyService;
	// Stock reads profiles off `_localPtyService`, its own second reference to the object it
	// hands the base class. `BaseTerminalBackend` keeps that one private, so this is the same
	// second reference under a name that does not shadow it.
	private readonly _tauriPtyHostController: TauriPtyHostController;

	private readonly _whenReady = new DeferredPromise<void>();
	get whenReady(): Promise<void> { return this._whenReady.p; }
	setReady(): void { this._whenReady.complete(); }

	private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>());
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	constructor(
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ITerminalLogService logService: ITerminalLogService,
		@ILabelService private readonly _labelService: ILabelService,
		@IShellEnvironmentService private readonly _shellEnvironmentService: IShellEnvironmentService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProductService private readonly _productService: IProductService,
		@IHistoryService private readonly _historyService: IHistoryService,
		@ITerminalProfileResolverService private readonly _terminalProfileResolverService: ITerminalProfileResolverService,
		@IEnvironmentVariableService private readonly _environmentVariableService: IEnvironmentVariableService,
		@IHistoryService historyService: IHistoryService,
		@IStatusbarService statusBarService: IStatusbarService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IFileService fileService: IFileService,
	) {
		const channel = mainProcessService.getChannel(PTY_CHANNEL_NAME);
		const ptyHostController = new TauriPtyHostController(channel);
		super(ptyHostController, logService, historyService, _configurationResolverService, statusBarService, workspaceContextService);
		this._tauriPtyHostController = ptyHostController;

		// Stock builds these in `electronPtyHostStarter.ts`, which this port has no counterpart
		// for; the simulated latency is a pty host debugging flag and is always off.
		const proxy = this._register(new PtyService(
			logService,
			_productService,
			{
				graceTime: LocalReconnectConstants.GraceTime,
				shortGraceTime: LocalReconnectConstants.ShortGraceTime,
				scrollback: _configurationService.getValue<number>(TerminalSettingId.PersistentSessionScrollback) ?? 100
			},
			0,
			channel,
			mainProcessService.getChannel(FILE_CHANNEL_NAME),
			fileService
		));
		this._proxy = proxy;

		// Attach process listeners. Upstream does this once the message port is up; the service
		// is here from the start, so there is nothing to wait for.
		this._register(proxy.onProcessData(e => this._ptys.get(e.id)?.handleData(e.event)));
		this._register(proxy.onDidChangeProperty(e => this._ptys.get(e.id)?.handleDidChangeProperty(e.property)));
		this._register(proxy.onProcessExit(e => {
			const pty = this._ptys.get(e.id);
			if (pty) {
				pty.handleExit(e.event);
				pty.dispose();
				this._ptys.delete(e.id);
			}
		}));
		this._register(proxy.onProcessReady(e => this._ptys.get(e.id)?.handleReady(e.event)));
		this._register(proxy.onProcessReplay(e => this._ptys.get(e.id)?.handleReplay(e.event)));
		this._register(proxy.onProcessOrphanQuestion(e => this._ptys.get(e.id)?.handleOrphanQuestion()));
		this._register(proxy.onDidRequestDetach(e => this._onDidRequestDetach.fire(e)));

		this._onPtyHostConnected.fire();

		// Eagerly fetch the backend's environment for memoization
		this.getEnvironment();
	}

	async requestDetachInstance(workspaceId: string, instanceId: number): Promise<IProcessDetails | undefined> {
		return this._proxy.requestDetachInstance(workspaceId, instanceId);
	}

	async acceptDetachInstanceReply(requestId: number, persistentProcessId?: number): Promise<void> {
		if (!persistentProcessId) {
			this._logService.warn('Cannot attach to feature terminals, custom pty terminals, or those without a persistentProcessId');
			return;
		}
		return this._proxy.acceptDetachInstanceReply(requestId, persistentProcessId);
	}

	async persistTerminalState(): Promise<void> {
		const ids = Array.from(this._ptys.keys());
		const serialized = await this._proxy.serializeTerminalState(ids);
		this._storageService.store(TerminalStorageKeys.TerminalBufferState, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async updateTitle(id: number, title: string, titleSource: TitleEventSource): Promise<void> {
		await this._proxy.updateTitle(id, title, titleSource);
	}

	async updateIcon(id: number, userInitiated: boolean, icon: URI | { light: URI; dark: URI } | { id: string; color?: { id: string } }, color?: string): Promise<void> {
		await this._proxy.updateIcon(id, userInitiated, icon, color);
	}

	async setNextCommandId(id: number, commandLine: string, commandId: string): Promise<void> {
		await this._proxy.setNextCommandId(id, commandLine, commandId);
	}

	async updateProperty<T extends ProcessPropertyType>(id: number, property: ProcessPropertyType, value: IProcessPropertyMap[T]): Promise<void> {
		return this._proxy.updateProperty(id, property, value);
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		unicodeVersion: '6' | '11',
		env: IProcessEnvironment,
		options: ITerminalProcessOptions,
		shouldPersist: boolean
	): Promise<ITerminalChildProcess> {
		const executableEnv = await this._shellEnvironmentService.getShellEnv();
		const id = await this._proxy.createProcess(shellLaunchConfig, cwd, cols, rows, unicodeVersion, env, executableEnv, options, shouldPersist, this._getWorkspaceId(), this._getWorkspaceName());
		const pty = new LocalPty(id, shouldPersist, this._proxy);
		this._ptys.set(id, pty);
		return pty;
	}

	async attachToProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		try {
			await this._proxy.attachToProcess(id);
			const pty = new LocalPty(id, true, this._proxy);
			this._ptys.set(id, pty);
			return pty;
		} catch (e) {
			this._logService.warn(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async attachToRevivedProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		try {
			const newId = await this._proxy.getRevivedPtyNewId(this._getWorkspaceId(), id) ?? id;
			return await this.attachToProcess(newId);
		} catch (e) {
			this._logService.warn(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async listProcesses(): Promise<IProcessDetails[]> {
		return this._proxy.listProcesses();
	}

	/**
	 * Stock measures the two hops to its pty host. The only hop here is the channel, and the
	 * pty ids it addresses are `PtyService`'s rather than a process's, so the measurement is of
	 * one round-trip to Rust.
	 */
	async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
		const sw = new StopWatch();
		await this._proxy.getEnvironment();
		sw.stop();
		return [{
			label: 'window<->pty channel',
			latency: sw.elapsed()
		}];
	}

	async getPerformanceMarks(): Promise<PerformanceMark[]> {
		return this._proxy.getPerformanceMarks();
	}

	async reduceConnectionGraceTime(): Promise<void> {
		this._proxy.reduceConnectionGraceTime();
	}

	async getDefaultSystemShell(osOverride?: OperatingSystem): Promise<string> {
		return this._proxy.getDefaultSystemShell(osOverride);
	}

	async getProfiles(profiles: unknown, defaultProfile: unknown, includeDetectedProfiles?: boolean) {
		const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot(Schemas.file);
		const workspaceFolder = activeWorkspaceRootUri ? this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri) ?? undefined : undefined;
		return this._tauriPtyHostController.getProfiles(this._workspaceContextService.getWorkspace().id,
			await resolveTerminalProfilePaths(profiles, workspaceFolder, this._configurationResolverService),
			defaultProfile, includeDetectedProfiles) || [];
	}

	@memoize
	async getEnvironment(): Promise<IProcessEnvironment> {
		return this._proxy.getEnvironment();
	}

	@memoize
	async getShellEnvironment(): Promise<IProcessEnvironment> {
		// Stock also merges the environment an extension development host was launched with;
		// there is no extension host here.
		return { ... await this._shellEnvironmentService.getShellEnv() };
	}

	async getWslPath(original: string, direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
		return this._proxy.getWslPath(original, direction);
	}

	async setTerminalLayoutInfo(layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
		const args: ISetTerminalLayoutInfoArgs = {
			workspaceId: this._getWorkspaceId(),
			tabs: layoutInfo ? layoutInfo.tabs : [],
			background: layoutInfo ? layoutInfo.background : null
		};
		await this._proxy.setTerminalLayoutInfo(args);
		// Store in the storage service as well to be used when reviving processes as normally this
		// is stored in memory on the pty host
		this._storageService.store(TerminalStorageKeys.TerminalLayoutInfo, JSON.stringify(args), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		const workspaceId = this._getWorkspaceId();
		const layoutArgs: IGetTerminalLayoutInfoArgs = { workspaceId };

		// Revive processes if needed
		const serializedState = this._storageService.get(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
		const reviveBufferState = this._deserializeTerminalState(serializedState);
		if (reviveBufferState && reviveBufferState.length > 0) {
			try {
				// Create variable resolver
				const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot();
				const lastActiveWorkspace = activeWorkspaceRootUri ? this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri) ?? undefined : undefined;
				const variableResolver = terminalEnvironment.createVariableResolver(lastActiveWorkspace, await this._terminalProfileResolverService.getEnvironment(this.remoteAuthority), this._configurationResolverService);

				// Re-resolve the environments and replace it on the state so local terminals use a fresh
				// environment
				mark('code/terminal/willGetReviveEnvironments');
				await Promise.all(reviveBufferState.map(state => new Promise<void>(r => {
					this._resolveEnvironmentForRevive(variableResolver, state.shellLaunchConfig).then(freshEnv => {
						state.processLaunchConfig.env = freshEnv;
						r();
					});
				})));
				mark('code/terminal/didGetReviveEnvironments');

				mark('code/terminal/willReviveTerminalProcesses');
				await this._proxy.reviveTerminalProcesses(workspaceId, reviveBufferState, Intl.DateTimeFormat().resolvedOptions().locale);
				mark('code/terminal/didReviveTerminalProcesses');
				this._storageService.remove(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
				// If reviving processes, send the terminal layout info back to the pty host as it
				// will not have been persisted on application exit
				const layoutInfo = this._storageService.get(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				if (layoutInfo) {
					mark('code/terminal/willSetTerminalLayoutInfo');
					await this._proxy.setTerminalLayoutInfo(JSON.parse(layoutInfo));
					mark('code/terminal/didSetTerminalLayoutInfo');
					this._storageService.remove(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				}
			} catch (e: unknown) {
				this._logService.warn('LocalTerminalBackend#getTerminalLayoutInfo Error', (<{ message?: string }>e).message ?? e);
			}
		}

		return this._proxy.getTerminalLayoutInfo(layoutArgs);
	}

	private async _resolveEnvironmentForRevive(variableResolver: terminalEnvironment.VariableResolver | undefined, shellLaunchConfig: IShellLaunchConfig): Promise<IProcessEnvironment> {
		const platformKey = isWindows ? 'windows' : (isMacintosh ? 'osx' : 'linux');
		const envFromConfigValue = this._configurationService.getValue<ITerminalEnvironment | undefined>(`terminal.integrated.env.${platformKey}`);
		const baseEnv = await (shellLaunchConfig.useShellEnvironment ? this.getShellEnvironment() : this.getEnvironment());
		const env = await terminalEnvironment.createTerminalEnvironment(shellLaunchConfig, envFromConfigValue, variableResolver, this._productService.version, this._configurationService.getValue(TerminalSettingId.DetectLocale), baseEnv);
		if (shouldUseEnvironmentVariableCollection(shellLaunchConfig)) {
			const workspaceFolder = terminalEnvironment.getWorkspaceForTerminal(shellLaunchConfig.cwd, this._workspaceContextService, this._historyService);
			await this._environmentVariableService.mergedCollection.applyToProcessEnvironment(env, { workspaceFolder }, variableResolver);
		}
		return env;
	}

	private _getWorkspaceName(): string {
		return this._labelService.getWorkspaceLabel(this._workspaceContextService.getWorkspace());
	}

	// #region Pty service contribution RPC calls

	installAutoReply(match: string, reply: string): Promise<void> {
		return this._proxy.installAutoReply(match, reply);
	}
	uninstallAllAutoReplies(): Promise<void> {
		return this._proxy.uninstallAllAutoReplies();
	}

	// #endregion
}
