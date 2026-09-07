import assert from 'node:assert/strict';
import test from 'node:test';

import { ALPHA, COMPACT_CHAIN, createFixture } from './lib/fixture.mjs';
import { explorerRows, selectedRow } from './lib/probes.mjs';
import { themeColourOver } from './lib/theme.mjs';
import { drive, KEYS, unexpectedStderr } from './lib/session.mjs';

test('Explorer C delegates recursive collapse to the upstream view and retains keyboard focus', { timeout: 60_000 }, async () => {
	const fixture = createFixture();
	try {
		const run = await drive(fixture, { cols: 100, rows: 30 }, [
			{ name: 'boot' },
			{ name: 'first-down', keys: KEYS.down },
			{ name: 'second-down', keys: KEYS.down },
			{ name: 'alpha', keys: KEYS.up + KEYS.right },
			{ name: 'nested', keys: KEYS.down.repeat(2) + KEYS.right },
			{ name: 'focused-alpha', keys: KEYS.home + KEYS.down },
			{ name: 'collapsed', keys: 'c' },
			{ name: 'reopened', keys: KEYS.right }
		]);
		const selected = frame => selectedRow(frame, themeColourOver('list.activeSelectionBackground', 'sideBar.background')).text;
		assert.match(selected(run.frames.boot), /\.vscode/);
		assert.match(selected(run.frames['first-down']), /alpha/);
		assert.match(selected(run.frames['second-down']), /beta/);
		const nested = explorerRows(run.frames.nested);
		assert.equal(nested.find(row => row.name === ALPHA.folder)?.open, true);
		assert.equal(nested.find(row => row.name === COMPACT_CHAIN.parent)?.open, true);
		assert.ok(nested.some(row => row.depth > 2), 'nested expansion never displayed grandchildren');
		const collapsed = explorerRows(run.frames.collapsed);
		assert.equal(collapsed.find(row => row.name === ALPHA.folder)?.open, false);
		assert.ok(!collapsed.some(row => row.depth > 1), 'collapse left descendants visible');
		const reopened = explorerRows(run.frames.reopened);
		assert.equal(reopened.find(row => row.name === ALPHA.folder)?.open, true,
			'Right after collapse did not act on the previously focused alpha folder');
		assert.equal(reopened.find(row => row.name === COMPACT_CHAIN.parent)?.open, false,
			'collapse did not recursively collapse the nested src folder');
		assert.deepEqual(run.exit, { code: 0, signal: null });
		assert.equal(unexpectedStderr(run.stderr), '');
	} finally {
		fixture.dispose();
	}
});
