import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompressibleObjectTreeModel } from '../../src/vs/base/browser/ui/tree/compressedObjectTreeModel.js';
import type { ITreeNode } from '../../src/vs/base/browser/ui/tree/tree.js';

test('upstream compact-folder parent and order survive lazy resolution and collapse', () => {
	interface Item { name: string; parent?: Item }
	const mac: Item = { name: 'mac' };
	const tests: Item = { name: 'Tests', parent: mac };
	const child: Item = { name: 'TucodeMacTests', parent: tests };
	const file: Item = { name: 'Package.swift', parent: mac };
	const tree = new CompressibleObjectTreeModel<Item>('Mac Explorer regression');
	const rows: ITreeNode<Item | null, void>[] = [];
	const listener = tree.onDidSpliceRenderedNodes(event => {
		rows.splice(event.start, event.deleteCount, ...event.elements);
	});
	try {
		tree.setChildren(null, [{ element: mac, incompressible: true, children: [
			{ element: tests, collapsible: true, collapsed: true },
			{ element: file, incompressible: true }
		] }]);
		assert.deepEqual(rows.map(row => row.element), [mac, tests, file]);
		const initialDepth = rows[1].depth;
		// The async Explorer resolves this single directory only after the folder is opened.
		tree.setChildren(tests, [{ element: child, collapsible: true, collapsed: true }]);
		assert.deepEqual(rows.map(row => row.element), [mac, child, file]);
		assert.equal(rows[1].depth, initialDepth);
		assert.equal(tree.getParentNodeLocation(child), mac);
		// Filesystem ancestry is intentionally different from the rendered hierarchy.
		assert.equal(rows.some(row => row.element === child.parent), false);
		tree.setCollapsed(mac, true);
		assert.deepEqual(rows.map(row => row.element), [mac]);
		tree.setCollapsed(mac, false);
		assert.deepEqual(rows.map(row => row.element), [mac, child, file]);
		assert.equal(tree.getParentNodeLocation(child), mac);
		assert.equal(rows[1].depth, initialDepth);
	} finally {
		listener.dispose();
	}
});
