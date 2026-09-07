import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Boot, IBootContext } from '../../src/boot.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { ServiceCollection } from '../../src/vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../src/vs/platform/instantiation/common/descriptors.js';
import { IKeyboardLayoutService } from '../../src/vs/platform/keyboardLayout/common/keyboardLayout.js';
import { IStatusbarService } from '../../src/vs/workbench/services/statusbar/browser/statusbar.js';
import { IContextMenuService } from '../../src/vs/platform/contextview/browser/contextView.js';
import { ConfirmResult, IDialogService } from '../../src/vs/platform/dialogs/common/dialogs.js';
import { IEditorService, SIDE_GROUP } from '../../src/vs/workbench/services/editor/common/editorService.js';
import { EditorGroupView } from '../../src/vs/workbench/browser/parts/editor/editorGroupView.js';
import { OpenNextEditor, OpenPreviousEditor } from '../../src/vs/workbench/browser/parts/editor/editorActions.js';
import { EditorGroupModel, IGroupModelChangeEvent } from '../../src/vs/workbench/common/editor/editorGroupModel.js';
import { FileEditorInput } from '../../src/vs/workbench/contrib/files/browser/editors/fileEditorInput.js';
import { DiffEditorInput } from '../../src/vs/workbench/common/editor/diffEditorInput.js';
import { EditorsOrder } from '../../src/vs/workbench/common/editor.js';
import { TerminalKeyboardLayoutService } from '../../src/tui/workbench/terminalKeyboard.js';
import { TerminalStatusbarPart } from '../../src/tui/workbench/statusbarPart.js';
import { TerminalContextMenuService } from '../../src/tui/workbench/contextMenu.js';
import { EditorArea } from '../../src/tui/editor/editorArea.js';
import { NativeEditorTabs } from '../../src/editor/nativeEditorTabs.js';
import type { MacContextMenuService } from '../../src/editor/macContextMenuService.js';
import { stopHost } from '../../src/vs/base/parts/ipc/node/ipc.host.js';
import { IThemeService } from '../../src/vs/platform/theme/common/themeService.js';
import { DefaultThemeService } from '../../src/vs/workbench/services/themes/tauri/defaultThemeService.js';
import { Event } from '../../src/vs/base/common/event.js';
import { KeyCode } from '../../src/vs/base/common/keyCodes.js';
import { IKeybindingService } from '../../src/vs/platform/keybinding/common/keybinding.js';
import { registerTuiCommand } from '../../src/tui/workbench/commands.js';
import { GroupDirection, IEditorGroupsService } from '../../src/vs/workbench/services/editor/common/editorGroupsService.js';
import { MacEditorParts } from '../../src/editor/macEditorParts.js';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { WorkbenchEditorAreaResolver } from '../../src/editor/editorAreaResolver.js';
import { IEditorAreaChildProjectionSource } from '../../src/editor/editorContent.js';
import { TokenizationRegistry } from '../../src/vs/editor/common/languages.js';
import { MarkdownPreviewEditorInput } from '../../src/vs/workbench/contrib/markdown/tauri/markdownPreviewEditorInput.js';
import { TextEditorController } from '../../src/editor/textEditorController.js';
import { CellTextLayoutBackendFactory } from '../../src/tui/editor/cellTextLayout.js';
import { ITextFileService } from '../../src/vs/workbench/services/textfile/common/textfiles.js';
import { ExplorerPane } from '../../src/tui/views/explorerPane.js';
import type { ExplorerView } from '../../src/vs/workbench/contrib/files/browser/views/explorerView.js';
import { listActiveSelectionBackground } from '../../src/vs/platform/theme/common/colors/listColors.js';

class EditorBoot extends Boot {
	constructor(root: string, private readonly macComposition = false) { super(); this.folder = URI.file(root); }
	protected registerFrontendServices(services: ServiceCollection, _context: IBootContext): void {
		services.set(IKeyboardLayoutService, new TerminalKeyboardLayoutService());
		services.set(IStatusbarService, new SyncDescriptor(TerminalStatusbarPart));
		services.set(IContextMenuService, new SyncDescriptor(TerminalContextMenuService, [this.overlays]));
	}
	async start() {
		const { serviceCollection } = await this.initServices();
		const instantiation = this.createInstantiationService(serviceCollection);
		if (this.macComposition) { serviceCollection.set(IEditorGroupsService, new SyncDescriptor(MacEditorParts)); }
		await instantiation.invokeFunction(a => (a.get(IThemeService) as DefaultThemeService).initialize());
		return { area: instantiation.createInstance(EditorArea), createExplorer: () => instantiation.createInstance(ExplorerPane), service: instantiation.invokeFunction(a => a.get(IEditorService)),
			textController: async (resource: URI) => {
				const workingCopy = await instantiation.invokeFunction(a => a.get(ITextFileService)).files.resolve(resource);
				assert.ok(workingCopy.isResolved());
				const controller = instantiation.createInstance(TextEditorController, workingCopy.textEditorModel,
					{ documentId: resource.toString(), resource: resource.toString(), width: 80, visibleRowCount: 10, wrap: false, workingCopy },
					new CellTextLayoutBackendFactory());
				await controller.open();
				return { controller, workingCopy };
			},
			nextEditor: () => instantiation.invokeFunction(a => new OpenNextEditor().run(a)),
			previousEditor: () => instantiation.invokeFunction(a => new OpenPreviousEditor().run(a)),
			dialogs: instantiation.invokeFunction(a => a.get(IDialogService)), keys: instantiation.invokeFunction(a => a.get(IKeybindingService)) };
	}
	stopWorkers(): void { this.webWorkerService.dispose(); }
}

const macComposition = process.env['TUCODE_TEST_MAC_EDITOR_COMPOSITION'] === '1';
test(`real upstream editor lifecycle, event identity, close confirmation and native event transport (Mac composition: ${macComposition})`, { timeout: 45_000 }, async () => {
	const sourceOrOutputRoot = resolve(import.meta.dirname, '../..');
	const repositoryRoot = existsSync(join(sourceOrOutputRoot, 'package.json'))
		? sourceOrOutputRoot : dirname(sourceOrOutputRoot);
	const fixturesRoot = join(repositoryRoot, '.build', 'test-fixtures');
	mkdirSync(fixturesRoot, { recursive: true });
	const base = mkdtempSync(join(fixturesRoot, 'editor-lifecycle-'));
	const workspace = join(base, 'workspace'); const userData = join(base, 'user-data');
	mkdirSync(workspace); mkdirSync(userData);
	writeFileSync(join(workspace, 'a.txt'), 'alpha\n'); writeFileSync(join(workspace, 'b.txt'), 'beta\n');
	writeFileSync(join(workspace, 'preview.md'), '# Preview\n');
	writeFileSync(join(workspace, 'pending.md'), '# Pending\n\n```\ndelayed fence\n```\n');
	writeFileSync(join(workspace, 'late.txt'), 'late content\n');
	process.env['TSCODE_USER_DATA_DIR'] = userData;
	const boot = new EditorBoot(workspace, macComposition);
	let area: EditorArea | undefined;
	try {
		const runtime = await boot.start(); area = runtime.area;
		const explorer = runtime.createExplorer();
		try {
			await explorer.open();
			const tree = (explorer as unknown as { tree: ExplorerView['treeWidget'] }).tree;
			const initial = tree.getFocus()[0];
			assert.equal(initial?.name, 'a.txt', 'initial terminal highlight must have real tree focus');
			const view = (explorer as unknown as { view: ExplorerView }).view;
			const setInput = view.setTreeInput.bind(view);
			// Model focus supplied by upstream input restoration at the adapter's ready boundary.
			view.setTreeInput = async () => { await setInput(); tree.focusLast(); };
			try { await explorer.open(); } finally { view.setTreeInput = setInput; }
			assert.equal(tree.getFocus()[0]?.name, 'preview.md', 'terminal initialization must preserve focus supplied by the view');
			tree.setFocus([]);
			const selection = (explorer as unknown as { themeService: IThemeService }).themeService.getColorTheme().getColor(listActiveSelectionBackground);
			assert.ok(explorer.layout(20, 40).every(row => row.every(span => !span.bg || !selection?.equals(span.bg))),
				'cleared upstream focus must clear both row text and full-width highlight');
			const activeNodes = (tree as unknown as { tree: { onDidChangeActiveNodesRelay: { event: Event<unknown> } } }).tree.onDidChangeActiveNodesRelay.event;
			view.setTreeInput = async () => {
				const emptyNodesPublished = Event.toPromise(activeNodes);
				await tree.setInput([]);
				await emptyNodesPublished;
			};
			try { await explorer.open(); } finally { view.setTreeInput = setInput; }
			assert.deepEqual(tree.getFocus(), []);
			assert.equal(explorer.rowCount, 0);
			assert.ok(explorer.layout(20, 40).every(row => row.every(span => !span.bg || !selection?.equals(span.bg))), 'empty trees have no highlighted row');
		} finally { explorer.dispose(); }
		assert.equal(runtime.keys.lookupKeybinding('tucode.test.dynamic'), undefined);
		const dynamic = registerTuiCommand({ id: 'tucode.test.dynamic', title: 'Dynamic binding', primary: KeyCode.F12,
			scope: 'workbench', handler: () => undefined });
		assert.ok(runtime.keys.lookupKeybinding('tucode.test.dynamic'), 'late registration invalidates the real resolver');
		dynamic.dispose();
		assert.equal(runtime.keys.lookupKeybinding('tucode.test.dynamic'), undefined, 'disposal invalidates the real resolver');
		let answer = ConfirmResult.CANCEL; let confirmations = 0;
		runtime.dialogs.prompt = async <T>() => { confirmations++; return { result: answer as T }; };
		const group = area.groups.activeGroup;
		let focusEvents = 0;
		area.groups.mainPart.onDidFocus(() => focusEvents++);
		assert.ok(group instanceof EditorGroupView);
		assert.equal(group.element.querySelector('.editor-group-watermark-wrapper') !== null, !macComposition,
			'only the normal workbench composition constructs the empty-group watermark');
		assert.ok((group as unknown as { model: EditorGroupModel }).model instanceof EditorGroupModel);
		let latestGroupEvent: IGroupModelChangeEvent | undefined;
		const groupListener = group.onDidModelChange(event => { latestGroupEvent = event; });
		const forwarded: IGroupModelChangeEvent[] = [];
		const serviceListener = runtime.service.onDidEditorsChange(({ event }) => { forwarded.push(event); });
		const messages: { type: string; payload: any }[] = [];
		const nativeMenus: Parameters<MacContextMenuService['showNativeMenu']>[] = [];
		const native = new NativeEditorTabs(area.groups, (type, payload) => messages.push({ type, payload }), {
			showNativeMenu: (...args) => { nativeMenus.push(args); }
		}); native.start();
		assert.equal(messages.length, 1, 'native transport publishes one initial paint');
		assert.equal(messages[0].type, 'editorTabsPaint');
		assert.equal(messages[0].payload.groupId, group.id);
		await area.openFile(URI.file(join(workspace, 'a.txt')));
		const a = group.activeEditor; assert.ok(a instanceof FileEditorInput);
		assert.ok(focusEvents > 0, 'upstream pane opening must emit platform focus');
		assert.equal(area.content?.child?.textModel?.getValue(), 'alpha\n');
		await area.openFile(URI.file(join(workspace, 'a.txt')), { selection: { startLineNumber: 1, startColumn: 3 }, preserveFocus: true });
		const selected = area.content!.child!.projection.snapshot;
		assert.ok(selected.kind === 'text');
		assert.equal(selected.selections[0].active.column, 3, 'reopening the same input applies new upstream options');
		const background = area.content!.child!.projection as IEditorAreaChildProjectionSource;
		await area.openFile(URI.file(join(workspace, 'b.txt')));
		const b = group.activeEditor; assert.ok(b instanceof FileEditorInput);
		const aTab = messages.flatMap(message => message.payload.tabs).find(tab => tab.resource === a.resource.toString());
		assert.ok(aTab);
		assert.equal(native.dispatch({ eventType: 'context-menu', tabId: aTab.id, groupId: group.id, anchor: { x: 25, y: 90 } }), true);
		assert.equal(group.activeEditor, b, 'right-clicking an inactive tab must not activate it');
		assert.equal(nativeMenus[0][1]?.toString(), a.resource.toString(), 'resource actions target the clicked tab');
		assert.deepEqual(nativeMenus[0][4](), { groupId: group.id, editorIndex: group.getIndexOfEditor(a) }, 'close actions target the clicked tab');
		assert.ok(nativeMenus[0][5].has('workbench.action.closeOtherEditors'));
		assert.equal(nativeMenus[0][5].has('workbench.action.moveEditorToNewWindow'), false);
		const focusBeforeViewport = focusEvents; const elementBeforeViewport = document.activeElement;
		const backgroundState = background.snapshot;
		background.dispatch({ kind: 'viewport', documentId: backgroundState.documentId, generation: backgroundState.generation,
			width: 40, wrap: true, firstVisibleRow: 0, visibleRowCount: 10, scrollColumn: 0 });
		assert.equal(group.activeEditor, b, 'background paint must not select its editor');
		assert.equal(focusEvents, focusBeforeViewport, 'background viewport publication must not emit focus');
		assert.equal(document.activeElement, elementBeforeViewport, 'background paint must not move DOM focus');
		assert.ok(forwarded.includes(latestGroupEvent!));
		assert.ok(messages.some(m => m.type === 'editorTabsPaint' && m.payload.tabs.some((tab: { resource?: string }) => tab.resource === b.resource?.toString())));
		await area.openFile(URI.file(join(workspace, 'late.txt')));
		const c = group.activeEditor!;
		await group.openEditor(b);
		const bTab = messages.flatMap(message => message.payload.tabs).find(tab => tab.resource === b.resource.toString());
		const move = { eventType: 'move', tabId: bTab.id, groupId: group.id };
		for (const index of [undefined, -1, 3, 0.5, NaN, Infinity]) {
			assert.equal(native.dispatch({ ...move, index }), false, 'invalid destinations must not mutate the group');
		}
		assert.equal(native.dispatch({ ...move, tabId: 'missing', index: 0 }), false);
		assert.equal(native.dispatch({ ...move, groupId: -1, index: 0 }), false);
		assert.deepEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [a, b, c]);
		assert.equal(native.dispatch({ ...move, index: 0 }), true);
		assert.deepEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [b, a, c]);
		assert.equal(group.activeEditor, b, 'moving an editor preserves its identity and selection');
		await runtime.nextEditor();
		assert.equal(group.activeEditor, a, 'Next Editor must follow the dropped order, not the previous order');
		await runtime.previousEditor();
		assert.equal(group.activeEditor, b, 'Previous Editor must return to the moved editor');
		await runtime.previousEditor();
		assert.equal(group.activeEditor, c, 'Previous Editor wraps from the new first tab');
		await runtime.nextEditor();
		assert.equal(group.activeEditor, b, 'Next Editor wraps to the new first tab');
		assert.equal(native.dispatch({ ...move, index: 2 }), true);
		assert.deepEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [a, c, b], 'moving right uses the final index');
		assert.equal(native.dispatch({ ...move, index: 0 }), true);
		assert.equal(native.dispatch({ ...move, index: 0 }), true, 'dropping at the existing position is harmless');
		await group.closeEditor(c);
		assert.deepEqual(group.getEditors(EditorsOrder.SEQUENTIAL), [b, a]);
		assert.deepEqual(messages.at(-1)!.payload.tabs.map((tab: { resource?: string }) => tab.resource),
			[b.resource?.toString(), a.resource?.toString()], 'native tab paint follows upstream order');
		const { controller, workingCopy } = await runtime.textController(b.resource);
		try {
			const text = controller.model;
			text.pushStackElement();
			text.pushEditOperations(null, [{ range: text.getFullModelRange(), text: 'dirty probe\n' }], () => null);
			text.pushStackElement();
			assert.equal(controller.projection.snapshot.dirty, true);
			await text.undo();
			assert.equal(controller.projection.snapshot.dirty, false, 'undo to the saved version follows the working copy');
			await text.redo();
			assert.equal(controller.projection.snapshot.dirty, true);
			const originalSave = workingCopy.save;
			try {
				workingCopy.save = async () => false;
				assert.equal(await controller.save(), false);
				assert.equal(controller.projection.snapshot.dirty, true, 'a failed save must retain dirty paint');
				workingCopy.save = async () => { throw new Error('save probe'); };
				await assert.rejects(controller.save(), /save probe/);
				assert.equal(controller.projection.snapshot.dirty, true);
				const completion = new DeferredPromise<boolean>();
				workingCopy.save = () => completion.p;
				const saving = controller.save();
				text.applyEdits([{ range: text.getFullModelRange(), text: 'edit during save\n' }]);
				await completion.complete(true); await saving;
				assert.equal(controller.projection.snapshot.dirty, true, 'save completion cannot override newer model edits');
			} finally { workingCopy.save = originalSave; }
			await controller.revert();
			assert.equal(text.getValue(), 'beta\n');
			assert.equal(controller.projection.snapshot.dirty, false, 'revert follows upstream content and dirty events');
			text.applyEdits([{ range: text.getFullModelRange(), text: 'saved probe\n' }]);
			assert.equal(await controller.save(), true);
			assert.equal(controller.projection.snapshot.dirty, false);
		} finally { controller.dispose(); }
		const model = area.content!.child!.textModel!;
		model.applyEdits([{ range: model.getFullModelRange(), text: 'edited\n' }]);
		assert.equal(b.isDirty(), true);
		assert.equal(await group.closeEditor(b), false); assert.equal(confirmations, 1);
		answer = ConfirmResult.SAVE;
		const save = b.save; b.save = async () => undefined;
		assert.equal(await group.closeEditor(b), false, 'failed save must veto close');
		b.save = save;
		assert.equal(await group.closeEditor(b), true);
		assert.equal(readFileSync(join(workspace, 'b.txt'), 'utf8'), 'edited\n');
		assert.equal(group.activeEditor, a);
		await area.whenSettled();
		const alphaModel = area.content!.child!.textModel!;
		alphaModel.applyEdits([{ range: alphaModel.getFullModelRange(), text: 'discard me\n' }]);
		answer = ConfirmResult.DONT_SAVE;
		assert.equal(await group.closeEditor(a), true);
		assert.equal(group.count, 0);
		assert.equal(group.element.querySelector('.editor-group-watermark-wrapper') !== null, !macComposition,
			'closing the final editor must not mount a watermark in the Mac composition');
		assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'alpha\n');
		assert.equal(group.count, 0);
		await area.openDiff(URI.file(join(workspace, 'a.txt')), URI.file(join(workspace, 'b.txt')));
		assert.ok(area.activeEditor instanceof DiffEditorInput);
		assert.equal(messages.at(-1)!.payload.tabs.find((tab: { active: boolean }) => tab.active)?.resource,
			URI.file(join(workspace, 'b.txt')).toString(), 'native diff tabs use the modified file identity for their icon');
		await area.openFile(URI.file(join(workspace, 'a.txt')), { pinned: true });
		await area.openFile(URI.file(join(workspace, 'b.txt')), { pinned: true });
		await area.openFile(URI.file(join(workspace, 'preview.md')), { pinned: true });
		const sourceGroup = area.groups.activeGroup; const source = sourceGroup.activeEditor;
		const openBeforePreview = sourceGroup.getEditors(EditorsOrder.SEQUENTIAL);
		const sourceChild = area.content!.child!;
		const sourceProjection = sourceChild.projection as IEditorAreaChildProjectionSource;
		const sourceSnapshot = sourceProjection.snapshot;
		assert.equal(sourceSnapshot.kind, 'text');
		if (sourceSnapshot.kind === 'text') {
			sourceProjection.dispatch({ kind: 'select', generation: sourceSnapshot.generation, documentId: sourceSnapshot.documentId,
				anchor: { lineNumber: 1, column: 3 }, active: { lineNumber: 1, column: 3 }, source: 'programmatic' });
		}
		const selectedSource = sourceProjection.snapshot;
		if (selectedSource.kind === 'text') { assert.deepEqual(selectedSource.primaryCursor, { lineNumber: 1, column: 3 }); }
		for (let toggle = 0; toggle < 3; toggle++) {
			await area.openMarkdownPreview(URI.file(join(workspace, 'preview.md')));
			assert.equal(area.groups.groups.length, 1, 'regular preview does not create a group');
			assert.equal(area.groups.activeGroup, sourceGroup);
			assert.equal(sourceGroup.count, openBeforePreview.length + 1, 'repeated previews reuse one upstream tab');
			assert.ok(openBeforePreview.every(editor => sourceGroup.contains(editor)), 'all pre-opened tabs remain in the group');
			await area.openMarkdownSource();
			assert.equal(area.activeEditor, source, 'returning from preview reuses the original source input');
			assert.equal(area.content!.child, sourceChild, 'returning from preview preserves the source controller');
			const returnedSource = sourceProjection.snapshot;
			if (selectedSource.kind === 'text' && returnedSource.kind === 'text') {
				assert.deepEqual(returnedSource.selections, selectedSource.selections, 'source selection survives repeated preview toggles');
			}
		}
		await area.openMarkdownPreview(URI.file(join(workspace, 'preview.md')), SIDE_GROUP);
		assert.equal(area.groups.groups.length, 2);
		assert.equal(sourceGroup.activeEditor, source, 'opening preview must retain source editor');
		assert.notEqual(area.groups.activeGroup, sourceGroup);
		assert.equal(area.activeEditor?.getName(), 'Preview preview.md');
		assert.equal(area.activeEditor?.resource?.scheme, 'markdown-preview');
		assert.ok(source instanceof FileEditorInput);
		const sourceModel = await source.resolve();
		assert.ok('textEditorModel' in sourceModel);
		sourceModel.textEditorModel!.setValue('# Live preview\n\none two three four five six seven eight nine ten\n');
		const previewSnapshot = area.content?.child?.projection.snapshot;
		assert.equal(previewSnapshot?.kind, 'markdown');
		if (previewSnapshot?.kind === 'markdown') {
			assert.match(previewSnapshot.tokens[0].raw, /Live preview/, 'the preview observes unsaved source model edits');
		}
		area.cols = 60; area.lines(20); await area.whenSettled();
		const widePreview = area.lines(20).map(row => row.map(span => span.text).join('').trimEnd()).filter(Boolean);
		assert.ok(widePreview.includes('one two three four five six seven eight nine ten'));
		area.cols = 24; area.lines(20); await area.whenSettled();
		const narrowPreview = area.lines(20).map(row => row.map(span => span.text).join('').trimEnd()).filter(Boolean);
		assert.ok(narrowPreview.length > widePreview.length, 'resizing the mounted preview recomputes native wrapping');
		assert.ok(narrowPreview.includes('─'.repeat(24)), 'resizing the mounted preview recomputes heading geometry');
		await runtime.service.revert({ editor: source, groupId: sourceGroup.id });
		const previewGroup = area.groups.activeGroup;
		area.groups.moveGroup(previewGroup, sourceGroup, GroupDirection.LEFT);
		assert.equal(area.groups.activeGroup, previewGroup, 'moving a group retains upstream activation');
		await previewGroup.openEditor(source!);
		const sharedOpen = messages.findLast(m => m.type === 'editorTabsPaint' && m.payload.groupId === previewGroup.id)!;
		const sharedTab = sharedOpen.payload.tabs.find((tab: { resource?: string; active: boolean }) => tab.active && tab.resource === source!.resource?.toString());
		assert.ok(sharedTab);
		const closedInPreview = Event.toPromise(previewGroup.onDidCloseEditor);
		assert.equal(native.dispatch({ eventType: 'close', groupId: previewGroup.id, tabId: sharedTab.id }), true);
		await closedInPreview;
		assert.equal(sourceGroup.contains(source!), true, 'a native tab addresses its own group even when EditorInput is shared');
		assert.equal(previewGroup.contains(source!), false);
		assert.ok(messages.every(m => m.type === 'editorTabsPaint'), 'native transport reports paint without errors');
		native.dispose(); serviceListener.dispose(); groupListener.dispose();

		// Delay a real content result across upstream close. The pane must dispose that late
		// result, not attach it to the editor which replaced the closed input.
		area.groups.activateGroup(sourceGroup);
		await sourceGroup.openEditor(source!);
		const pane = area.content!;
		const resolver = (pane as unknown as { resolver: WorkbenchEditorAreaResolver }).resolver;
		const resolveText = resolver.resolveText.bind(resolver);
		const ready = new DeferredPromise<void>(); const release = new DeferredPromise<void>();
		let lateDisposals = 0;
		resolver.resolveText = async (...args) => {
			const child = await resolveText(...args);
			const dispose = child.dispose.bind(child);
			child.dispose = () => { lateDisposals++; dispose(); };
			void ready.complete(); await release.p;
			return child;
		};
		const opening = area.openFile(URI.file(join(workspace, 'late.txt')));
		void opening.catch(error => ready.error(error));
		try {
			await ready.p;
			const lateInput = sourceGroup.activeEditor!;
			assert.equal(lateInput.resource?.path.endsWith('/late.txt'), true);
			assert.equal(await sourceGroup.closeEditor(lateInput), true);
			assert.equal(lateInput.isDisposed(), true);
		} finally { resolver.resolveText = resolveText; void release.complete(); }
		await opening; await area.whenSettled();
		assert.equal(lateDisposals, 1, 'a result arriving after close must be disposed exactly once');
		assert.equal(sourceGroup.activeEditor, source);
		assert.equal(area.content!.child!.textModel!.getValue(), '# Preview\n', 'late content must not replace the active child');

		// Hold the real fence-tokenization await across replacement, close and disposal. A new
		// preview must not paint the previous document while waiting, and a detached render must
		// neither replace cached rows nor publish a rows-changed callback when it completes.
		await area.openMarkdownPreview(URI.file(join(workspace, 'preview.md')));
		area.cols = 40; area.lines(20); await area.whenSettled();
		assert.ok(area.lines(20).some(row => row.some(span => span.text === 'Preview')));
		const renderGroup = area.groups.activeGroup;
		for (const action of ['complete', 'replace', 'close', 'dispose'] as const) {
			await renderGroup.openEditor(new MarkdownPreviewEditorInput(URI.file(join(workspace, 'pending.md'))));
			const nativePane = area.pane!;
			const paint = nativePane as unknown as { markdownRows: readonly unknown[]; didChangeRows(diagnosticEventId?: number, revealFocus?: boolean): void };
			const tokenize = TokenizationRegistry.getOrCreate;
			const entered = new DeferredPromise<void>(); const finish = new DeferredPromise<void>();
			let delayed = false;
			TokenizationRegistry.getOrCreate = async language => {
				if (!delayed && language === 'plaintext') { delayed = true; void entered.complete(); await finish.p; }
				return tokenize.call(TokenizationRegistry, language);
			};
			const rowsChanged = paint.didChangeRows;
			try {
				const waitingRows = area.lines(20);
				await entered.p;
				assert.equal(waitingRows.some(row => row.some(span => span.text.includes('Preview'))), false,
					'a pending new document must not paint the previous preview rows');
				if (action === 'replace') { await renderGroup.openEditor(source); }
				else if (action === 'close') { await renderGroup.closeEditor(renderGroup.activeEditor!); }
				else if (action === 'dispose') { area.dispose(); }
				if (action !== 'dispose') { await area.content?.whenSettled(); }
				const detachedRows = paint.markdownRows;
				let completions = 0;
				paint.didChangeRows = (...args) => { completions++; rowsChanged.apply(paint, args); };
				let requests = 0; let contentChanges = 0;
				const paintListener = area.onDidRequestPaint(() => requests++);
				const contentListener = area.onDidChange(() => contentChanges++);
				try {
					void finish.complete(); await nativePane.whenSettled();
					if (action === 'complete') {
						assert.equal(completions, 1, 'render completion publishes its new rows once');
						assert.ok(requests > 0, 'async fence completion must request terminal paint without more input');
						assert.equal(contentChanges, 0, 'paint invalidation must not feed back into content changes');
						assert.notEqual(paint.markdownRows, detachedRows);
					} else {
						assert.equal(completions, 0, `${action}: detached tokenization must not publish a repaint`);
						assert.equal(requests, 0, `${action}: detached tokenization must not request terminal paint`);
						assert.equal(paint.markdownRows, detachedRows, `${action}: detached tokenization must not replace cached rows`);
					}
				} finally { paintListener.dispose(); contentListener.dispose(); }
			} finally {
				TokenizationRegistry.getOrCreate = tokenize; paint.didChangeRows = rowsChanged; void finish.complete();
			}
			if (action === 'complete') { await renderGroup.closeEditor(renderGroup.activeEditor!); }
		}
	} finally {
		area?.dispose(); boot.stopWorkers(); boot.flushLog(); await stopHost();
	}
	const logs = readdirSync(join(userData, 'logs')).map(name => readFileSync(join(userData, 'logs', name, 'window.log'), 'utf8')).join('\n');
	assert.doesNotMatch(logs, /\[error\]/, logs);
	rmSync(base, { recursive: true, force: true });
});
