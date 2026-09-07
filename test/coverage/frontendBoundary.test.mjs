import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function filesBelow(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? filesBelow(path) : path.endsWith('.ts') ? [path] : [];
	});
}

test('shared editor and input layers never import a frontend implementation', () => {
	for (const directory of ['src/editor', 'src/input']) {
		for (const file of filesBelow(resolve(root, directory))) {
			const source = readFileSync(file, 'utf8');
			assert.doesNotMatch(source, /from\s+['"][^'"]*(?:\/tui\/|\/native\/|\/mac\/)/,
				relative(root, file));
		}
	}
});

test('the TUI supplies cell layout through the shared layout contract', () => {
	const layout = readFileSync(resolve(root, 'src/editor/textLayout.ts'), 'utf8');
	const adapter = readFileSync(resolve(root, 'src/tui/editor/cellTextLayout.ts'), 'utf8');
	const area = readFileSync(resolve(root, 'src/tui/editor/contentEditorPane.ts'), 'utf8');
	assert.match(layout, /interface ITextLayoutBackendFactory/);
	assert.match(adapter, /implements ITextLayoutBackendFactory/);
	assert.match(area, /new CellTextLayoutBackendFactory\(\)/);
	assert.doesNotMatch(layout, /terminal-cell|CellEditorConfiguration|MonospaceLineBreaksComputerFactory/);
});
