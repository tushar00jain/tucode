import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
test('TUI flat-list adapters import the neutral protocol implementation', () => {
	const expected = new Map([
		['src/tui/views/scmHistoryPane.ts', '../../workbench/flatListProjection.js']
	]);
	for (const [path, specifier] of expected) {
		const source = readFileSync(resolve(root, path), 'utf8');
		assert.match(source, new RegExp(`from ['"]${specifier.replaceAll('.', '\\.') }['"]`));
		assert.doesNotMatch(source, /tui\/workbench\/flatListProjection/);
	}
	assert.equal(readdirSync(resolve(root, 'src/tui/workbench')).includes('flatListProjection.ts'), false);
});

test('the TUI paints upstream editor groups and mounts content through upstream panes', () => {
	const tui = readFileSync(resolve(root, 'src/tui/editor/editorArea.ts'), 'utf8');
	const content = readFileSync(resolve(root, 'src/tui/editor/contentEditorPane.ts'), 'utf8');
	assert.match(tui, /IEditorGroupsService/);
	assert.match(tui, /this\.groups\.activeGroup\.closeEditor\(\)/);
	assert.match(tui, /this\.editorService\.openEditor/);
	assert.match(content, /extends EditorPane/);
	assert.doesNotMatch(tui, /EditorAreaController|makeSnapshot|activeByGroup|onDidSemanticGroupChange/);
	assert.match(content, /EmbeddedRegionTerminalBackend/);
	assert.match(tui, /lineRenderRecords/);
	assert.equal(readdirSync(resolve(root, 'src/editor')).includes('editorAreaProjection.ts'), false);
	assert.equal(readdirSync(resolve(root, 'src/tui/editor')).includes('editorService.ts'), false);
});
