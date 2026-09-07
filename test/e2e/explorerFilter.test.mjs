import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, ALPHA, COMPACT_CHAIN, TOP_LEVEL } from './lib/fixture.mjs';
import { explorerRows, paneTextLines } from './lib/probes.mjs';
import { drive, KEYS, unexpectedStderr } from './lib/session.mjs';

test('Explorer slash drives the actual view with path rooting, completion and restoration', { timeout: 60000 }, async () => {
	const fixture = createFixture({ sapling: false });
	try {
		const run = await drive(fixture, { cols: 220, rows: 65 }, [
			{ name: 'boot' },
			{ name: 'filter', keys: '/' },
			{ name: 'ranked', keys: 'ta' },
			{ name: 'first', keys: KEYS.tab },
			{ name: 'previous', keys: KEYS.shiftTab },
			{ name: 'cancel', keys: KEYS.escape },
			{ name: 'rootFilter', keys: '/' },
			{ name: 'alpha', keys: `alpha${KEYS.enter}` },
			{ name: 'reopen', keys: '/' },
			{ name: 'untouched', keys: KEYS.enter },
			{ name: 'nestedFilter', keys: '/' },
			{ name: 'nested', keys: 'src/' },
			{ name: 'nestedCancel', keys: KEYS.escape },
			{ name: 'fileFilter', keys: '/' },
			{ name: 'file', keys: `tracked${KEYS.enter}` },
			{ name: 'topFilter', keys: '/' },
			{ name: 'top', keys: `${KEYS.ctrlU}${KEYS.enter}` },
			{ name: 'collapse', keys: 'c' },
			{ name: 'down', keys: KEYS.down }
		]);
		assert.deepEqual(run.exit, { code: 0, signal: null });
		assert.equal(unexpectedStderr(run.stderr), '');
		assert.deepEqual(explorerRows(run.frames.boot).map(row => row.name).sort(), [...TOP_LEVEL].sort(), 'untouched Explorer must not gain filter chrome');
		const names = name => {
			const frame = run.frames[name];
			const inputRow = paneTextLines(frame).findIndex(line => line.includes('▏'));
			return explorerRows(frame, { skip: inputRow + 1 }).map(row => row.name);
		};
		assert.deepEqual(names('ranked'), ['beta', 'delta']);
		assert.deepEqual(names('first'), names('ranked'));
		assert.deepEqual(names('previous'), names('ranked'));
		assert.deepEqual(names('cancel'), names('boot'));
		assert.ok(paneTextLines(run.frames.first).some(line => line.includes('beta') && !line.includes('workspace/')));
		assert.ok(paneTextLines(run.frames.previous).some(line => line.includes('delta') && !line.includes('workspace/')));
		assert.ok(ALPHA.files.every(file => names('alpha').includes(file)));
		assert.ok(paneTextLines(run.frames.reopen).find(line => line.includes('▏')).includes('alpha/'), 'reopening preserves the entered path');
		assert.deepEqual(names('untouched'), names('alpha'));
		assert.ok(names('nested').includes('nested'));
		assert.ok(!names('nested').includes(COMPACT_CHAIN.row), 'filtered tree must be uncompressed');
		assert.deepEqual(names('nestedCancel'), names('alpha'));
		assert.ok(names('file').includes('tracked.txt'));
		assert.ok(TOP_LEVEL.every(name => names('top').includes(name)));
	} finally { fixture.dispose(); }
});
