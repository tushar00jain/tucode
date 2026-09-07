import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectTerminalCommandDecorations, TerminalEditorProjectionGateway, terminalEditorSnapshot } from '../../src/terminal/terminalProjection.js';

const snapshot = (generation: number) => terminalEditorSnapshot({ kind: 'terminal', generation, terminalId: 'terminal:1', title: 'shell',
	columns: 80, rows: 24, focused: true, exited: false, exitCode: undefined, alternateBufferActive: false,
	cursor: { column: 2, row: 1 },
	content: [{ id: 'terminal:1:row:1', wrapped: false, runs: [{ text: '$ ', cells: 2, foreground: '#ffffff' }] }],
	commandDecorations: [],
	find: { visible: false, query: '', resultIndex: -1, resultCount: 0, decorations: [] },
	logicalText: '$ ', cursorOffset: 2, selection: { location: 2, length: 0 }, scrollTop: 0, status: undefined });

test('terminal editor projection is immutable and generation-addressed', () => {
	const events: unknown[] = [];
	const gateway = new TerminalEditorProjectionGateway(snapshot(1), event => { events.push(event); });
	assert.equal(gateway.dispatch({ kind: 'key', sequence: 'a', terminalId: 'terminal:1', generation: 1 }), true);
	assert.equal(gateway.publish(snapshot(2)), true);
	assert.equal(gateway.dispatch({ kind: 'paste', text: 'stale', terminalId: 'terminal:1', generation: 1 }), false);
	assert.ok(Object.isFrozen(gateway.snapshot) && Object.isFrozen(gateway.snapshot.content[0].runs));
	assert.equal(gateway.snapshot.status, undefined, 'healthy terminal projected generic status chrome');
	assert.equal(events.length, 1);
	gateway.dispose();
});

test('terminal find state is immutable, validated and dispatched through the generation boundary', () => {
	const events: unknown[] = [];
	const gateway = new TerminalEditorProjectionGateway(snapshot(1), event => { events.push(event); });
	assert.equal(gateway.dispatch({ kind: 'find', action: 'query', query: 'needle', terminalId: 'terminal:1', generation: 1 }), true);
	const found = terminalEditorSnapshot({ ...snapshot(2), find: { visible: true, query: 'needle', resultIndex: 0, resultCount: 2,
		decorations: [{ id: 1, row: 1, column: 3, width: 6, active: true }] } });
	assert.equal(gateway.publish(found), true);
	assert.ok(Object.isFrozen(gateway.snapshot.find) && Object.isFrozen(gateway.snapshot.find.decorations[0]));
	assert.deepEqual(events, [{ kind: 'find', action: 'query', query: 'needle', terminalId: 'terminal:1', generation: 1 }]);
	assert.throws(() => terminalEditorSnapshot({ ...found, generation: 3, find: { ...found.find, resultIndex: 2 } }), /invalid terminal find state/);
	gateway.dispose();
});

test('terminal page-scroll intent remains shared, generation-addressed and distinct from PTY keys', () => {
	const events: unknown[] = [];
	const gateway = new TerminalEditorProjectionGateway(snapshot(1), event => { events.push(event); });
	assert.equal(gateway.dispatch({ kind: 'scroll-page', pages: -1, terminalId: 'terminal:1', generation: 1 }), true);
	assert.deepEqual(events, [{ kind: 'scroll-page', pages: -1, terminalId: 'terminal:1', generation: 1 }]);
	assert.equal(gateway.publish({ ...snapshot(2), alternateBufferActive: true }), true);
	assert.equal(gateway.snapshot.alternateBufferActive, true);
	assert.equal(gateway.dispatch({ kind: 'scroll-page', pages: 1, terminalId: 'terminal:1', generation: 1 }), false);
	gateway.dispose();
});

test('completed shell commands project immutable visible success and error gutter records', () => {
	const projected = projectTerminalCommandDecorations([
		{ marker: { id: 1, line: 9 }, command: 'before', exitCode: 0 },
		{ marker: { id: 2, line: 10 }, command: 'true', exitCode: 0 },
		{ marker: { id: 3, line: 11 }, command: 'false', exitCode: 1 },
		{ marker: { id: 4, line: 12 }, command: 'running' }
	], 10, 2);
	assert.deepEqual(projected, [
		{ id: 2, row: 0, command: 'true', outcome: 'success' },
		{ id: 3, row: 1, command: 'false', outcome: 'error' }
	]);
	assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected[0]));
});
