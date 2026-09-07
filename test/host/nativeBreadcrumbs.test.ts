import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { NativeBreadcrumbsService, resolveBreadcrumbFolder } from '../../src/editor/nativeBreadcrumbs.js';
import { NativeSubmenuAction } from '../../src/editor/nativeContextMenu.js';
import { Event } from '../../src/vs/base/common/event.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { FileKind } from '../../src/vs/platform/files/common/files.js';
import { ExplorerItem } from '../../src/vs/workbench/contrib/files/common/explorerModel.js';
import { FilesFilter } from '../../src/vs/workbench/contrib/files/browser/views/explorerViewer.js';
import type { IContextMenuDelegate } from '../../src/vs/base/browser/contextmenu.js';
import type { IExplorerService } from '../../src/vs/workbench/contrib/files/browser/files.js';

test('native breadcrumbs reuse Explorer items lazily without registering or navigating its view', async () => {
	const fetched: string[] = [];
	const create = (path: string, parent?: ExplorerItem, directory = true) => {
		const item = new ExplorerItem(URI.file(path), { hasCapability: () => false } as never,
			{} as never, {} as never, parent, directory);
		parent?.addChild(item);
		item.fetchChildren = async () => { fetched.push(path); return [...item.children.values()]; };
		return item;
	};
	const root = create('/repo');
	const mac = create('/repo/mac', root);
	const sources = create('/repo/mac/Sources', mac);
	const file = create('/repo/mac/Sources/main.swift', sources, false);
	create('/repo/mac/hidden', mac, false);
	const explorer = {
		findClosestRoot: (resource: URI) => resource.path.startsWith('/repo/') ? root : null,
		sortOrderConfiguration: {},
		registerView() { assert.fail('must not replace the sidebar'); },
		select() { assert.fail('must not navigate the sidebar'); }
	} as unknown as IExplorerService;
	assert.equal(await resolveBreadcrumbFolder(explorer, sources.resource), sources);
	assert.equal(await resolveBreadcrumbFolder(explorer, URI.file('/outside')), undefined);
	fetched.length = 0;
	let delegate: IContextMenuDelegate | undefined;
	let hidden = 0;
	let disposed = 0;
	const opened: unknown[] = [];
	const service = new NativeBreadcrumbsService(explorer, {
		createInstance: (ctor: unknown) => ctor === FilesFilter
			? { filter: (item: ExplorerItem) => item.name !== 'hidden', dispose: () => { disposed++; } }
			: { compare: () => 0 }
	} as never, { showContextMenu: (value: IContextMenuDelegate) => { delegate = value; } } as never,
	{ onDidActiveEditorChange: Event.None, openEditor: async (...args: unknown[]) => { opened.push(args); } } as never,
	{ error: (error: Error) => { throw error; } } as never);
	try {
		assert.equal(service.pickFile(URI.file('/outside'), FileKind.FILE, {} as HTMLElement, 7, () => {}), false);
		const anchor = { isConnected: true, getBoundingClientRect: () => ({ left: 12, bottom: 30 }) } as HTMLElement;
		assert.equal(service.pickFile(mac.resource, FileKind.FOLDER, anchor, 7, () => { hidden++; }), true);
		await new Promise(resolve => setImmediate(resolve));
		assert.ok(delegate);
		assert.deepEqual(delegate.getAnchor(), { x: 12, y: 34 }, 'menu sits four pixels below the breadcrumb');
		assert.deepEqual(fetched, ['/repo', '/repo/mac']);
		const [folder] = delegate.getActions();
		assert.equal(delegate.getActions().length, 1, 'uses the Explorer filter');
		assert.ok(folder instanceof NativeSubmenuAction);
		const [child] = await folder.loadActions();
		assert.equal(fetched.at(-1), sources.resource.path);
		delegate.onHide?.(false);
		await child.run();
		assert.deepEqual(opened, [[{ resource: file.resource }, 7]]);
		assert.equal(hidden, 1);
		assert.equal(disposed, 1);
	} finally { service.dispose(); }
});
