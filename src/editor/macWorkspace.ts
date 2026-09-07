import { dirname } from '../vs/base/common/resources.js';
import { URI } from '../vs/base/common/uri.js';
import { IFileService } from '../vs/platform/files/common/files.js';
import { ILogService } from '../vs/platform/log/common/log.js';
import { IUriIdentityService } from '../vs/platform/uriIdentity/common/uriIdentity.js';
import { IAnyWorkspaceIdentifier, isWorkspaceIdentifier } from '../vs/platform/workspace/common/workspace.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../vs/platform/workspaces/common/workspaceIdentifier.js';
import { isStoredWorkspaceFolder, toWorkspaceFolders } from '../vs/platform/workspaces/common/workspaces.js';
import { WorkspaceConfigurationModelParser } from '../vs/workbench/services/configuration/common/configurationModels.js';

type RegisterRoot = (root: URI) => Promise<URI>;

export async function resolveMacWorkspace(folder: string, workspaceFile: string | undefined, register: RegisterRoot): Promise<IAnyWorkspaceIdentifier> {
	if (workspaceFile) {
		const configPath = URI.file(workspaceFile);
		await register(dirname(configPath));
		return getWorkspaceIdentifier(configPath);
	}
	return getSingleFolderWorkspaceIdentifier(await register(URI.file(folder)));
}

/** Authorize local roots before WorkspaceService reads folder settings; it still owns workspace state. */
export async function registerMacWorkspaceFolders(workspace: IAnyWorkspaceIdentifier, files: IFileService,
	identity: IUriIdentityService, log: ILogService, register: RegisterRoot): Promise<void> {
	if (!isWorkspaceIdentifier(workspace)) { return; }
	const parser = new WorkspaceConfigurationModelParser(workspace.configPath.toString(), log);
	parser.parse((await files.readFile(workspace.configPath)).value.toString());
	for (const folder of toWorkspaceFolders(parser.folders.filter(isStoredWorkspaceFolder), workspace.configPath, identity.extUri)) {
		if (folder.uri.scheme !== 'file') { throw new Error('Mac workspaces currently support local folders only'); }
		await register(folder.uri);
	}
}
