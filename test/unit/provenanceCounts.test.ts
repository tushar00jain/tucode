import assert from 'node:assert/strict';
import { it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-ignore — repository report tools are plain Node modules.
import { compareTrees, countLines } from '../../docs/provenance/classify.mjs';
// @ts-ignore — repository report tools are plain Node modules.
import { workingTree } from '../../docs/provenance/tree.mjs';

const tree = (files: Record<string, string | Buffer>) => ({
	list: () => Object.keys(files),
	readBytes: (path: string) => Buffer.from(files[path]),
});
const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join('');

it('counts edited lines, new-file additions and deletions without counting full edited files', () => {
	const original = lines('original', 1000);
	const modified = original.replace(lines('original', 5), lines('replacement', 5));
	const result = compareTrees(tree({ 'src/main.ts': original, 'gone.ts': 'deleted one\ndeleted two\n' }),
		tree({ 'src/main.ts': modified, 'new.ts': lines('new', 100) }));
	assert.deepEqual(result.totals, {
		unchanged: 995, added: 5, removed: 7, newLines: 100, current: 1100, baseline: 1002, files: 3, binary: 0,
	});
	assert.equal(result.files.find((file: { path: string }) => file.path === 'src/main.ts').status, 'modified');
});

it('matches moved files, including moves with edits, and records their original paths once', () => {
	const original = lines('rename candidate with sufficient unique content', 30);
	const result = compareTrees(tree({ 'old/exact.ts': 'exact move\n', 'old/edit.ts': original }),
		tree({ 'new/exact.ts': 'exact move\n', 'new/edit.ts': original.replace('content 12', 'content changed') }));
	assert.equal(result.files.length, 2);
	for (const file of result.files) {
		assert.equal(file.status, 'renamed');
		assert.equal(file.previousPath, file.path.replace('new/', 'old/'));
	}
	assert.equal(result.totals.unchanged, 30);
	assert.equal(result.totals.added, 1);
	assert.equal(result.totals.removed, 1);
	assert.equal(result.totals.newLines, 0);
});

it('does not infer originality for copies at additional paths', () => {
	const result = compareTrees(tree({ 'source.ts': 'retained\n' }), tree({ 'source.ts': 'retained\n', 'copy.ts': 'retained\n' }));
	assert.equal(result.totals.unchanged, 1);
	assert.equal(result.totals.newLines, 1);
	assert.equal(result.files.find((file: { path: string }) => file.path === 'copy.ts').status, 'added');
});

it('compares existing checkouts directly with the same results as a Git snapshot', () => {
	const root = mkdtempSync(join(tmpdir(), 'provenance-local-test-'));
	const before = { '.gitignore': '*.local\n', 'old/move.ts': lines('move', 30), 'same.ts': 'same\n',
		'edited.ts': 'a\r\nb\r\n', 'empty-deleted.ts': '', 'binary': Buffer.from([0, 1]) };
	const after = { '.gitignore': '*.local\n', 'new/move.ts': lines('move', 30).replace('move 12', 'changed'),
		'same.ts': 'same\n', 'edited.ts': 'a\nc\n', 'empty-new.ts': '', 'binary': Buffer.from([0, 2]),
		'tab\tand\n雪.ts': 'added\n' };
	try {
		for (const [side, files] of [['before', before], ['after', after]] as const) {
			const checkout = join(root, side);
			mkdirSync(checkout);
			execFileSync('git', ['init', '-q', checkout]);
			for (const [path, body] of Object.entries(files)) {
				mkdirSync(dirname(join(checkout, path)), { recursive: true });
				writeFileSync(join(checkout, path), body);
			}
			writeFileSync(join(checkout, 'ignored.local'), side.repeat(1000));
		}
		assert.deepEqual(compareTrees(workingTree(join(root, 'before')), workingTree(join(root, 'after'))),
			compareTrees(tree(before), tree(after)));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it('counts physical text lines, normalizes CRLF, and handles binaries, empty files and unusual paths', () => {
	for (const [text, count] of [['', 0], ['a', 1], ['a\n', 1], ['a\n\n', 2]] as const) assert.equal(countLines(text), count);
	const before = { 'line.ts': 'a\r\nb\r\n', 'binary.dat': Buffer.from([0, 1]), 'empty.ts': '' };
	const result = compareTrees(tree(before), tree({ ...before, 'line.ts': 'a\nb\n',
		'binary.dat': Buffer.from([0, 2]), 'tab\tand\n雪.ts': 'one\ntwo', 'icon.svg': '<svg>\n</svg>\n' }));
	assert.equal(result.totals.unchanged, 2);
	assert.equal(result.totals.newLines, 4);
	assert.equal(result.totals.binary, 1);
	assert.equal(result.files.find((file: { path: string }) => file.path === 'binary.dat').status, 'modified');
	assert.equal(result.files.find((file: { path: string }) => file.path === 'line.ts').status, 'unchanged');
});

it('excludes report output, lock files and embedded generated datasets from both sides', () => {
	const result = compareTrees(tree({ 'docs/provenance/provenance.html': 'old report\n', 'package-lock.json': 'old lock\n',
		'docs/keys.html': '<script id="data" type="application/json">old</script>\n' }),
		tree({ 'docs/provenance/provenance.html': 'new report\n', 'package-lock.json': 'new lock\n',
			'docs/keys.html': '<script id="data" type="application/json">new\ndata</script>\n' }));
	assert.equal(result.files.length, 0);
	assert.equal(result.totals.unchanged, 0);
	assert.equal(result.totals.added + result.totals.removed + result.totals.newLines, 0);
});
