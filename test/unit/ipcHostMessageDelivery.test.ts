import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { HostProcessCloseBoundary, parseHostMessageLine } from '../../src/vs/base/parts/ipc/node/ipc.host.js';

test('host shutdown resolves only after close has followed exit or the forced-kill deadline', async () => {
	const child = new EventEmitter() as EventEmitter & { kill(): boolean };
	let kills = 0; let resolveKilled!: () => void;
	child.kill = () => { kills++; resolveKilled?.(); return true; };

	const graceful = new HostProcessCloseBoundary(child);
	let gracefulSettled = false;
	const gracefulWait = graceful.waitForClose(Promise.resolve(), new Promise(() => { }))
		.then(() => { gracefulSettled = true; });
	assert.equal(child.listenerCount('close'), 1, 'close ownership was registered after shutdown could race it');
	assert.equal(gracefulSettled, false);
	child.emit('close'); await gracefulWait;
	assert.equal(gracefulSettled, true); assert.equal(kills, 0);

	const forcedChild = new EventEmitter() as EventEmitter & { kill(): boolean };
	const killed = new Promise<void>(resolve => { resolveKilled = resolve; });
	forcedChild.kill = child.kill;
	const forced = new HostProcessCloseBoundary(forcedChild);
	let forcedSettled = false;
	const forcedWait = forced.waitForClose(new Promise(() => { }), Promise.resolve())
		.then(() => { forcedSettled = true; });
	await killed;
	assert.equal(kills, 1); assert.equal(forcedSettled, false,
		'forced shutdown resolved at kill instead of waiting for stdio close');
	forcedChild.emit('close'); await forcedWait;
	assert.equal(forcedSettled, true);
});

test('malformed lines are reported and do not displace neighboring records', () => {
	const reports: string[] = [];
	assert.deepEqual(parseHostMessageLine('{"event":"first"}', value => reports.push(value)), { event: 'first' });
	assert.equal(parseHostMessageLine('{not-json', value => reports.push(value)), undefined);
	assert.deepEqual(parseHostMessageLine('{"id":7,"result":"last"}', value => reports.push(value)), { id: 7, result: 'last' });
	assert.equal(reports.length, 1);
	assert.match(reports[0], /unparseable line/);
});
