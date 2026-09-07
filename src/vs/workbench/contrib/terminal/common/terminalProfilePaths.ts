/*---------------------------------------------------------------------------------------------
 * Shared configured-terminal-profile path resolution used before PTY profile detection.
 *--------------------------------------------------------------------------------------------*/

import { hasKey, isObject, isString } from '../../../../base/common/types.js';
import { ITerminalProfileObject, ITerminalUnsafePath } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';

/**
 * Profile detection validates executable paths, so configured variables must be resolved before
 * the profiles cross the PTY boundary. Only `path` carries variables in upstream profile semantics.
 */
export async function resolveTerminalProfilePaths(profiles: unknown, workspaceFolder: IWorkspaceFolder | undefined,
	resolver: IConfigurationResolverService): Promise<unknown> {
	if (!isObject(profiles)) { return profiles; }
	const resolve = async (path: string | ITerminalUnsafePath): Promise<string | ITerminalUnsafePath> => isString(path)
		? resolver.resolveAsync(workspaceFolder, path)
		: { ...path, path: await resolver.resolveAsync(workspaceFolder, path.path) };
	const resolved = await Promise.all(Object.entries(profiles as { [name: string]: ITerminalProfileObject })
		.map(async ([name, profile]): Promise<[string, ITerminalProfileObject]> => {
			if (!profile || !hasKey(profile, { path: true })) { return [name, profile]; }
			return [name, { ...profile,
				path: Array.isArray(profile.path) ? await Promise.all(profile.path.map(resolve)) : await resolve(profile.path) }];
		}));
	return Object.fromEntries(resolved);
}
