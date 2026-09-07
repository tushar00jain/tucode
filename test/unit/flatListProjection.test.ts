import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FlatListProjectionGateway, flatListProjectionIdentity, flatListSnapshot } from '../../src/workbench/flatListProjection.js';

const rows = (ids: readonly string[] = ['a1', 'b2'], selected = 'a1') => ids.map((hash, order) => ({
	...flatListProjectionIdentity('scm-history', hash), order, accessibleLabel: hash, render: Object.freeze({ text: hash }),
	selected: hash === selected, focused: hash === selected
}));

describe('neutral flat-list projection gateway', () => {
	it('uses stable SCM commit identities and rejects stale input/replacement', () => {
		const events: unknown[] = [];
		const gateway = new FlatListProjectionGateway(flatListSnapshot(1, rows()), event => events.push(event));
		assert.deepEqual(gateway.snapshot.order, ['scm-history-row:a1', 'scm-history-row:b2']);
		assert.equal(Object.isFrozen(gateway.snapshot), true);
		assert.equal(Object.isFrozen(gateway.snapshot.rows.get('scm-history-row:a1')), true);
		assert.equal(gateway.dispatch({ generation: 1, kind: 'select', ids: ['scm-history-row:b2'] }), true);
		assert.equal(gateway.publish(flatListSnapshot(2, rows(['b2', 'c3'], 'c3'))), true);
		assert.equal(gateway.publish(flatListSnapshot(1, rows(['stale']))), false);
		assert.equal(gateway.dispatch({ generation: 1, kind: 'open', id: 'scm-history-row:b2' }), false);
		assert.deepEqual(events, [{ generation: 1, kind: 'select', actionIds: ['scm-history-action:b2'] }]);
		gateway.dispose();
	});

	it('rejects conflated, duplicate and orphan identities', () => {
		assert.throws(() => flatListSnapshot(0, []), /positive safe integer/);
		assert.throws(() => flatListSnapshot(1, [rows()[0], rows()[0]]), /duplicate/);
		assert.throws(() => flatListSnapshot(1, [{ ...rows()[0], actionId: rows()[0].id }]), /conflates/);
		assert.throws(() => flatListSnapshot(1, rows(), new Set(['scm-history-action:a1'])), /orphan/);
	});

	it('keeps repeated reorder/insert/remove publications bounded without retaining history', () => {
		const gateway = new FlatListProjectionGateway(flatListSnapshot(1, rows()), () => {});
		for (let generation = 2; generation <= 21; generation++) {
			const ids = generation % 2 ? ['b2', `c${generation % 20}`] : [`c${generation % 20}`, 'a1', 'b2'];
			assert.equal(gateway.publish(flatListSnapshot(generation, rows(ids))), true);
		}
		assert.equal(gateway.snapshot.generation, 21);
		gateway.dispose();
	});
});
