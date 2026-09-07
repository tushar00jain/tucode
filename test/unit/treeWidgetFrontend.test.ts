import assert from 'node:assert/strict';
import test from 'node:test';

import '../../src/vs/base/node/browserGlobals.js';
import { ObjectTree } from '../../src/vs/base/browser/ui/tree/objectTree.js';
import type { ITreeRenderer } from '../../src/vs/base/browser/ui/tree/tree.js';
import { ListService, type WorkbenchListWidget } from '../../src/vs/platform/list/browser/listService.js';
import { TerminalElement } from '../../src/tui/terminal/dom/document.js';

const delegate = {
	getHeight: () => 1,
	getTemplateId: () => 'row'
};

const renderer: ITreeRenderer<string, void, HTMLElement> = {
	templateId: 'row',
	renderTemplate(container) { return container; },
	renderElement(node, _index, container) { container.textContent = node.element; },
	disposeTemplate() { }
};

test('the real VS Code tree widget drives its rendered rows directly', async () => {
	const container = new TerminalElement('div') as unknown as HTMLElement;
	const tree = new ObjectTree<string>('test', container, delegate, [renderer], {
		identityProvider: { getId: element => element }
	});
	const listService = new ListService();
	const registration = listService.register(tree as unknown as WorkbenchListWidget);
	const rows: string[] = [];
	tree.onDidSpliceRenderedNodes(({ start, deleteCount, elements }) => {
		rows.splice(start, deleteCount, ...elements.flatMap(node => node.element === null ? [] : [node.element]));
	});

	tree.layout(20, 80);
	tree.setChildren(null, [
		{ element: 'folder', collapsible: true, collapsed: false, children: [{ element: 'file' }] }
	]);
	tree.setFocus(['folder']);
	tree.setSelection(['folder']);
	tree.collapse('folder');
	await new Promise<void>(resolve => setImmediate(resolve));

	assert.deepEqual(rows, ['folder']);
	assert.equal(container.textContent.includes('folder'), true);

	tree.domFocus();
	assert.equal(listService.lastFocusedList, tree);

	registration.dispose();
	listService.dispose();
	tree.dispose();
});
