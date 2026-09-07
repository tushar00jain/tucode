import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Wry matches concurrent replies, delivers subscriptions, and rejects after backend failure', async () => {
	const sent: Array<{id: number; cmd: string; args: unknown}> = [];
	Object.defineProperty(globalThis, 'window', { configurable: true, value: {
		ipc: { postMessage: (frame: string) => sent.push(JSON.parse(frame)) }
	} });
	const { invoke, listen } = await import('../../src/vs/base/parts/ipc/wry/ipc.wry.js');
	const receive = (globalThis as unknown as { __tucodeBackendMessage(message: unknown): void }).__tucodeBackendMessage;
	const first = invoke('channel_call', { channel: 'file' });
	const second = invoke('channel_call', { channel: 'search' });
	receive({ id: sent[1].id, result: 'second' });
	receive({ id: sent[0].id, result: 'first' });
	assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
	const values: unknown[] = [];
	const unlisten = await listen('tscode:sub:test', event => values.push(event.payload));
	receive({ event: 'tscode:sub:test', payload: [1] });
	unlisten();
	receive({ event: 'tscode:sub:test', payload: [2] });
	assert.deepEqual(values, [[1]]);
	const error = invoke('channel_call');
	receive({ id: sent.at(-1)!.id, error: 'file error' });
	await assert.rejects(error, value => value === 'file error');
	const waiting = invoke('channel_call');
	assert.throws(() => receive({ fatal: 'backend initialization failed' }), /initialization failed/);
	await assert.rejects(waiting, value => value === 'backend initialization failed');
	await assert.rejects(invoke('channel_call'), value => value === 'backend initialization failed');
	Reflect.deleteProperty(globalThis, 'window');
});
