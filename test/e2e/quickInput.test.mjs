import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, QUICK_OPEN_FILE } from './lib/fixture.mjs';
import { drive, KEYS, unexpectedStderr } from './lib/session.mjs';
import { overlayBox, editorTabs } from './lib/probes.mjs';

test('upstream terminal Quick Input paints providers, runs a dialog, and opens a file', { timeout: 60_000 }, async t => {
	const fixture = createFixture();
	t.after(() => fixture.dispose());
	const run = await drive(fixture, { cols: 140, rows: 50 }, [
		{ name: 'boot' },
		{ name: 'palette', keys: KEYS.f1 },
		{ name: 'filtered', keys: 'clear com' },
		{ name: 'dialog', keys: KEYS.enter },
		{ name: 'cancelled', keys: KEYS.escape },
		{ name: 'files', keys: KEYS.ctrlP },
		{ name: 'matched', keys: QUICK_OPEN_FILE.name },
		{ name: 'opened', keys: KEYS.enter }
	]);
	const text = name => overlayBox(run.frames[name])?.rows.map(row => row.text).join('\n') ?? '';
	assert.match(text('filtered'), /Clear Command History/);
	assert.match(text('dialog'), /clear.*history/i);
	assert.equal(overlayBox(run.frames.cancelled), null);
	assert.ok(text('matched').includes(QUICK_OPEN_FILE.name));
	assert.equal(overlayBox(run.frames.opened), null);
	assert.ok(editorTabs(run.frames.opened).some(tab => tab.name === QUICK_OPEN_FILE.name));
	assert.deepEqual(run.exit, { code: 0, signal: null });
	assert.equal(unexpectedStderr(run.stderr), '');
});
