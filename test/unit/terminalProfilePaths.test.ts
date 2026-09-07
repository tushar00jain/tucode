import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTerminalProfilePaths } from '../../src/vs/workbench/contrib/terminal/common/terminalProfilePaths.js';

describe('terminal profile path resolution', () => {
	it('resolves configured executable path variables before PTY detection without changing profile semantics', async () => {
		const calls: unknown[] = [];
		const resolver = {
			resolveAsync: async (_folder: unknown, value: unknown) => {
				calls.push(value);
				return typeof value === 'string' ? value.replace('${env:SHELL}', '/fixture/terminal') : value;
			}
		} as any;
		const configured = {
			'TERM-VARIABLE-PATH-PROFILE': { path: '${env:SHELL}', args: ['--profile'], env: { MARKER: 'yes' } },
			unsafe: { path: { path: '${env:SHELL}', isUnsafe: true } },
			disabled: null
		};
		const resolved = await resolveTerminalProfilePaths(configured, undefined, resolver) as any;
		assert.deepEqual(calls, ['${env:SHELL}', '${env:SHELL}']);
		assert.equal(resolved['TERM-VARIABLE-PATH-PROFILE'].path, '/fixture/terminal');
		assert.deepEqual(resolved['TERM-VARIABLE-PATH-PROFILE'].args, ['--profile']);
		assert.deepEqual(resolved['TERM-VARIABLE-PATH-PROFILE'].env, { MARKER: 'yes' });
		assert.deepEqual(resolved.unsafe.path, { path: '/fixture/terminal', isUnsafe: true });
		assert.equal(resolved.disabled, null);
		assert.equal(configured['TERM-VARIABLE-PATH-PROFILE'].path, '${env:SHELL}');
	});
});
