import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFixture } from './lib/fixture.mjs';
import { overlayBox, sideBarLines } from './lib/probes.mjs';
import { drive, KEYS, unexpectedStderr } from './lib/session.mjs';

test('context menu settlement includes scheduled discard confirmation and its action', { timeout: 60_000 }, async () => {
	const fixture = createFixture();
	try {
		const run = await drive(fixture, { cols: 140, rows: 50 }, [
			{ name: 'boot' },
			{ name: 'scm', keys: '3v' },
			{ name: 'menu', keys: `${KEYS.home}${KEYS.down.repeat(10)}${KEYS.shiftF10}` },
			{ name: 'prompt', keys: KEYS.down.repeat(3) + KEYS.enter },
			{ name: 'cancelled', keys: KEYS.escape },
			{ name: 'menu-again', keys: KEYS.shiftF10 },
			{ name: 'prompt-again', keys: KEYS.down.repeat(3) + KEYS.enter },
			{ name: 'discarded', keys: KEYS.enter }
		]);
		for (const name of ['menu', 'menu-again']) {
			const box = overlayBox(run.frames[name]);
			assert.ok(box, `${name} did not open on the working-tree resource`);
			assert.ok(box.rows.some(row => row.text.trim() === 'Discard Changes'));
		}
		for (const name of ['prompt', 'prompt-again']) {
			const box = overlayBox(run.frames[name]);
			assert.ok(box, `${name} was acknowledged before the dialog appeared`);
			assert.match(box.rows.map(row => row.text).join('\n'), /discard changes in tracked\.txt/);
		}
		assert.equal(overlayBox(run.frames.cancelled), null);
		assert.ok(sideBarLines(run.frames.cancelled).some(row => row.text.includes('tracked.txt M')));
		assert.equal(overlayBox(run.frames.discarded), null);
		assert.ok(!sideBarLines(run.frames.discarded).some(row => row.text.includes('tracked.txt M')));
		assert.equal(readFileSync(join(fixture.root, 'alpha', 'tracked.txt'), 'utf8'), 'committed contents\n');
		assert.deepEqual(run.exit, { code: 0, signal: null });
		assert.equal(unexpectedStderr(run.stderr), '');
	} finally {
		fixture.dispose();
	}
});
