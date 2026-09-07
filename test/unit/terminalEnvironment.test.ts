import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NullLogService } from '../../src/vs/platform/log/common/log.js';
import {
	getShellIntegrationInjection,
	setAppResourceRoot,
	setShellIntegrationWritableRoot,
	shellIntegrationScriptPath
} from '../../src/vs/platform/terminal/tauri/terminalEnvironment.js';

test('zsh shell integration materializes bundled scripts under the registered writable root', async () => {
	setAppResourceRoot('/bundle');
	setShellIntegrationWritableRoot('/registered/user-data');
	const created: string[] = [];
	const calls: Array<{ command: string; arg: unknown }> = [];
	const result = await getShellIntegrationInjection(
		{ executable: '/bin/zsh' },
		{ shellIntegration: { enabled: true, nonce: 'nonce' } } as never,
		undefined,
		new NullLogService(),
		{ applicationName: 'tucode' } as never,
		{
			createFolder: async (resource: { readonly fsPath: string }) => { created.push(resource.fsPath); },
			realpath: async () => { throw new Error('system temporary roots must not be resolved'); }
		} as never,
		{
			call: async (command: string, arg: unknown) => {
				calls.push({ command, arg });
				if (command === 'getEnvironment') {
					return { USER: 'alice', HOME: '/Users/alice', TMPDIR: '/unregistered/tmp' };
				}
				return undefined;
			}
		} as never,
		{
			call: async (command: string, arg: unknown) => { calls.push({ command, arg }); }
		} as never
	);

	assert.equal(result.type, 'injection');
	if (result.type !== 'injection') {
		return;
	}
	const expectedRoot = '/registered/user-data/terminal-shell-integration/alice-tucode-zsh';
	assert.deepEqual(created, [expectedRoot]);
	const chmodArg = calls.find(call => call.command === 'chmod')?.arg;
	assert.ok(Array.isArray(chmodArg));
	assert.equal((chmodArg[0] as { readonly fsPath: string }).fsPath, expectedRoot);
	assert.equal(result.envMixin?.ZDOTDIR, expectedRoot);
	assert.deepEqual(result.filesToCopy?.map(file => file.source), [
		shellIntegrationScriptPath('shellIntegration-rc.zsh', '/bundle'),
		shellIntegrationScriptPath('shellIntegration-profile.zsh', '/bundle'),
		shellIntegrationScriptPath('shellIntegration-env.zsh', '/bundle'),
		shellIntegrationScriptPath('shellIntegration-login.zsh', '/bundle')
	]);
	assert.ok(result.filesToCopy?.every(file => file.source.startsWith('/bundle/out/src/vs/')));
});
