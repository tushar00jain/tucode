import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('native runtime does not depend on HTML parsing or browser emulation packages', () => {
	const manifest = JSON.parse(read('package.json'));
	const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
	for (const name of ['jsdom', 'parse5', '@types/jsdom']) {
		assert.equal(dependencies[name], undefined, `${name} is not part of native paint`);
	}
	const lock = JSON.parse(read('package-lock.json'));
	for (const name of Object.keys(lock.packages)) {
		assert.doesNotMatch(name, /node_modules\/(?:jsdom|parse5|@types\/jsdom)$/, name);
	}
});

test('terminal editor content uses native text and diff paint, not browser rendering', () => {
	const source = read('src/tui/editor/editorArea.ts');
	assert.match(source, /renderTextProjectionContent/);
	assert.match(source, /renderDiffProjectionContent/);
	assert.doesNotMatch(source, /paintHtml|paintCodeEditor|TextFileEditor|TextDiffEditor|querySelector/);
});

test('native editor paint, Mac Explorer and native tab transport do not consume DOM output', () => {
	const directory = 'src/tui/editor';
	const painters = readdirSync(resolve(root, directory)).filter(name => /paint/i.test(name) && name.endsWith('.ts'));
	for (const path of [...painters.map(name => `${directory}/${name}`), `${directory}/markdownRows.ts`, `${directory}/markdownRender.ts`, 'src/editor/textRender.ts', 'src/editor/markdownProjection.ts', 'src/editor/nativeEditorTabs.ts', 'src/editor/nativeExplorer.ts']) {
		const source = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
		assert.doesNotMatch(source, /querySelector|MutationObserver|innerHTML|getComputedStyle|resolveStyle|parseFragment/, path);
	}
});

test('the Mac browser editor retains real upstream file, resource and diff panes', () => {
	const source = read('src/macWebMain.ts');
	for (const pane of ['TextFileEditor', 'TextResourceEditor', 'TextDiffEditor']) {
		assert.match(source, new RegExp(`EditorPaneDescriptor\\.create\\(${pane},`));
	}
	assert.doesNotMatch(source, /MacCodeEditorPane/);
});
