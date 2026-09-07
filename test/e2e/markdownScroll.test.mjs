import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from './lib/fixture.mjs';
import { drive, KEYS, wheelDown, unexpectedStderr } from './lib/session.mjs';
import { activeTab, editorRows, editorLines, editorTabs } from './lib/probes.mjs';
import { themeColour, themeColourOver } from './lib/theme.mjs';

test('cold fenced Markdown paints on completion without another input event', { timeout: 30_000 }, async () => {
	const fixture = createFixture();
	try {
		const run = await drive(fixture, { cols: 100, rows: 30 }, [
			{ name: 'boot' }, { name: 'quickOpen', keys: KEYS.ctrlP },
			{ name: 'query', keys: 'README.md' }, { name: 'source', keys: KEYS.enter },
			{ name: 'cold-preview', keys: 'p' }, { name: 'source-again', keys: 'p' },
			{ name: 'warm-preview', keys: 'p' }
		]);
		for (const name of ['cold-preview', 'warm-preview']) {
			const rows = editorRows(run.frames[name]);
			assert.ok(rows.some(row => row.includes('Preview fixture')), `${name} did not paint its heading`);
			assert.ok(rows.some(row => row.includes('const answer: number = 42;')), `${name} did not paint its fence`);
		}
		assert.equal(unexpectedStderr(run.stderr), '');
		assert.deepEqual(run.exit, { code: 0, signal: null });
	} finally { fixture.dispose(); }
});

test('native Markdown preview retains wheel and keyboard scrolling across repaints', { timeout: 30_000 }, async () => {
	const fixture = createFixture();
	try {
		writeFileSync(join(fixture.root, 'README.md'), Array.from({ length: 120 }, (_value, index) => `Paragraph ${index + 1}.\n`).join('\n'));
		const run = await drive(fixture, { cols: 100, rows: 30 }, [
			{ name: 'boot' }, { name: 'quickOpen', keys: KEYS.ctrlP },
			{ name: 'query', keys: 'README.md' }, { name: 'source', keys: KEYS.enter },
			{ name: 'preview', keys: 'p' }, { name: 'wheel', keys: wheelDown(90, 10).repeat(8) },
			{ name: 'repaint' }, { name: 'arrow', keys: KEYS.down }, { name: 'arrow-repaint' },
			{ name: 'up', keys: KEYS.up }, { name: 'down-two', keys: KEYS.down.repeat(2) },
			{ name: 'page-down', keys: KEYS.pageDown }, { name: 'page-down-two', keys: KEYS.pageDown },
			{ name: 'page-up', keys: KEYS.pageUp }, { name: 'page-up-two', keys: KEYS.pageUp }
		]);
		const first = frame => Number(editorRows(frame).map(row => /Paragraph (\d+)\./.exec(row)?.[1]).find(Boolean));
		assert.equal(first(run.frames.preview), 1);
		assert.ok(first(run.frames.wheel) > 1, 'wheel advances the actual rendered document');
		assert.equal(first(run.frames.repaint), first(run.frames.wheel), 'native paint retains scroll position');
		// Native Pane wheels move the viewport, not keyboard focus. Down reveals row 1 after
		// the wheel moved row 0 offscreen; blank paragraph separators are real rendered rows.
		const focusedRow = frame => {
			const rows = editorLines(frame).slice(1);
			const paragraphRow = rows.findIndex(row => /Paragraph (\d+)\./.test(row.text));
			const paragraph = Number(/Paragraph (\d+)\./.exec(rows[paragraphRow].text)[1]);
			const selected = rows.findIndex(row => row.cells.at(-1).bg === themeColourOver('list.activeSelectionBackground', 'editor.background'));
			assert.notEqual(selected, -1, `the native keyboard row must be visible and highlighted: ${JSON.stringify(rows.slice(0, 4).map(row => [row.text, row.cells[0].bg, row.cells.at(-1).bg]))}`);
			return (paragraph - 1) * 2 - paragraphRow + selected;
		};
		assert.equal(focusedRow(run.frames.preview), 0);
		assert.equal(focusedRow(run.frames.arrow), 1, 'Down reaches the next native row and reveals it after wheel scrolling');
		assert.equal(first(run.frames.arrow), 2, 'revealing the blank row after paragraph 1 puts paragraph 2 first');
		assert.equal(first(run.frames['arrow-repaint']), first(run.frames.arrow), 'arrow scrolling survives another paint');
		assert.equal(focusedRow(run.frames['arrow-repaint']), 1);
		assert.equal(focusedRow(run.frames.up), 0, 'Up routes back through native row navigation');
		assert.equal(focusedRow(run.frames['down-two']), 2);
		const page = editorLines(run.frames.preview).length - 2;
		assert.equal(focusedRow(run.frames['page-down']), 2 + page);
		assert.equal(focusedRow(run.frames['page-down-two']), 2 + 2 * page);
		assert.ok(first(run.frames['page-down-two']) > first(run.frames['page-down']), 'PageDown reveals the next page of actual content');
		assert.equal(focusedRow(run.frames['page-up']), 2 + page);
		assert.equal(focusedRow(run.frames['page-up-two']), 2);
		assert.ok(first(run.frames['page-up-two']) < first(run.frames['page-down-two']), 'PageUp reveals earlier content');
		assert.equal(unexpectedStderr(run.stderr), '');
		assert.deepEqual(run.exit, { code: 0, signal: null });
	} finally { fixture.dispose(); }
});

test('P toggles source and current-group preview while explicit side preview stays separate', { timeout: 30_000 }, async () => {
	const fixture = createFixture();
	try {
		writeFileSync(join(fixture.root, 'first.txt'), 'first file\n');
		writeFileSync(join(fixture.root, 'second.txt'), 'second file\n');
		const settings = join(fixture.root, '.vscode/settings.json');
		writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), 'workbench.editor.enablePreview': false }));
		const run = await drive(fixture, { cols: 180, rows: 40 }, [
			{ name: 'boot' }, { name: 'open-first', keys: KEYS.ctrlP }, { name: 'find-first', keys: 'first.txt' }, { name: 'first', keys: KEYS.enter },
			{ name: 'open-second', keys: KEYS.ctrlP }, { name: 'find-second', keys: 'second.txt' }, { name: 'second', keys: KEYS.enter },
			{ name: 'open-source', keys: KEYS.ctrlP }, { name: 'find-source', keys: 'README.md' }, { name: 'source', keys: KEYS.enter },
			{ name: 'preview', keys: 'p' }, { name: 'source-again', keys: 'p' },
			{ name: 'preview-again', keys: 'p' }, { name: 'source-third', keys: 'p' },
			{ name: 'preview-third', keys: 'p' }, { name: 'source-fourth', keys: 'p' },
			{ name: 'side-preview', keys: '\x0b' + 'v' }, { name: 'side-closed', keys: KEYS.ctrlW }
		]);
		const names = frame => editorTabs(frame).map(tab => tab.name);
		const sourceNames = ['first.txt', 'second.txt', 'README.md'];
		const previewNames = [...sourceNames, 'Preview README.md'];
		assert.deepEqual(names(run.frames.source), sourceNames);
		for (const name of ['preview', 'preview-again', 'preview-third']) {
			assert.deepEqual(names(run.frames[name]), previewNames, 'regular P preserves all tabs in the current strip without duplicates');
			assert.equal(activeTab(run.frames[name], themeColour('tab.activeBackground'))?.name, 'Preview README.md');
		}
		for (const name of ['source-again', 'source-third', 'source-fourth']) {
			assert.deepEqual(names(run.frames[name]), previewNames);
			assert.equal(activeTab(run.frames[name], themeColour('tab.activeBackground'))?.name, 'README.md', 'preview-context P returns directly to source');
			assert.deepEqual(editorRows(run.frames[name]), editorRows(run.frames.source), 'source content and viewport survive toggles');
		}
		assert.deepEqual(names(run.frames['side-preview']), ['Preview README.md'], 'explicit side command targets a separate group');
		assert.deepEqual(names(run.frames['side-closed']), previewNames, 'closing the side group restores the full original tab strip');
		assert.equal(unexpectedStderr(run.stderr), '');
		assert.deepEqual(run.exit, { code: 0, signal: null });
	} finally { fixture.dispose(); }
});
