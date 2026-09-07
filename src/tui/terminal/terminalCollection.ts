/*---------------------------------------------------------------------------------------------
 * Production backend assembly for the neutral terminal collection controller.
 *--------------------------------------------------------------------------------------------*/
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { shouldPasteTerminalText } from '../../vs/workbench/contrib/terminalContrib/clipboard/browser/terminalClipboard.js';
import { TerminalCollectionController } from '../../terminal/terminalCollectionController.js';
import { EmbeddedRegionTerminalBackend } from './embeddedRegionBackend.js';
import { configuredRegionProfiles, defaultRegionLaunch, regionEnvironment, regionLaunchServices } from './launch.js';
import { ITerminalProfile } from '../../vs/platform/terminal/common/terminal.js';
import { IConfigurationResolverService } from '../../vs/workbench/services/configurationResolver/common/configurationResolver.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';

export interface ITerminalCollectionLaunch {
	readonly executable: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly label: string;
}

export type TerminalCollectionLaunchResolver = (profileId?: string) => Promise<ITerminalCollectionLaunch>;

/**
 * The one production assembly seam for EmbeddedRegion-backed collections. A caller may provide a
 * launch resolver (profiles and deterministic fixtures are both launch policy); PTY ownership and
 * projection remain the same neutral controller/backend path.
 */
export function createTerminalCollectionController(collectionId: string, instantiationService: IInstantiationService,
	resolveLaunch: TerminalCollectionLaunchResolver,
	resolveProfiles?: () => Promise<readonly Readonly<{ readonly id: string; readonly label: string }>[]>,
	preparePaste: (text: string, bracketed: boolean) => Promise<string | undefined> = async (text, bracketed) => {
		const accepted = await instantiationService.invokeFunction(shouldPasteTerminalText, text, bracketed);
		return accepted ? typeof accepted === 'object' ? accepted.modifiedText : text : undefined;
	}): TerminalCollectionController {
	return new TerminalCollectionController(collectionId, {
		create: async (terminalId, profileId) => {
			const launch = await resolveLaunch(profileId);
			return new EmbeddedRegionTerminalBackend({ id: terminalId, label: launch.label || 'terminal',
				executable: launch.executable, args: launch.args ? [...launch.args] : undefined,
				cwd: launch.cwd, env: { ...launch.env } }, instantiationService);
		}, profiles: resolveProfiles,
		preparePaste
	});
}

export function createDefaultTerminalCollectionController(collectionId: string,
	instantiationService: IInstantiationService): TerminalCollectionController {
	let detected: Promise<readonly ITerminalProfile[]> | undefined;
	const profiles = () => detected ??= instantiationService.invokeFunction(async accessor => {
		const workspaceFolder = accessor.get(IWorkspaceContextService).getWorkspace().folders[0] ?? undefined;
		return configuredRegionProfiles(regionLaunchServices(accessor), workspaceFolder, accessor.get(IConfigurationResolverService));
	});
	return createTerminalCollectionController(collectionId, instantiationService, async profileId => {
		if (profileId) {
			const profile = (await profiles()).find(candidate => candidate.profileName === profileId);
			if (!profile) { throw new Error(`terminal profile not found: ${profileId}`); }
			return instantiationService.invokeFunction(async accessor => {
				const services = regionLaunchServices(accessor);
				const config = { executable: profile.path, args: profile.args, env: profile.env };
				return { executable: profile.path, args: Array.isArray(profile.args) ? profile.args : profile.args ? [profile.args] : undefined,
					cwd: services.workspaceCwd, env: await regionEnvironment(services, config), label: profile.profileName };
			});
		}
		const launch = await instantiationService.invokeFunction(async accessor => defaultRegionLaunch(regionLaunchServices(accessor)));
		if (!launch.config.executable) { throw new Error('default terminal launch has no executable'); }
		return { executable: launch.config.executable,
			args: Array.isArray(launch.config.args) ? launch.config.args : launch.config.args ? [launch.config.args] : undefined,
			cwd: launch.cwd, env: { ...launch.env }, label: launch.label || 'terminal' };
	}, async () => (await profiles()).map(profile => ({ id: profile.profileName, label: profile.profileName })));
}
