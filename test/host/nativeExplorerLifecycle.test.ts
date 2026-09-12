import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { NativeExplorer } from '../../src/editor/nativeExplorer.js';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { Emitter, Event } from '../../src/vs/base/common/event.js';
import { Disposable } from '../../src/vs/base/common/lifecycle.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { WorkbenchState } from '../../src/vs/platform/workspace/common/workspace.js';
import { ExplorerItem, NewExplorerItem } from '../../src/vs/workbench/contrib/files/common/explorerModel.js';
import { ExplorerService } from '../../src/vs/workbench/contrib/files/browser/explorerService.js';
import { FilesFilter, FileSorter } from '../../src/vs/workbench/contrib/files/browser/views/explorerViewer.js';
import { ExplorerDecorationsProvider } from '../../src/vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.js';
import type { MacContextMenuService } from '../../src/editor/macContextMenuService.js';

function fixture(acknowledge?: () => Promise<void>) {
	const started = new DeferredPromise<void>();
	const children = new DeferredPromise<ExplorerItem[]>();
	const themeChange = new Emitter<void>();
	const config = { onDidChangeConfiguration: Event.None, getValue: (key: string) => key === 'explorer.compactFolders' };
	const files = { hasCapability: () => false };
	const fileConfiguration = { isReadonly: () => false };
	const folder = new ExplorerItem(URI.file('/fixture'), files as never, config as never, fileConfiguration as never, undefined, true);
	const file = new ExplorerItem(URI.file('/fixture/child.txt'), files as never, config as never, fileConfiguration as never, folder, false);
	folder.fetchChildren = async () => {
		await started.complete();
		const result = await children.p;
		folder._isDirectoryResolved = true;
		return result;
	};
	const messages: { type: string; payload: any }[] = [];
	const menus: Parameters<MacContextMenuService['showNativeMenu']>[] = [];
	const explorer = { roots: [folder], registerView() {}, sortOrderConfiguration: {},
		getEditableData: (_item: ExplorerItem): any => undefined };
	const native = new NativeExplorer((type, payload) => {
		messages.push({ type, payload });
		if (type === 'navigatorSnapshot') { return acknowledge?.(); }
		return undefined;
	}, {
		createInstance: (ctor: unknown) => {
			if (ctor === FilesFilter) { return { filter: () => true, onDidChange: Event.None, dispose() {} }; }
			if (ctor === FileSorter) { return { compare: () => 0 }; }
			assert.equal(ctor, ExplorerDecorationsProvider);
			return { dispose() {} };
		}
	} as never, explorer as never, config as never,
	{ getWorkbenchState: () => WorkbenchState.WORKSPACE } as never,
	{ onDidActiveEditorChange: Event.None } as never,
	{ onDidColorThemeChange: themeChange.event, getColorTheme: () => ({ getColor: () => undefined }) } as never,
	{ onDidChangeDecorations: Event.None, registerDecorationsProvider: () => Disposable.None, getDecoration: () => undefined } as never,
	{ showNativeMenu: (...args: Parameters<MacContextMenuService['showNativeMenu']>) => menus.push(args) } as never,
	files as never);
	return { native, folder, file, started, children, themeChange, messages, explorer, menus };
}

test('native Explorer context menu targets the clicked row and excludes unfinished inline actions', async () => {
	const f = fixture();
	try {
		await f.native.start();
		assert.equal(f.native.dispatch({ eventType: 'outline-context-menu', id: f.folder.getId(), anchor: { x: 10, y: 20 } }), true);
		assert.deepEqual(f.native.getContext(), [f.folder]);
		assert.equal(f.menus[0][1], f.folder.resource);
		assert.deepEqual(f.menus[0][4](), [f.folder.resource]);
		for (const command of ['filesExplorer.cut', 'filesExplorer.copy', 'filesExplorer.paste']) {
			assert.equal(f.menus[0][5].has(command), false, 'native file clipboard is not implemented');
		}
		assert.equal(f.menus[0][5].has('explorer.newFile'), false);
		assert.equal(f.menus[0][5].has('renameFile'), false);
		f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.search' });
		assert.throws(f.menus[0][4], /Canceled/, 'a menu cannot operate on a different current selection');
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});

test('native navigator has no Sapling placeholder or selectable Sapling sections', async () => {
	const f = fixture();
	try {
		await f.native.start();
		assert.deepEqual(f.messages.at(-1)!.payload.containers.map((container: { id: string }) => container.id),
			['workbench.view.explorer', 'workbench.view.search', 'workbench.view.scm', 'workbench.view.scm.history']);
		const count = f.messages.length;
		assert.equal(f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.sapling' }), false);
		assert.equal(f.native.dispatch({ eventType: 'focus-section', id: 'workbench.view.sapling.commitInfo' }), false);
		assert.equal(f.messages.length, count);
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});

test('Graph is an independent navigator and never uses the Changes section/filter path', async () => {
	const f = fixture(), visible: boolean[] = [], events: string[] = [];
	try {
		f.native.attachHistory({ onError: Event.None, setVisible: (value: boolean) => visible.push(value),
			dispatch: (event: { eventType: string }) => { if (event.eventType === 'outline-open') { events.push(event.eventType); return true; } return false; },
			snapshot: { outlineRows: [], history: { repository: 'Repo' } } } as any);
		await f.native.start();
		f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.scm' });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual(f.messages.at(-1)!.payload.sections.map((section: { title: string }) => section.title), ['Changes']);
		f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.scm.history' });
		await new Promise(resolve => setTimeout(resolve, 0));
		const graph = f.messages.at(-1)!.payload;
		assert.equal(graph.activeContainerId, 'workbench.view.scm.history');
		assert.deepEqual(graph.sections.map((section: { title: string }) => section.title), ['Graph']);
		assert.equal(graph.filter, undefined);
		assert.equal(graph.history.repository, 'Repo');
		assert.equal(visible.at(-1), true);
		assert.equal(f.native.dispatch({ eventType: 'outline-open', id: 'commit' }), true);
		assert.deepEqual(events, ['outline-open']);
		f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.explorer' });
		assert.equal(visible.at(-1), false);
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});

test('native Explorer keeps the latest collapse when an earlier expansion resolves late', async () => {
	const f = fixture();
	try {
		await f.native.start();
		assert.equal(f.native.dispatch({ eventType: 'outline-toggle', id: f.folder.getId(), expanded: true }), true);
		await f.started.p;
		assert.equal(f.native.dispatch({ eventType: 'outline-toggle', id: f.folder.getId(), expanded: false }), true);
		await f.children.complete([f.file]);
		await f.native.refresh();
		const rows = f.messages.at(-1)!.payload.outlineRows;
		assert.deepEqual(rows.map((row: any) => row.id), [f.folder.getId()]);
		assert.equal(rows[0].expanded, false);
		assert.equal(f.native.isItemCollapsed(f.folder), true);
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});

test('native Explorer supplies file identity for native icons independently of row labels', async () => {
	const f = fixture();
	try {
		await f.native.start();
		f.native.dispatch({ eventType: 'outline-toggle', id: f.folder.getId(), expanded: true });
		await f.started.p;
		await f.children.complete([f.file]);
		await f.native.refresh();
		const rows = f.messages.at(-1)!.payload.outlineRows;
		assert.deepEqual(rows.map((row: any) => [row.resource, row.isDirectory]),
			[[f.folder.resource.toString(), true], [f.file.resource.toString(), false]]);
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});

test('native Explorer publishes nothing from pending fetch or queued repaint after disposal', async () => {
	const f = fixture();
	await f.native.start();
	f.native.dispatch({ eventType: 'outline-toggle', id: f.folder.getId(), expanded: true });
	await f.started.p;
	f.themeChange.fire();
	f.native.dispose();
	const count = f.messages.length;
	await f.children.complete([f.file]);
	await f.native.refresh();
	await Promise.resolve();
	assert.equal(f.messages.length, count);
	assert.equal(f.native.dispatch({ eventType: 'outline-focus', id: f.folder.getId() }), false);
	f.themeChange.dispose();
});

test('native Explorer cancellation clears upstream editable state and the temporary new item', async () => {
	const f = fixture();
	try {
		const service = Object.assign(Object.create(ExplorerService.prototype),
			{ view: f.native, fileChangeEvents: [] }) as ExplorerService;
		f.explorer.getEditableData = item => service.getEditableData(item);
		const pending = new NewExplorerItem(undefined!, undefined!, undefined!, f.folder, false);
		f.folder.addChild(pending);
		let accepted: boolean | undefined;
		await service.setEditable(pending, {
			validationMessage: () => null,
			onFinish: async (_value, success) => {
				accepted = success;
				f.folder.removeChild(pending);
				await service.setEditable(pending, null);
			}
		});
		assert.equal(accepted, false);
		assert.equal(service.isEditable(undefined), false);
		assert.equal(f.folder.children.has(pending.name), false);
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});


test('native navigator waits for AppKit and coalesces publications to the latest state', async () => {
	const acknowledgements: DeferredPromise<void>[] = [];
	const f = fixture(() => { const ack = new DeferredPromise<void>(); acknowledgements.push(ack); return ack.p; });
	try {
		await f.native.start();
		const first = f.messages.length;
		f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.search' });
		f.native.dispatch({ eventType: 'select-container', id: 'workbench.view.scm' });
		for (let i = 0; i < 30; i++) { f.native.changesUpdated(); }
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.messages.length, first, 'no result update may overtake the native acknowledgement');
		await acknowledgements[0].complete();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.messages.length, first + 1);
		assert.equal(f.messages.at(-1)!.payload.activeContainerId, 'workbench.view.scm');
		await acknowledgements[1].complete();
	} finally { f.native.dispose(); f.themeChange.dispose(); }
});
