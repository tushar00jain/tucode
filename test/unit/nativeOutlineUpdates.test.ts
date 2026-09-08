import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeOutlineUpdates } from '../../src/editor/nativeOutlineUpdates.js';

test('large outlines send no rows for input changes and only changed records for results', () => {
	const transport = new NativeOutlineUpdates();
	let rows = Array.from({ length: 20000 }, (_, index) => ({
		id: `match-${index}`, parentId: 'file', focused: false, selected: false,
		render: { runs: [{ text: `needle ${index}`, style: {} }] }
	}));
	assert.equal(transport.capture('search', rows).rows.length, 20000);
	const unchanged = transport.capture('search', rows);
	assert.deepEqual(unchanged.rows, []);
	assert.deepEqual(unchanged.children, []);
	assert.ok(JSON.stringify(unchanged).length < 100, 'input acknowledgements must not resend the result tree');
	rows = rows.map((row, index) => index === 100 ? { ...row, render: { runs: [{ text: 'updated preview', style: {} }] } } : row);
	const changed = transport.capture('search', rows);
	assert.deepEqual(changed.rows.map(row => row.id), ['match-100']);
	assert.deepEqual(changed.children, []);
	rows = rows.filter((_, index) => index !== 101);
	const removed = transport.capture('search', rows);
	assert.deepEqual(removed.removed, ['match-101']);
	assert.deepEqual(removed.children[0].ids, rows.map(row => row.id));
	assert.equal(transport.capture('explorer', rows).reset, true);
	assert.equal(transport.capture('search', rows).rows.length, 19999, 'switching containers establishes a complete baseline');
});

test('reparenting and collapsing send child lists including emptied parents', () => {
	const transport = new NativeOutlineUpdates();
	const row = { id: 'match', parentId: 'old', focused: true, selected: true };
	transport.capture('search', [row]);
	const update = transport.capture('search', [{ ...row, parentId: 'new' }]);
	assert.deepEqual(update.children, [{ parentId: 'old', ids: [] }, { parentId: 'new', ids: ['match'] }]);
	assert.equal(update.focusedId, 'match');
	assert.deepEqual(transport.capture('search', []).children, [{ parentId: 'new', ids: [] }]);
});
