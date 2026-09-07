import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VSBuffer } from '../../src/vs/base/common/buffer.js';
import { extUri } from '../../src/vs/base/common/resources.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { NullLogService } from '../../src/vs/platform/log/common/log.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../src/vs/platform/workspace/common/workspace.js';
import { getWorkspaceIdentifier } from '../../src/vs/platform/workspaces/common/workspaceIdentifier.js';
import { registerMacWorkspaceFolders, resolveMacWorkspace } from '../../src/editor/macWorkspace.js';

test('Mac folder startup retains the registered canonical root', async () => {
	const root = URI.file('/fixture/project');
	const workspace = await resolveMacWorkspace('/fixture/link', undefined, async uri => {
		assert.equal(uri.fsPath, '/fixture/link');
		return root;
	});
	assert.ok(isSingleFolderWorkspaceIdentifier(workspace));
	assert.equal(workspace.uri.toString(), root.toString());
	await registerMacWorkspaceFolders(workspace, {} as never, {} as never, new NullLogService(),
		async () => { assert.fail('single-folder startup already authorized its root'); });
});

test('Mac workspace startup authorizes configuration parent and uses upstream workspace identity', async () => {
	const config = URI.file('/fixture/config/projects.code-workspace');
	const registered: string[] = [];
	const workspace = await resolveMacWorkspace('/unrelated', config.fsPath, async uri => {
		registered.push(uri.fsPath); return uri;
	});
	assert.ok(isWorkspaceIdentifier(workspace));
	assert.equal(workspace.id, getWorkspaceIdentifier(config).id);
	assert.equal(workspace.configPath.toString(), config.toString());
	assert.deepEqual(registered, ['/fixture/config']);
});

test('Mac authorizes all workspace folders through upstream JSONC parsing and URI resolution', async () => {
	const workspace = getWorkspaceIdentifier(URI.file('/fixture/config/projects.code-workspace'));
	const registered: string[] = [];
	await registerMacWorkspaceFolders(workspace, { readFile: async (uri: URI) => {
		assert.equal(uri.toString(), workspace.configPath.toString());
		return { value: VSBuffer.fromString(`{
			// Workspace files allow comments and trailing commas.
			"folders": [{"path":"../repo-a", "name":"A"}, {"uri":"file:///fixture/repo-b"},
				{"path":"../repo-a"}, {"invalid":true}],
			"settings": {"scm.defaultViewMode":"tree"},
		}`) };
	} } as never, { extUri } as never, new NullLogService(), async uri => {
		registered.push(uri.fsPath); return uri;
	});
	assert.deepEqual(registered, ['/fixture/repo-a', '/fixture/repo-b']);
});
