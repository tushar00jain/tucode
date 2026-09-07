/*---------------------------------------------------------------------------------------------
 *  The platform-neutral launch resolved for every non-DOM terminal region.
 *
 *  `TerminalProfileResolverService` is coupled to the browser terminal service and its DOM host.
 *  The narrow region path instead asks the existing PTY channel for the default shell and uses
 *  upstream's `createTerminalEnvironment` verbatim, keeping shell discovery and environment
 *  composition outside individual terminal regions.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/terminal/browser/terminalProfileResolverService.ts
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment, isMacintosh, isWindows } from '../../vs/base/common/platform.js';
import { IChannel } from '../../vs/base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../vs/platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../vs/platform/ipc/common/mainProcessService.js';
import { IProductService } from '../../vs/platform/product/common/productService.js';
import { IShellLaunchConfig, ITerminalEnvironment, ITerminalProfile, TerminalSettingPrefix } from '../../vs/platform/terminal/common/terminal.js';
import { PTY_CHANNEL_NAME } from '../../vs/platform/terminal/tauri/tauriTerminalProcess.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../vs/platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../vs/workbench/services/configurationResolver/common/configurationResolver.js';
import { registerTerminalConfiguration } from '../../vs/workbench/contrib/terminal/common/terminalConfiguration.js';
import { createTerminalEnvironment } from '../../vs/workbench/contrib/terminal/common/terminalEnvironment.js';
import { resolveTerminalProfilePaths } from '../../vs/workbench/contrib/terminal/common/terminalProfilePaths.js';

const ENV_SETTING = isWindows ? 'terminal.integrated.env.windows' : isMacintosh ? 'terminal.integrated.env.osx' : 'terminal.integrated.env.linux';

// Upstream registers this from `terminal.contribution.ts`. This non-DOM frontend deliberately does not
// import that contribution's browser closure, so the shared launch seam registers its settings.
void registerTerminalConfiguration(async () => []);

export interface IRegionLaunchServices {
	readonly channel: IChannel;
	readonly configurationService: IConfigurationService;
	readonly version: string | undefined;
	readonly workspaceCwd: string;
}

export function regionLaunchServices(accessor: ServicesAccessor): IRegionLaunchServices {
	return {
		channel: accessor.get(IMainProcessService).getChannel(PTY_CHANNEL_NAME),
		configurationService: accessor.get(IConfigurationService),
		version: accessor.get(IProductService).version,
		workspaceCwd: accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri.fsPath ?? ''
	};
}

export async function configuredRegionProfiles(services: IRegionLaunchServices, workspaceFolder: IWorkspaceFolder | undefined,
	configurationResolverService: IConfigurationResolverService): Promise<readonly ITerminalProfile[]> {
	const platform = isWindows ? 'windows' : isMacintosh ? 'osx' : 'linux';
	const configured = services.configurationService.getValue(`${TerminalSettingPrefix.Profiles}${platform}`);
	const defaultProfile = services.configurationService.getValue(`${TerminalSettingPrefix.DefaultProfile}${platform}`);
	return services.channel.call<ITerminalProfile[]>('detectProfiles', {
		profiles: await resolveTerminalProfilePaths(configured, workspaceFolder, configurationResolverService),
		defaultProfile, includeDetectedProfiles: true
	});
}

export async function regionEnvironment(services: IRegionLaunchServices, launch: IShellLaunchConfig): Promise<IProcessEnvironment> {
	return createTerminalEnvironment(
		launch,
		services.configurationService.getValue<ITerminalEnvironment>(ENV_SETTING),
		undefined,
		services.version,
		services.configurationService.getValue<'auto' | 'off' | 'on'>('terminal.integrated.detectLocale'),
		await services.channel.call<IProcessEnvironment>('getEnvironment'));
}

export async function defaultRegionLaunch(services: IRegionLaunchServices): Promise<{
	readonly config: IShellLaunchConfig;
	readonly cwd: string;
	readonly env: IProcessEnvironment;
	readonly label: string;
}> {
	const executable = await services.channel.call<string>('getDefaultSystemShell', {});
	const config: IShellLaunchConfig = { executable, args: [] };

	return { config, cwd: services.workspaceCwd, env: await regionEnvironment(services, config), label: executable };
}
