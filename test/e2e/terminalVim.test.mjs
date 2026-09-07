// Focused terminal-frontend coverage for the transition into Vim visual mode.

import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALPHA, createFixture } from './lib/fixture.mjs';
import { editorRows, editorTabs, explorerRows, statusLine } from './lib/probes.mjs';
import { drive, KEYS, unexpectedStderr, wheelDown } from './lib/session.mjs';
import { themeColourOver } from './lib/theme.mjs';

const SELECTED_BACKGROUND = themeColourOver('list.activeSelectionBackground', 'sideBar.background');

test('terminal tree activation opens SCM resources and supports Vim visual mode', { timeout: 60_000 }, async () => {
	const fixture = createFixture();
	try {
		// README fits entirely in this window. A long, uniquely numbered source is necessary
		// to distinguish a real viewport scroll from wheel input that painted no change.
		const scrollFile = 'scroll-fixture.ts';
		writeFileSync(join(fixture.root, scrollFile), Array.from({ length: 1200 }, (_, index) =>
			`const line${index + 1} = ${index + 1};`).join('\n'));
		const run = await drive(fixture, { cols: 100, rows: 30 }, [
			{ name: 'boot' },
			{ name: 'focused-alpha', keys: KEYS.down },
			{ name: 'expanded', keys: KEYS.right },
			{ name: 'scm-opened', keys: `3v${KEYS.home}${KEYS.down.repeat(4)}${KEYS.enter}` },
			{ name: 'file', keys: `1${KEYS.end}${KEYS.enter}` },
			{ name: 'scrolled', keys: wheelDown(90, 10).repeat(12) },
			{ name: 'vim', keys: wheelDown(90, 10).repeat(240) + 'v' },
			{ name: 'visual', keys: 'v' },
			{ name: 'visual-line', keys: `${KEYS.escape}V` },
			{ name: 'visual-block', keys: `${KEYS.escape}${KEYS.ctrlV}` }
		]);

		const selected = explorerRows(run.frames.boot)[0];
		const nameStart = selected.column + selected.text.indexOf(selected.name);
		assert.ok(selected.cells.slice(nameStart, nameStart + selected.name.length)
			.every(cell => cell.bg === SELECTED_BACKGROUND), 'the Explorer selection background does not cover its name');
		const expanded = explorerRows(run.frames.expanded);
		assert.equal(expanded.find(row => row.name === ALPHA.folder)?.open, true, 'the expanded folder has no disclosure arrow');
		assert.ok(expanded.some(row => row.depth > 1), 'expanded children have no Explorer indentation');
		assert.ok(editorTabs(run.frames['scm-opened']).some(tab => tab.name.includes('staged.txt')),
			'Enter on an SCM resource did not open its VS Code diff command');
		assert.ok(editorTabs(run.frames.file).some(tab => tab.name === scrollFile));
		const firstLine = frame => Number(editorRows(frame).find(row => /^\s*\d+/.test(row))?.match(/^\s*(\d+)/)?.[1]);
		assert.equal(firstLine(run.frames.file), 1);
		assert.ok(firstLine(run.frames.scrolled) > 1, 'wheel input did not advance the text viewport');
		assert.match(statusLine(run.frames.vim).text, /vim: normal/, 'the key immediately after a wheel burst was delayed or lost');
		assert.ok(run.timings.vim < 250, `wheel burst and following key took ${run.timings.vim}ms`);
		for (const frame of ['visual', 'visual-line', 'visual-block']) {
			assert.match(statusLine(run.frames[frame]).text, /vim: visual/, `${frame} did not enter a visual Vim mode`);
		}
		assert.deepEqual(run.exit, { code: 0, signal: null });
		assert.equal(unexpectedStderr(run.stderr), '');
	} finally {
		fixture.dispose();
	}
});
