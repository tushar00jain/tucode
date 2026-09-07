import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Script } from 'node:vm';
import { reportDOM } from './reportDom.js';
// @ts-ignore — repository report tools are plain Node modules.
import { selectFiles, fileTree, renderReport, unpackReport } from '../../docs/provenance/report.mjs';
// @ts-ignore — repository report tools are plain Node modules.
import { totals } from '../../docs/provenance/classify.mjs';

const files = [
	{ path: 'mac/App.swift', previousPath: null, status: 'added', binary: false, unchanged: 0, added: 0, removed: 0, newLines: 30, current: 30, baseline: 0 },
	{ path: 'src/shared.ts', previousPath: 'src/original.ts', status: 'renamed', binary: false, unchanged: 95, added: 5, removed: 5, newLines: 0, current: 100, baseline: 100 },
	{ path: 'src/tui/view.ts', previousPath: null, status: 'modified', binary: false, unchanged: 50, added: 2, removed: 1, newLines: 0, current: 52, baseline: 51 },
];

it('uses the same matching files for summary totals and every directory total', () => {
	for (const [query, status] of [['', 'all'], ['src/', 'all'], ['', 'added'], ['original', 'renamed'], ['absent', 'all']]) {
		const selected = selectFiles(files, query, status);
		const root = fileTree(selected);
		assert.deepEqual(root.totals, totals(selected));
		assert.equal(root.totals.current, root.totals.unchanged + root.totals.added + root.totals.newLines);
		assert.equal(root.totals.baseline, root.totals.unchanged + root.totals.removed);
	}
	assert.deepEqual(fileTree(files).dirs.get('src').totals, totals(files.slice(1)));
	assert.deepEqual(selectFiles(files, 'original', 'renamed'), [files[1]]);
	assert.equal(fileTree(files).totals.files, 3);
});

it('generates a complete standalone report, escapes dataset contents and emits valid JavaScript', () => {
	const data = { version: 2, baseline: { ref: '<baseline>', commit: '0123456789' }, renameThreshold: 50, exclusions: [],
		files: [...files, { ...files[0], path: 'src/</script><script>alert(1)</script>.ts' }], totals: totals(files) };
	const html = renderReport(data);
	assert.ok(html.startsWith('<!doctype html>'));
	assert.ok(html.includes('<meta charset="utf-8">'));
	assert.ok(html.includes('&lt;baseline&gt;'));
	assert.ok(!html.includes('<script>alert(1)</script>'));
	const embedded = html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)![1];
	assert.deepEqual(unpackReport(JSON.parse(embedded)), data);
	const scripts = [...html.matchAll(/<script>(.*?)<\/script>/gs)];
	assert.equal(scripts.length, 1);
	assert.doesNotThrow(() => new Script(scripts[0][1]));
	assert.ok(!/hand-written|Where the|not a rewrite/.test(html));
});

it('leaves files in collapsed directories out of the initial DOM', () => {
	const many = Array.from({ length: 5000 }, (_, i) => ({ ...files[0], path: `src/deep/file-${i}.ts` }));
	const report = { baseline: { ref: 'test', commit: 'test' }, renameThreshold: 50, exclusions: [], files: many, totals: totals(many) };
	const html = renderReport(report);
	const { document, created } = reportDOM();
	document.getElementById('data').textContent = html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)![1];
	document.getElementById('status').value = 'all';
	new Script(html.match(/<script>(.*?)<\/script>/s)![1]).runInNewContext({ document });
	assert.ok(created() < 100, `Initial render created ${created()} elements for collapsed files`);
});
