import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ITextModel } from '../../src/vs/editor/common/model.js';
import { EditorFindSession } from '../../src/editor/editorFind.js';

test('projected editor find counts, selects, steps, wraps and closes through shared model search', () => {
	const starts = [0, 9, 18];
	const calls: unknown[][] = [];
	const model = {
		findMatches(...args: unknown[]) {
			calls.push(args);
			return starts.map(start => ({ range: {
				getStartPosition: () => ({ lineNumber: 1, column: start + 1 }),
				getEndPosition: () => ({ lineNumber: 1, column: start + 5 })
			} }));
		},
		getOffsetAt(position: { column: number }) { return position.column - 1; }
	} as unknown as ITextModel;
	const selected: { location: number; length: number }[] = [];
	const session = new EditorFindSession(model, {
		primaryCursorOffset: 0,
		selectOffsets: range => selected.push({ ...range })
	});

	session.open();
	assert.deepEqual(session.snapshot, { visible: true, query: '', matchCount: 0, currentMatch: 0 });
	session.setQuery('text');
	assert.deepEqual(session.snapshot, { visible: true, query: 'text', matchCount: 3, currentMatch: 1 });
	assert.deepEqual(selected.at(-1), { location: 0, length: 4 });
	assert.equal(calls.at(-1)?.[0], 'text');
	assert.equal(calls.at(-1)?.[2], false, 'find unexpectedly enabled regex semantics');
	assert.equal(calls.at(-1)?.[3], false, 'find unexpectedly enabled case-sensitive semantics');

	session.next();
	assert.deepEqual(session.snapshot, { visible: true, query: 'text', matchCount: 3, currentMatch: 2 });
	assert.deepEqual(selected.at(-1), { location: 9, length: 4 });
	session.next(); session.next();
	assert.equal(session.snapshot.currentMatch, 1, 'next did not wrap');
	session.previous();
	assert.equal(session.snapshot.currentMatch, 3, 'previous did not wrap');
	session.close();
	assert.deepEqual(session.snapshot, { visible: false, query: 'text', matchCount: 3, currentMatch: 3 });
	assert.equal(Object.isFrozen(session.snapshot), true);
});
