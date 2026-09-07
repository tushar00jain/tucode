import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { AsyncDataTree } from '../../src/vs/base/browser/ui/tree/asyncDataTree.js';
import { TreeVisibility } from '../../src/vs/base/browser/ui/tree/tree.js';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { ViewRootController, type IViewRootBox } from '../../src/vs/workbench/browser/tauri/viewRootController.js';

class RootProbe extends ViewRootController<string> {
	readonly state: IViewRootBox;
	readonly gate = new DeferredPromise<void>();
	applied = '';
	committed: string | undefined;
	canceled = false;
	private readonly tail: { work: Promise<void> };
	constructor() {
		const state = { isOpen: false, height: 0, value: '',
			open(value: string) { this.isOpen = true; this.value = value; },
			close() { this.isOpen = false; return true; }, dispose() {} };
		const tail = { work: Promise.resolve() };
		super(() => state, work => { tail.work = tail.work.then(work); });
		this.state = state;
		this.tail = tail;
	}
	settled(): Promise<void> { return this.tail.work; }
	protected opening(): string { return ''; }
	protected relayout(): void {}
	protected async applyQuery(query: string): Promise<void> {
		if (!this.state.isOpen) { return; }
		await this.gate.p;
		this.applied = query;
	}
	protected async commitRoot(): Promise<void> { this.committed = this.applied; }
	protected async cancelRoot(): Promise<void> { this.canceled = true; }
	protected get rows(): string[] { return []; }
	protected name(row: string): string { return row; }
	protected get tree() { return undefined; }
}

test('rapid Enter commits the final queued view-root query', async () => {
	const root = new RootProbe();
	try {
		root.open();
		root.apply('alpha/zone/');
		root.apply('alpha/zone/note');
		root.commit();
		await root.gate.complete();
		await root.settled();
		assert.equal(root.committed, 'alpha/zone/note');
		assert.equal(root.state.isOpen, false);
	} finally { root.dispose(); }
});

test('Escape closes immediately while a view-root query is pending', async () => {
	const root = new RootProbe();
	try {
		root.open();
		root.apply('alpha/zone/');
		root.cancel();
		assert.equal(root.state.isOpen, false);
		await root.gate.complete();
		await root.settled();
		assert.equal(root.canceled, true);
		assert.equal(root.committed, undefined);
	} finally { root.dispose(); }
});

test('AsyncDataTree retains custom filter payload when stock find is explicitly disabled', async () => {
	const score = { match: 'custom-ranking' };
	const child = { name: 'note.txt' };
	const tree = new AsyncDataTree<string, typeof child, typeof score>('filter regression', document.createElement('div'),
		{ getHeight: () => 22, getTemplateId: () => 'row' },
		[{ templateId: 'row', renderTemplate: () => ({}), renderElement() {}, disposeTemplate() {} }],
		{ hasChildren: element => element === 'root', getChildren: () => [child] },
		{ findWidgetEnabled: false, keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.name },
			filter: { filter: () => ({ visibility: TreeVisibility.Visible, data: score }) } });
	try {
		await tree.setInput('root');
		assert.equal(tree.getNode(child).filterData, score);
		// Let the tree's child refresh cleanup finish before disposing its cancellation owners.
		await new Promise<void>(resolve => setImmediate(resolve));
	} finally { tree.dispose(); }
});
