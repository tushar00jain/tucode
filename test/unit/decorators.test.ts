import assert from 'node:assert/strict';
import { test } from 'node:test';
import { debounce } from '../../src/vs/base/common/decorators.js';

for (const runtime of ['browser', 'node'] as const) {
	test(`debounce cancels the previous ${runtime} timer without changing its handle`, t => {
		const callbacks = new Map<unknown, () => void>();
		const canceled: unknown[] = [];
		let sequence = 0;
		let unreferenced = 0;
		t.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
			const handle = runtime === 'browser' ? ++sequence : { unref() { unreferenced++; } };
			callbacks.set(handle, callback);
			return handle;
		});
		t.mock.method(globalThis, 'clearTimeout', (handle: unknown) => {
			canceled.push(handle);
			callbacks.delete(handle);
		});
		class Probe {
			readonly calls: string[] = [];
			@debounce(5000)
			update(value: string): void { this.calls.push(value); }
		}
		const probe = new Probe();
		probe.update('old');
		const first = [...callbacks.keys()][0];
		probe.update('latest');
		assert.equal(canceled[1], first);
		assert.equal(callbacks.size, 1);
		[...callbacks.values()][0]();
		assert.deepEqual(probe.calls, ['latest']);
		assert.equal(unreferenced, runtime === 'node' ? 2 : 0);
	});
}
