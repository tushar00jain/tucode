import assert from 'node:assert/strict';
import { test } from 'node:test';
import xtermHeadless from '@xterm/headless';
import { NullLogService } from '../../src/vs/platform/log/common/log.js';
import { TerminalCapability } from '../../src/vs/platform/terminal/common/capabilities/capabilities.js';
import { ShellIntegrationAddon } from '../../src/vs/platform/terminal/common/xterm/shellIntegrationAddon.js';
import { projectTerminalCommandDecorations } from '../../src/terminal/terminalProjection.js';

function write(terminal: xtermHeadless.Terminal, data: string): Promise<void> {
	return new Promise(resolve => terminal.write(data, resolve));
}

test('upstream shell-integration OSC completion becomes a shared command outcome record', async () => {
	const terminal = new xtermHeadless.Terminal({ cols: 80, rows: 8, allowProposedApi: true });
	const addon = new ShellIntegrationAddon('nonce', true, undefined, undefined, new NullLogService());
	terminal.loadAddon(addon);
	try {
		const osc = (value: string) => `\x1b]633;${value}\x07`;
		await write(terminal, `${osc('A')}$ ${osc('B')}${osc('E;printf test;nonce')}printf test${osc('C')}\r\ntest\r\n${osc('D;0')}`);
		const commands = addon.capabilities.get(TerminalCapability.CommandDetection)?.commands ?? [];
		assert.equal(commands.length, 1);
		assert.equal(commands[0].command, 'printf test');
		assert.equal(commands[0].exitCode, 0);
		assert.ok(commands[0].marker);
		assert.deepEqual(projectTerminalCommandDecorations([{
			marker: commands[0].marker!, command: commands[0].command, exitCode: commands[0].exitCode
		}], terminal.buffer.active.viewportY, terminal.rows), [{
			id: commands[0].marker!.id, row: commands[0].marker!.line - terminal.buffer.active.viewportY,
			command: 'printf test', outcome: 'success'
		}]);
	} finally {
		addon.dispose();
		terminal.dispose();
	}
});
