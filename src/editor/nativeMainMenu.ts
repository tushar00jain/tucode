import { IAction } from '../vs/base/common/actions.js';
import { Disposable, MutableDisposable } from '../vs/base/common/lifecycle.js';
import { isCodeEditor, isDiffEditor } from '../vs/editor/browser/editorBrowser.js';
import { MenuId, MenuRegistry, IMenuService } from '../vs/platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../vs/platform/commands/common/commands.js';
import { IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../vs/platform/keybinding/common/keybinding.js';
import { macEditorActions } from './macEditorActions.js';
import { OpenNextEditor, OpenPreviousEditor } from '../vs/workbench/browser/parts/editor/editorActions.js';
import { EditorInputCapabilities } from '../vs/workbench/common/editor.js';
import { IEditorService } from '../vs/workbench/services/editor/common/editorService.js';
import { IWorkingCopyService } from '../vs/workbench/services/workingCopy/common/workingCopyService.js';
import { NativeMenuItem } from './nativeContextMenu.js';
import { nativeMenuKeybinding } from './nativeMenuKeybinding.js';
import { IMenuProjectionInput, MENU_PROJECTION_SEPARATOR, MenuProjectionSnapshot } from '../workbench/menuProjection.js';
import { MainMenuProjectionSource, MenuProjectionResolver } from '../workbench/menuProjectionResolver.js';

// These actions operate on the editor groups already mounted by the Mac app. Their own
// descriptors register the upstream keybindings; no native shortcut command table is needed.
for (const action of [OpenNextEditor, OpenPreviousEditor]) {
	const { id, title } = new action().desc;
	MenuRegistry.appendMenuItem(MenuId.MenubarGoMenu, { group: '4_editor_nav', command: { id, title } });
}

const supportedWorkbenchCommands = new Set([
	...macEditorActions.map(action => new action().desc.id),
	'workbench.action.files.newUntitledFile', 'workbench.action.files.save', 'saveAll', 'workbench.action.files.revert',
	'workbench.action.files.saveAs', 'workbench.action.files.openFile',
	'workbench.action.files.openFolder',
	'workbench.action.files.openFileFolder',
	'workbench.action.toggleAutoSave', 'workbench.action.closeActiveEditor',
	'workbench.action.nextEditor', 'workbench.action.previousEditor',
	'workbench.action.quickOpen', 'workbench.action.showCommands', 'workbench.action.gotoLine',
	'undo', 'redo'
]);

/** Filter presentation only. Commands and their arguments remain owned by VS Code actions. */
class MacMenuResolver extends MenuProjectionResolver {
	override actions(actions: readonly IAction[]): readonly IMenuProjectionInput[] {
		const retain = (items: readonly IMenuProjectionInput[]): readonly IMenuProjectionInput[] => {
			const result: IMenuProjectionInput[] = [];
			for (const item of items) {
				if (item.kind === 'separator') {
					if (result.length && result.at(-1)?.kind !== 'separator') { result.push(item); }
				} else if (item.kind === 'submenu') {
					const children = retain(item.items ?? []);
					if (children.length) { result.push({ ...item, items: children }); }
				} else if (CommandsRegistry.getCommand(item.id) &&
					(item.id.startsWith('editor.') || supportedWorkbenchCommands.has(item.id))) {
					result.push(item);
				}
			}
			if (result.at(-1)?.kind === 'separator') { result.pop(); }
			return result;
		};
		return retain(super.actions(actions, { runner: { run: action => action.run() } }));
	}
}

interface MainMenuItem extends NativeMenuItem {
	commandId?: string;
	selector?: string;
	applicationTarget?: boolean;
	children?: MainMenuItem[];
}

/** The existing immutable main-menu source, transported using the native menu painter's rows. */
export class NativeMainMenu extends Disposable {
	private readonly source = this._register(new MutableDisposable<MainMenuProjectionSource>());
	private readonly listener = this._register(new MutableDisposable());
	private ids: string[] = [];

	constructor(private readonly publish: (type: string, payload?: unknown) => void,
		@IMenuService private readonly menus: IMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@ICommandService private readonly commands: ICommandService,
		@IEditorService private readonly editors: IEditorService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService) {
		super();
		this._register(editors.onDidActiveEditorChange(() => this.rebuild()));
		this._register(workingCopies.onDidChangeDirty(() => this.rebuild()));
		this.rebuild();
	}

	dispatch(payload: { generation?: number; id?: number } | undefined): boolean {
		const source = this.source.value;
		const id = typeof payload?.id === 'number' ? this.ids[payload.id] : undefined;
		return !!source && !!id && payload?.generation === source.snapshot.generation &&
			source.dispatch({ generation: payload.generation, type: 'activate', id });
	}

	private rebuild(): void {
		this.listener.clear(); this.source.clear();
		let control = this.editors.activeTextEditorControl;
		if (isDiffEditor(control)) { control = control.getModifiedEditor(); }
		const base = isCodeEditor(control) ? control.invokeWithinContext(accessor => accessor.get(IContextKeyService))
			: this.editors.activeEditorPane?.scopedContextKeyService ?? this.contextKeys;
		const editor = this.editors.activeEditor;
		// The Mac shell does not instantiate WorkbenchContextKeysHandler. Project the existing
		// editor/working-copy state needed by File menu preconditions into this menu's scope.
		const context = base.createOverlay([
			['activeEditor', editor?.typeId ?? null],
			['activeEditorCanRevert', !!editor && !editor.hasCapability(EditorInputCapabilities.Untitled) && editor.isDirty()],
			['dirtyWorkingCopies', this.workingCopies.hasDirty]
		]);
		const resolver = new MacMenuResolver(this.keybindings, this.commands, nativeMenuKeybinding);
		const source = this.source.value = new MainMenuProjectionSource('tucode', resolver, {
			application: name => ({ id: 'application', kind: 'submenu', label: name, items: [
				{ id: 'quit', kind: 'selector', label: `Quit ${name}`, selector: 'terminate:', target: 'application',
					key: { characters: 'q', modifiers: 1 << 20 } }
			] }),
			edit: () => [], excludedEdit: new Set(), separator: MENU_PROJECTION_SEPARATOR,
			window: () => ({ id: 'native-view', kind: 'submenu', label: 'View', items: [
				{ id: 'fullscreen', kind: 'selector', label: 'Toggle Full Screen', selector: 'toggleFullScreen:',
					key: { characters: 'f', modifiers: (1 << 20) | (1 << 18) } }
			] })
		}, { schedule: callback => { const handle = setTimeout(callback, 0); return { dispose: () => clearTimeout(handle) }; } },
		this.menus, context, this.keybindings);
		this.listener.value = source.onDidSnapshot(snapshot => this.paint(snapshot));
		this.paint(source.snapshot);
	}

	private paint(snapshot: MenuProjectionSnapshot): void {
		this.ids = [];
		const rows = (ids: readonly string[]): MainMenuItem[] => ids.flatMap<MainMenuItem>(id => {
			const item = snapshot.items.get(id)!;
			if (!item.visible) { return []; }
			if (item.kind === 'separator') { return [{ separator: true }]; }
			if (item.kind === 'submenu') {
				const children = rows(item.children).filter((row, index) => !row.separator || index > 0);
				return children.length ? [{ label: item.label, enabled: true, children }] : [];
			}
			const tag = this.ids.push(id) - 1;
			return [{ id: tag, commandId: item.actionId, label: item.label, enabled: item.enabled, checked: item.checked,
				keyLabel: item.key?.label, selector: item.selector, applicationTarget: item.target === 'application',
				key: item.key?.characters, modifiers: item.key?.modifiers }];
		});
		const items: MainMenuItem[] = [];
		for (const row of rows(snapshot.roots)) {
			const existing = items.find(item => item.label === row.label);
			if (existing) { existing.children?.push(...row.children ?? []); } else { items.push(row); }
		}
		this.publish('mainMenu', { generation: snapshot.generation, items });
	}
}
