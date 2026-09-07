import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

export function assertGone(pid) {
	assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH', `owned pane pid ${pid} survived`);
}

export function createZshPtyHarness(prefix, collectionId) {
	return createRealPtyHarness({
		prefix, collectionId,
		createLaunch: ({ fixtureRoot }) => ({ executable: '/bin/zsh', args: ['-f'], cwd: fixtureRoot,
			env: { ...process.env }, label: 'zsh' })
	});
}

export function dispatch(controller, event) {
	const snapshot = controller.projection.snapshot;
	return controller.projection.dispatch({ ...event, collectionId: snapshot.collectionId, generation: snapshot.generation });
}

export function terminalEvent(controller, terminalId, event) {
	const collection = controller.projection.snapshot;
	const terminal = collection.sessions.find(value => value.terminalId === terminalId);
	assert.ok(terminal);
	return dispatch(controller, { kind: 'terminal', event: { ...event, terminalId, generation: terminal.generation } });
}

export async function snapshotWhen(controller, predicate, { label = 'terminal snapshot', rejectExited = false } = {}) {
	if (predicate(controller.projection.snapshot)) return controller.projection.snapshot;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { listener.dispose(); reject(new Error(`timed out: ${label}`)); }, 10_000);
		const listener = controller.projection.onDidSnapshot(snapshot => {
			if (snapshot.error || (rejectExited && snapshot.sessions.some(session => session.exited)) || predicate(snapshot)) {
				clearTimeout(timer); listener.dispose(); resolve();
			}
		});
	});
	const snapshot = controller.projection.snapshot;
	if (snapshot.error) throw new Error(`${label}: ${snapshot.error}`);
	if (rejectExited && snapshot.sessions.some(session => session.exited) && !predicate(snapshot)) {
		throw new Error(`${label}: terminal exited: ${JSON.stringify(snapshot.sessions[0])}`);
	}
	return snapshot;
}

export async function createRealPtyHarness({
	prefix,
	collectionId,
	workspaceRoot = () => ROOT,
	configurationValue = key => key === 'terminal.integrated.shellIntegration.enabled' ? false : undefined,
	prepare = async () => undefined,
	createLaunch,
	shellIntegration = false
}) {
	const fixtureParent = join(ROOT, '.build', 'test-fixtures');
	mkdirSync(fixtureParent, { recursive: true });
	const fixtureRoot = mkdtempSync(join(fixtureParent, prefix));
	const userData = join(fixtureRoot, 'user-data');
	const previousUserData = process.env.TSCODE_USER_DATA_DIR;
	process.env.TSCODE_USER_DATA_DIR = userData;
	const disposables = [];
	let controller;
	let stopHost;
	try {
		const prepared = await prepare(fixtureRoot);
		const [{ stopHost: stop }, { createTerminalCollectionController }, { TauriMainProcessService },
			{ FileService }, { TauriFileSystemProvider, FILE_CHANNEL_NAME }, { NullLogService },
			{ ServiceCollection }, { InstantiationService }, { IMainProcessService }, { IFileService },
			{ ILogService }, { IProductService }, { default: product }, { IThemeService },
			{ IConfigurationService }, { URI }, terminalEnvironment] = await Promise.all([
			import('../../out/src/vs/base/parts/ipc/node/ipc.host.js'),
			import('../../out/src/tui/terminal/terminalCollection.js'),
			import('../../out/src/vs/base/parts/ipc/tauri/ipc.tauri.js'),
			import('../../out/src/vs/platform/files/common/fileService.js'),
			import('../../out/src/vs/workbench/services/files/tauri/tauriFileSystemProvider.js'),
			import('../../out/src/vs/platform/log/common/log.js'),
			import('../../out/src/vs/platform/instantiation/common/serviceCollection.js'),
			import('../../out/src/vs/platform/instantiation/common/instantiationService.js'),
			import('../../out/src/vs/platform/ipc/common/mainProcessService.js'),
			import('../../out/src/vs/platform/files/common/files.js'),
			import('../../out/src/vs/platform/log/common/log.js'),
			import('../../out/src/vs/platform/product/common/productService.js'),
			import('../../out/src/vs/platform/product/common/product.js'),
			import('../../out/src/vs/platform/theme/common/themeService.js'),
			import('../../out/src/vs/platform/configuration/common/configuration.js'),
			import('../../out/src/vs/base/common/uri.js'),
			shellIntegration ? import('../../out/src/vs/platform/terminal/tauri/terminalEnvironment.js') : Promise.resolve(undefined)
		]);
		stopHost = stop;
		const mainProcessService = new TauriMainProcessService();
		await mainProcessService.getChannel(FILE_CHANNEL_NAME).call('registerWorkspaceRoot', URI.file(workspaceRoot(fixtureRoot)));
		if (shellIntegration) {
			const registeredUserData = URI.revive(await mainProcessService.getChannel(FILE_CHANNEL_NAME).call('userDataDir'));
			terminalEnvironment.setAppResourceRoot(ROOT);
			terminalEnvironment.setShellIntegrationWritableRoot(registeredUserData.fsPath);
		}
		const fileService = new FileService(new NullLogService());
		const provider = new TauriFileSystemProvider(mainProcessService);
		disposables.push(provider, fileService.registerProvider('file', provider), fileService);
		const services = new ServiceCollection();
		services.set(IMainProcessService, mainProcessService);
		services.set(IFileService, fileService);
		services.set(ILogService, new NullLogService());
		services.set(IProductService, { _serviceBrand: undefined, ...product });
		services.set(IThemeService, { _serviceBrand: undefined, getColorTheme: () => ({ getColor: () => undefined }) });
		services.set(IConfigurationService, { _serviceBrand: undefined, getValue: configurationValue });
		controller = createTerminalCollectionController(collectionId, new InstantiationService(services, true),
			async () => createLaunch({ fixtureRoot, userData, prepared }), async text => text);
		let disposed = false;
		return {
			fixtureRoot, userData, product, controller,
			dispatch: event => dispatch(controller, event),
			terminalEvent: (terminalId, event) => terminalEvent(controller, terminalId, event),
			snapshotWhen: (predicate, options) => snapshotWhen(controller, predicate, options),
			async createTerminal(predicate, options) {
				dispatch(controller, { kind: 'create' });
				const snapshot = await snapshotWhen(controller, predicate, options);
				const terminalId = snapshot.sessions[0].terminalId;
				const pid = controller.diagnostics()[0].pid;
				assert.ok(Number.isSafeInteger(pid) && pid > 1);
				return { snapshot, terminalId, pid };
			},
			async closeTerminal(terminalId) {
				dispatch(controller, { kind: 'close', terminalId });
				await controller.whenSettled();
			},
			async dispose() {
				if (disposed) return;
				disposed = true;
				controller.dispose();
				for (const disposable of disposables.reverse()) disposable.dispose?.();
				await stopHost();
				restoreUserData(previousUserData);
				rmSync(fixtureRoot, { recursive: true, force: true });
			}
		};
	} catch (error) {
		controller?.dispose();
		for (const disposable of disposables.reverse()) disposable.dispose?.();
		if (stopHost) await stopHost();
		restoreUserData(previousUserData);
		rmSync(fixtureRoot, { recursive: true, force: true });
		throw error;
	}
}

function restoreUserData(previous) {
	if (previous === undefined) delete process.env.TSCODE_USER_DATA_DIR;
	else process.env.TSCODE_USER_DATA_DIR = previous;
}
