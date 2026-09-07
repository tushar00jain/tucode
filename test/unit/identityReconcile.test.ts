import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcileIdentities } from '../../src/workbench/identityReconcile.js';

function apply(previous: readonly string[], operations: ReturnType<typeof reconcileIdentities>, next: readonly string[]): string[] {
	const value = [...previous];
	for (const operation of operations) {
		if (operation.kind === 'remove') value.splice(operation.index, 1);
		else if (operation.kind === 'insert') value.splice(operation.index, 0, next[operation.index]);
		else value.splice(operation.to, 0, value.splice(operation.from, 1)[0]);
	}
	return value;
}

describe('identity-keyed projection reconciliation', () => {
	for (const [previous, next] of [
		[[], ['a', 'b']],
		[['a', 'b'], []],
		[['a', 'b', 'c'], ['c', 'a', 'b']],
		[['a', 'b', 'c'], ['b', 'd', 'a']],
		[['a', 'b'], ['a', 'b']]
	] as const) {
		it(`${previous.join('')} -> ${next.join('')}`, () => {
			const operations = reconcileIdentities(previous, next);
			assert.deepEqual(apply(previous, operations, next), [...next]);
		});
	}

	it('rejects duplicate identities rather than reconciling ambiguously', () => {
		assert.throws(() => reconcileIdentities(['a'], ['a', 'a']), /unique/);
	});
});
