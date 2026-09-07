import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture } from './lib/fixture.mjs';
import { drive, KEYS } from './lib/session.mjs';
import { editorTabs, statusLine } from './lib/probes.mjs';

test('reopening the same editor after sidebar focus restores upstream pane focus and Vim input', { timeout: 30_000 }, async () => {
	const fixture = createFixture();
	try {
		const run = await drive(fixture, { cols: 180, rows: 45 }, [
			{ name: 'boot' }, { name: 'quickOpen', keys: KEYS.ctrlP },
			{ name: 'query', keys: 'README.md' }, { name: 'opened', keys: KEYS.enter },
			{ name: 'sidebar', keys: '1' }, { name: 'reopen', keys: KEYS.ctrlP },
			{ name: 'requery', keys: 'README.md' }, { name: 'reopened', keys: KEYS.enter },
			{ name: 'vim', keys: 'v' }, { name: 'typed', keys: 'iinput-probe' + KEYS.escape },
			{ name: 'reverted', keys: ':e!' + KEYS.enter }, { name: 'viewer', keys: ':q' + KEYS.enter },
			{ name: 'explorer-reopened', keys: '1' + KEYS.end + KEYS.enter },
			{ name: 'explorer-vim', keys: 'v' },
			{ name: 'explorer-typed', keys: 'iinput-probe' + KEYS.escape },
			{ name: 'explorer-reverted', keys: ':e!' + KEYS.enter }
		]);
		assert.deepEqual(editorTabs(run.frames.reopened).map(tab => tab.name), ['README.md']);
		assert.match(statusLine(run.frames.vim).text, /vim: normal/);
		assert.equal(editorTabs(run.frames.typed).length, 1, 'typing t must reach Vim, not launch a shell');
		assert.match(statusLine(run.frames.typed).text, /vim: normal/);
		assert.doesNotMatch(statusLine(run.frames.viewer).text, /vim:/, ':q must leave the source in viewer mode before testing reopen');
		assert.match(statusLine(run.frames['explorer-vim']).text, /vim: normal/, 'same-batch Explorer reopening must return keyboard ownership to the existing pane');
		assert.equal(editorTabs(run.frames['explorer-typed']).length, 1);
		assert.doesNotMatch(run.stderr, /(?:Error:|\[error\])/);
	} finally { fixture.dispose(); }
});
