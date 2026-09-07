import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { NativeExplorer } from '../../src/editor/nativeExplorer.js';
import { ExplorerRootController } from '../../src/vs/workbench/contrib/files/tauri/explorerRootController.js';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { Color } from '../../src/vs/base/common/color.js';
import { createMatches } from '../../src/vs/base/common/filters.js';
import { Event } from '../../src/vs/base/common/event.js';
import { Disposable } from '../../src/vs/base/common/lifecycle.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { WorkbenchState } from '../../src/vs/platform/workspace/common/workspace.js';
import { ExplorerItem } from '../../src/vs/workbench/contrib/files/common/explorerModel.js';
import { FilesFilter, FileSorter } from '../../src/vs/workbench/contrib/files/browser/views/explorerViewer.js';
import { ExplorerDecorationsProvider } from '../../src/vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.js';

function fixture(multiRoot = true) {
	const highlight = Color.fromHex('#e2c08d66');
	const decorationColor = Color.fromHex('#22aa88');
	const config = { onDidChangeConfiguration: Event.None, getValue: (key: string) => key === 'explorer.compactFolders' || key.startsWith('explorer.decorations.') };
	const all: ExplorerItem[] = [];
	const item = (path: string, directory: boolean, parent?: ExplorerItem) => {
		const node = new ExplorerItem(URI.file(path), { hasCapability: () => false } as never, config as never, undefined!, parent, directory);
		if (parent) { parent.addChild(node); }
		node._isDirectoryResolved = true;
		node.fetchChildren = async () => [...node.children.values()];
		all.push(node);
		return node;
	};
	const alpha = item('/fixture/alpha', true);
	const beta = item('/fixture/beta', true);
	const nested = item('/fixture/alpha/nested', true, alpha);
	const deep = item('/fixture/alpha/nested/deep', true, nested);
	const file = item('/fixture/alpha/nested/deep/file.txt', false, deep);
	item('/fixture/alpha/apple.txt', false, alpha);
	item('/fixture/alpha/apricot.txt', false, alpha);
	item('/fixture/beta/beta.txt', false, beta);
	const messages: { type: string; payload: any }[] = [];
	const opened: unknown[] = [];
	const explorer = { roots: multiRoot ? [alpha, beta] : [alpha], registerView() {}, sortOrderConfiguration: {},
		findClosest: (uri: URI) => all.find(item => item.resource.toString() === uri.toString()) };
	const native = new NativeExplorer((type, payload) => messages.push({ type, payload }), {
		createInstance: (ctor: unknown) => {
			if (ctor === FilesFilter) { return { filter: () => true, onDidChange: Event.None, dispose() {} }; }
			if (ctor === FileSorter) { return { compare: (a: ExplorerItem, b: ExplorerItem) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name) }; }
			assert.equal(ctor, ExplorerDecorationsProvider); return { dispose() {} };
		}
	} as never, explorer as never, config as never,
	{ getWorkbenchState: () => multiRoot ? WorkbenchState.WORKSPACE : WorkbenchState.FOLDER } as never,
	{ onDidActiveEditorChange: Event.None, openEditor: async (input: unknown) => { opened.push(input); } } as never,
	{ onDidColorThemeChange: Event.None, getColorTheme: () => ({ getColor: (id: string) => id === 'list.filterMatchBackground' ? highlight : undefined }) } as never,
	{ onDidChangeDecorations: Event.None, registerDecorationsProvider: () => Disposable.None,
		getDecoration: (uri: URI) => uri.path.endsWith('/apple.txt') ? { color: decorationColor, badgeText: 'M', dispose() {} } : undefined } as never,
	{ showNativeMenu: () => assert.fail('filter interaction should not open a menu') } as never,
	{ hasCapability: () => false } as never);
	const snapshot = () => messages.filter(message => message.type === 'navigatorSnapshot').at(-1)!.payload;
	const settle = async () => { await native.refresh(); assert.deepEqual(messages.filter(message => message.type === 'error'), []); };
	const send = (eventType: string, payload = {}) => assert.equal(native.dispatch({ eventType, ...payload }), true);
	return { native, alpha, beta, nested, deep, file, snapshot, settle, send, opened, messages, item, highlight, decorationColor };
}

test('native Explorer uses shared path ranking, completion, commit and exact view restoration', { timeout: 10000 }, async () => {
	const f = fixture();
	try {
		await f.native.start();
		assert.ok(f.native.root instanceof ExplorerRootController);
		f.send('outline-toggle', { id: f.alpha.getId(), expanded: true }); await f.settle();
		f.send('outline-focus', { id: f.beta.getId() });
		const before = f.snapshot().outlineRows.map((row: any) => [row.id, row.parentId, row.expanded]);
		f.send('explorer-filter-open'); await f.settle();
		assert.equal(f.snapshot().filter.value, '');
		f.send('explorer-filter-change', { value: 'alpha/ap', revision: 7 }); await f.settle();
		assert.deepEqual(f.snapshot().outlineRows.map((row: any) => row.render.accessibleLabel), ['apple.txt', 'apricot.txt']);
		f.send('explorer-filter-complete', { direction: 'next' }); await f.settle();
		assert.equal(f.snapshot().filter.value, 'alpha/apple.txt');
		f.send('explorer-filter-complete', { direction: 'previous' }); await f.settle();
		assert.equal(f.snapshot().filter.value, 'alpha/apricot.txt');
		assert.equal(f.snapshot().outlineRows.length, 2, 'completion must not reapply its completed query');
		f.send('explorer-filter-cancel'); await f.settle();
		assert.deepEqual(f.snapshot().outlineRows.map((row: any) => [row.id, row.parentId, row.expanded]), before);
		assert.deepEqual(f.native.getFocus(), [f.beta]);
		assert.equal(f.snapshot().filter.visible, false);
		assert.equal(f.snapshot().filter.revision, 7);

		f.send('explorer-filter-change', { value: 'alpha/nested/' }); await f.settle();
		assert.equal(f.snapshot().outlineRows[0].render.accessibleLabel, 'deep');
		assert.equal(f.snapshot().outlineRows[0].parentId, undefined);
		f.send('explorer-filter-commit'); await f.settle();
		assert.equal(f.snapshot().filter.value, 'alpha/nested/');
		f.send('explorer-filter-open'); await f.settle();
		f.send('explorer-filter-commit'); await f.settle();
		assert.equal(f.snapshot().filter.value, 'alpha/nested/', 'untouched prefill must not descend');
		f.send('explorer-filter-change', { value: 'alpha/nested/deep/file' });
		f.send('explorer-filter-commit'); await f.settle();
		assert.deepEqual(f.native.getFocus(), [f.file], 'nested file commit must settle without queue deadlock');
		assert.equal(f.snapshot().filter.value, 'alpha/nested/deep/');
		f.send('outline-open', { id: f.file.getId() }); await f.settle();
		assert.equal(f.opened.length, 1);
		f.send('explorer-filter-change', { value: 'beta/' }); await f.settle();
		f.send('explorer-filter-cancel', { focused: false }); await f.settle();
		assert.equal(f.snapshot().filter.value, 'alpha/nested/deep/');
		assert.deepEqual(f.native.getFocus(), [f.file]);
		assert.equal(f.snapshot().filter.restoreFocus, false);
		f.send('explorer-filter-change', { value: '' }); f.send('explorer-filter-commit'); await f.settle();
		assert.ok(f.snapshot().outlineRows.some((row: any) => row.id === f.beta.getId()));
	} finally { f.native.dispose(); }
});

test('delayed Explorer query cannot overwrite cancel/reopen, completion or a different surface', { timeout: 10000 }, async () => {
	const f = fixture();
	try {
		await f.native.start();
		f.send('outline-focus', { id: f.beta.getId() });
		f.send('explorer-filter-open'); await f.settle();
		const started = new DeferredPromise<void>();
		const released = new DeferredPromise<void>();
		const original = f.alpha.fetchChildren;
		let delayed = true;
		f.alpha.fetchChildren = async sort => {
			if (delayed) { delayed = false; await started.complete(); await released.p; }
			return original(sort);
		};
		f.send('explorer-filter-change', { value: 'alpha/nested/' });
		await started.p;
		f.send('explorer-filter-complete', { direction: 'next' });
		f.send('explorer-filter-cancel');
		assert.equal(f.native.root.input.isOpen, false, 'Escape closes immediately during fetch');
		f.send('explorer-filter-open');
		assert.equal(f.native.root.input.value, '');
		f.send('explorer-filter-change', { value: 'beta/', revision: 8 });
		await released.complete(); await f.settle();
		assert.equal(f.snapshot().filter.value, 'beta/');
		assert.deepEqual(f.snapshot().outlineRows.map((row: any) => row.render.accessibleLabel), ['beta.txt']);
		f.send('select-container', { id: 'workbench.view.scm' }); await f.settle();
		assert.equal(f.native.dispatch({ eventType: 'explorer-filter-change', value: 'alpha/' }), false);
		f.send('select-container', { id: 'workbench.view.explorer' }); await f.settle();
		assert.equal(f.snapshot().filter.visible, false);
		assert.equal(f.snapshot().filter.value, '');
		assert.deepEqual(f.native.getFocus(), [f.beta]);
	} finally { f.native.dispose(); }
});

test('single-folder Explorer prefill and compact ancestry survive cancel', async () => {
	const f = fixture(false);
	try {
		await f.native.start();
		const compact = f.snapshot().outlineRows.find((row: any) => row.render.accessibleLabel === 'nested/deep');
		assert.ok(compact);
		f.send('outline-toggle', { id: compact.id, expanded: true }); await f.settle();
		const before = f.snapshot().outlineRows.map((row: any) => [row.id, row.parentId, row.expanded]);
		f.send('explorer-filter-open'); await f.settle();
		assert.equal(f.snapshot().filter.value, '');
		assert.ok(f.snapshot().outlineRows.some((row: any) => row.render.accessibleLabel === 'nested'));
		f.send('explorer-filter-change', { value: 'ap' }); await f.settle();
		f.send('explorer-filter-cancel'); await f.settle();
		assert.deepEqual(f.snapshot().outlineRows.map((row: any) => [row.id, row.parentId, row.expanded]), before);
		f.send('explorer-filter-change', { value: 'nested/' }); await f.settle();
		f.send('explorer-filter-commit'); await f.settle();
		assert.equal(f.snapshot().filter.value, 'nested/', 'Enter preserves the selected folder path');
		f.send('explorer-filter-open'); await f.settle();
		assert.equal(f.snapshot().filter.value, 'nested/', 'reopening preserves the path without the workspace prefix');
		f.send('explorer-filter-change', { value: 'nested/deep/' }); await f.settle();
		f.send('explorer-filter-commit'); await f.settle();
		assert.equal(f.snapshot().filter.value, 'nested/deep/');
		f.send('explorer-filter-open'); await f.settle();
		f.send('explorer-filter-change', { value: '' }); await f.settle();
		f.send('explorer-filter-cancel'); await f.settle();
		assert.equal(f.snapshot().filter.value, 'nested/deep/', 'cancel restores the committed path');
	} finally { f.native.dispose(); }
});

test('Explorer cancellation tolerates a removed focused file and disposal during a query', { timeout: 10000 }, async () => {
	const f = fixture(false);
	try {
		await f.native.start();
		f.send('explorer-filter-change', { value: 'nested/deep/file' });
		f.send('explorer-filter-commit'); await f.settle();
		f.send('explorer-filter-open'); await f.settle();
		f.deep.removeChild(f.file);
		f.send('explorer-filter-cancel'); await f.settle();
		assert.deepEqual(f.native.getFocus(), []);
		const started = new DeferredPromise<void>();
		const released = new DeferredPromise<void>();
		const original = f.alpha.fetchChildren;
		f.alpha.fetchChildren = async sort => { await started.complete(); await released.p; return original(sort); };
		f.send('explorer-filter-change', { value: 'nested/' });
		await started.p;
		f.native.dispose();
		const count = f.messages.length;
		await released.complete(); await f.native.refresh();
		assert.equal(f.messages.length, count, 'disposed query must not publish or report a late error');
		assert.equal(f.native.dispatch({ eventType: 'explorer-filter-open' }), false);
	} finally { f.native.dispose(); }
});

test('native Explorer serializes upstream match ranges without dimming names or altering decorations', async () => {
	const f = fixture(false);
	try {
		const unicode = f.item('/fixture/alpha/🧪café.txt', false, f.alpha);
		await f.native.start();
		const matches = (row: any) => {
			let offset = 0;
			return row.render.runs.flatMap((run: any) => {
				const start = offset; offset += run.text.length;
				assert.equal(run.style.dim, undefined, 'unmatched names are not dimmed by Explorer highlight CSS');
				if (!run.style.bg) { return []; }
				assert.equal(run.style.bg.toString(), f.highlight.toString());
				return [{ start, end: offset }];
			});
		};
		assert.ok(f.snapshot().outlineRows.every((row: any) => matches(row).length === 0));
		f.send('explorer-filter-change', { value: 'ap' }); await f.settle();
		const apple = f.snapshot().outlineRows.find((row: any) => row.render.accessibleLabel === 'apple.txt');
		assert.deepEqual(matches(apple), [{ start: 0, end: 2 }]);
		assert.equal(apple.selected, true);
		assert.equal(apple.status, 'M'); assert.equal(apple.statusColor.toString(), f.decorationColor.toString());
		const ranked = f.snapshot().outlineRows.map((row: any) => [row.id, matches(row)]);
		f.send('explorer-filter-complete', { direction: 'previous' }); await f.settle();
		assert.deepEqual(f.snapshot().outlineRows.map((row: any) => [row.id, matches(row)]), ranked, 'completion keeps the typed query match ranges');
		f.send('explorer-filter-change', { value: 'ne' }); await f.settle();
		assert.equal(f.snapshot().outlineRows[0].render.accessibleLabel, 'nested');
		assert.deepEqual(matches(f.snapshot().outlineRows[0]), [{ start: 0, end: 2 }]);
		f.send('explorer-filter-change', { value: 'ne/' }); await f.settle();
		assert.equal(f.snapshot().outlineRows[0].render.accessibleLabel, 'deep');
		assert.ok(f.snapshot().outlineRows.every((row: any) => matches(row).length === 0), 'a resolved path segment does not highlight its children');
		f.send('explorer-filter-change', { value: 'café' }); await f.settle();
		const unicodeRow = f.snapshot().outlineRows.find((row: any) => row.id === unicode.getId());
		const tree = (f.native as any).tree;
		assert.deepEqual(matches(unicodeRow), createMatches(tree.getNode(unicode).filterData));
		assert.deepEqual(matches(unicodeRow), [{ start: 2, end: 6 }], 'ranges are UTF-16 offsets after an astral character');
		assert.equal(unicodeRow.render.runs.map((run: any) => run.text).join(''), unicode.name);
		f.send('explorer-filter-change', { value: 'zzzzzz' }); await f.settle();
		assert.equal(f.snapshot().outlineRows.length, 0);
		f.send('explorer-filter-cancel'); await f.settle();
		assert.ok(f.snapshot().outlineRows.every((row: any) => matches(row).length === 0));
		assert.ok(f.snapshot().outlineRows.some((row: any) => row.render.accessibleLabel === 'nested/deep'));
	} finally { f.native.dispose(); }
});
