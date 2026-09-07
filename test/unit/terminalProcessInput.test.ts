import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalProcessInputGate } from '../../src/terminal/terminalProcessInput.js';

test('terminal input is delivered in order only after the real process-ready transition', () => {
	const delivered: string[] = [];
	const gate = new TerminalProcessInputGate(data => delivered.push(data));
	assert.equal(gate.write('printf command'), true);
	assert.equal(gate.write('\r'), true);
	assert.deepEqual(delivered, [], 'input leaked before its PTY recipient existed');
	gate.markReady();
	assert.deepEqual(delivered, ['printf command', '\r']);
	assert.equal(gate.write('next'), true);
	assert.deepEqual(delivered, ['printf command', '\r', 'next']);
	gate.close();
	assert.equal(gate.write('late'), false);
	assert.deepEqual(delivered, ['printf command', '\r', 'next']);
});
