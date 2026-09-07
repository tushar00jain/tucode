import assert from 'node:assert/strict';
import { test } from 'node:test';

import { textCursorRevealRow } from '../../src/tui/editor/projectionFocus.js';
import type { TextProjectionSnapshot } from '../../src/editor/textProjection.js';

type Mount = TextProjectionSnapshot;

function mount(id: string, mode: 'viewer' | 'normal', lineNumber: number, column = 1): Mount {
	return { documentId: id, kind: 'text', mode, primaryCursorView: { lineNumber, column } } as Mount;
}

test('viewer viewport publication preserves independently navigated row focus', () => {
	assert.equal(textCursorRevealRow(mount('file', 'viewer', 6), mount('file', 'viewer', 6)), undefined);
});

test('a new viewer selection and every attached Vim cursor are revealed', () => {
	assert.equal(textCursorRevealRow(mount('file', 'viewer', 6), mount('file', 'viewer', 8)), 7);
	assert.equal(textCursorRevealRow(mount('file', 'normal', 8), mount('file', 'normal', 8)), 7);
	assert.equal(textCursorRevealRow(mount('old', 'viewer', 3), mount('new', 'viewer', 4)), 3);
});
