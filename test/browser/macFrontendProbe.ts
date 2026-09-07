// Runs inside the real WKWebView only for the explicit foreground-test fixture.
import { VSBuffer } from '../../src/vs/base/common/buffer.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { FileAccess } from '../../src/vs/base/common/network.js';
import { MarkdownString } from '../../src/vs/base/common/htmlContent.js';
import { IMarkdownRendererService } from '../../src/vs/platform/markdown/browser/markdownRenderer.js';
import { IWorkspaceContextService } from '../../src/vs/platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../src/vs/platform/instantiation/common/instantiation.js';
import { IFileService } from '../../src/vs/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../src/vs/platform/files/common/inMemoryFilesystemProvider.js';
import { IConfigurationService } from '../../src/vs/platform/configuration/common/configuration.js';
import { IEditorGroupsService } from '../../src/vs/workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../src/vs/workbench/services/editor/common/editorService.js';
import { TextFileEditor } from '../../src/vs/workbench/contrib/files/browser/editors/textFileEditor.js';
import { IEditorGroupView } from '../../src/vs/workbench/browser/parts/editor/editor.js';
import { EditorOption } from '../../src/vs/editor/common/config/editorOptions.js';
import { isCodeEditor } from '../../src/vs/editor/browser/editorBrowser.js';
import { NativeEditorTabs } from '../../src/editor/nativeEditorTabs.js';
import { EditorsOrder, Verbosity } from '../../src/vs/workbench/common/editor.js';

function check(condition: unknown, message: string): asserts condition {
	if (!condition) { throw new Error(`Mac frontend probe: ${message}`); }
}
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = performance.now() + 3000;
	while (!predicate() && performance.now() < deadline) { await settle(); }
	check(predicate(), message);
}

export async function runMacFrontendProbe(instantiation: IInstantiationService): Promise<void> {
	await checkBrowserAssets(instantiation);
	const [files, config, groups, editors] = instantiation.invokeFunction(a =>
		[a.get(IFileService), a.get(IConfigurationService), a.get(IEditorGroupsService), a.get(IEditorService)] as const);
	const originalSettings = ['editor.fontSize', 'files.autoSave', 'workbench.editor.enablePreview'].map(key =>
		[key, config.inspect(key).userValue] as const);
	const provider = new InMemoryFileSystemProvider();
	const registration = files.registerProvider('mac-frontend-test', provider);
	const a = URI.parse('mac-frontend-test:/one/shared.ts');
	const b = URI.parse('mac-frontend-test:/two/shared.ts');
	const c = URI.parse('mac-frontend-test:/preview.ts');
	await files.createFolder(URI.parse('mac-frontend-test:/one'));
	await files.createFolder(URI.parse('mac-frontend-test:/two'));
	for (const uri of [a, b, c]) { await files.writeFile(uri, VSBuffer.fromString(Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n'))); }
	const group = groups.activeGroup as IEditorGroupView;
	const paint = new Map<string, any>();
	const changes: { order?: string[]; tabs: any[]; revealTargetId?: string }[] = [];
	let revealPaintOrdered = true;
	let order: string[] = [];
	const native = new NativeEditorTabs(groups, (_type, payload) => {
		const data = payload as { order?: string[]; tabs: any[]; revealTargetId?: string };
		changes.push(data);
		if (data.order) { order = data.order; }
		for (const tab of data.tabs) { paint.set(tab.id, tab); }
		if (data.revealTargetId && !paint.has(data.revealTargetId)) { revealPaintOrdered = false; }
	});
	native.start();
	try {
		await editors.openEditor({ resource: a, options: { pinned: true } });
		const pane = group.activeEditorPane;
		check(pane instanceof TextFileEditor, 'file must use actual TextFileEditor');
		const control = pane.getControl()!;
		check(isCodeEditor(control), 'file pane exposes the actual code editor');
		await settle();
		control.setPosition({ lineNumber: 140, column: 3 });
		control.setScrollTop(1800);
		const scroll = control.getScrollTop();
		const inputA = group.activeEditor!;
		await editors.openEditor({ resource: b, options: { pinned: true } });
		const inputB = group.activeEditor!;
		await editors.openEditor(inputA);
		await settle();
		check(control.getPosition()?.lineNumber === 140 && control.getPosition()?.column === 3, 'upstream cursor restoration');
		check(Math.abs(control.getScrollTop() - scroll) < 2, 'upstream scroll restoration');
		await config.updateValue('editor.fontSize', 19);
		check(control.getOption(EditorOption.fontSize) === 19, 'upstream configuration updates');
		provider.setReadOnly(true);
		check(control.getOption(EditorOption.readOnly), 'upstream provider readonly updates');
		provider.setReadOnly(false);
		await settle();
		check(!group.element.querySelector('.tabs-container'), 'native tabs must not construct browser tab paint');
		check(order.length === 2 && order.every((id, index) => paint.get(id).label === group.getEditors(EditorsOrder.SEQUENTIAL)[index].getName()), 'native labels come from upstream inputs');
		check(order.every((id, index) => paint.get(id).tooltip === group.getEditors(EditorsOrder.SEQUENTIAL)[index].getTitle(Verbosity.LONG)) && paint.get(order[0]).tooltip !== paint.get(order[1]).tooltip, 'upstream titles disambiguate native tooltips');
		await group.moveEditor(inputB, group, { index: 0 });
		await settle();
		check(paint.get(order[0]).resource === inputB.resource?.toString(), 'upstream move updates native order');
		const target = order[0];
		check(native.dispatch({ tabId: target, groupId: group.id, eventType: 'select' }), 'native target resolves to upstream input');
		await settle();
		check(group.activeEditor === inputB, 'native activation calls upstream group controller');
		await config.updateValue('files.autoSave', 'off');
		await settle();
		changes.length = 0;
		control.getModel()!.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'dirty ' }]);
		await settle();
		check(paint.get(target).dirty === inputB.isDirty(), 'upstream dirty state reaches native paint');
		check(changes.some(change => !change.order && change.tabs.some(tab => tab.id === target && tab.dirty)), 'dirty event publishes affected input');
		check(!changes.some(change => change.revealTargetId), 'dirty-only paint must not request tab reveal');
		await inputB.revert(group.id);
		await config.updateValue('workbench.editor.enablePreview', true);
		await editors.openEditor({ resource: c });
		await settle();
		const inputC = group.activeEditor!;
		const preview = order.map(id => paint.get(id)).find(tab => tab.active);
		check(preview?.tooltip === inputC.getTitle(Verbosity.LONG) && !group.isPinned(inputC), 'preview remains upstream group state');
		group.pinEditor(inputC);
		await settle();
		check(group.isPinned(inputC), 'upstream pinning');
		const pinned = paint.get(preview.id);
		check(pinned.tooltip === inputC.getTitle(Verbosity.LONG), 'native tooltip remains direct upstream input state');
		check(native.dispatch({ tabId: pinned.id, groupId: group.id, eventType: 'close' }), 'native close resolves exact group input');
		await settle();
		check(!group.contains(inputC), 'native close action invokes upstream lifecycle');
		await waitUntil(() => order.length === group.count, 'native paint removes closed input');
		check(!order.map(id => paint.get(id).label).some(label => label.startsWith('preview.ts')), 'native output no longer paints the closed editor');
		check(revealPaintOrdered && changes.some(change => change.revealTargetId), 'native reveal follows upstream activation state');
		await group.closeAllEditors();
		check(!group.element.querySelector('.editor-group-watermark-wrapper'), 'Mac must never construct watermark');
		check(group.titleHeight.total === 0, 'native title paint consumes no browser content height');
	} finally {
		for (const [key, value] of originalSettings) { await config.updateValue(key, value); }
		native.dispose(); registration.dispose(); provider.dispose();
	}
	await editors.openEditor({ resource: URI.parse('untitled:MAC_FRONTEND_PROBE_PASSED'), contents: 'MAC_FRONTEND_PROBE_PASSED', options: { pinned: true } });
}

async function checkBrowserAssets(instantiation: IInstantiationService): Promise<void> {
	const [files, workspace, renderer] = instantiation.invokeFunction(a =>
		[a.get(IFileService), a.get(IWorkspaceContextService), a.get(IMarkdownRendererService)] as const);
	const root = URI.joinPath(workspace.getWorkspace().folders[0].uri, 'asset-probe');
	const resource = URI.joinPath(root, 'logo # % café.svg');
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="37" height="19"><rect width="37" height="19" fill="green"/></svg>';
	await files.createFolder(root);
	try {
		await files.writeFile(resource, VSBuffer.fromString(svg));
		const url = FileAccess.uriToBrowserUri(resource).toString();
		const response = await fetch(url);
		check(response.ok && await response.text() === svg, 'asset fetch returns original file bytes');
		const image = new Image();
		image.src = url;
		await image.decode();
		check(image.naturalWidth === 37 && image.naturalHeight === 19, 'direct image URL decodes in WebKit');
		const markdown = new MarkdownString('![fixture](logo%20%23%20%25%20caf%C3%A9.svg)');
		markdown.baseUri = URI.joinPath(root, 'README.md');
		const rendered = renderer.render(markdown);
		document.body.append(rendered.element);
		try {
			const embedded = rendered.element.querySelector('img');
			check(embedded, 'Markdown produces an image element');
			await embedded.decode();
			check(embedded.naturalWidth === 37, 'relative Markdown image uses the same asset handler');
		} finally { rendered.element.remove(); rendered.dispose(); }
		const missing = await fetch(FileAccess.uriToBrowserUri(URI.joinPath(root, 'missing.png')).toString());
		check(missing.status === 404, 'missing asset returns a resource error');
	} finally { await files.del(root, { recursive: true }); }
}
