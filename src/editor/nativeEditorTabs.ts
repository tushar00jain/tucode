/* Mechanical serialization of upstream editor state for the native tab painter. */
import { Disposable } from '../vs/base/common/lifecycle.js';
import { CancellationError } from '../vs/base/common/errors.js';
import { EditorResourceAccessor, EditorsOrder, GroupModelChangeKind, SideBySideEditor, Verbosity } from '../vs/workbench/common/editor.js';
import { EditorInput } from '../vs/workbench/common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../vs/workbench/services/editor/common/editorGroupsService.js';
import { MenuId } from '../vs/platform/actions/common/actions.js';
import { ActiveEditorLastInGroupContext, EditorGroupEditorsCountContext, EditorTabsVisibleContext, MultipleEditorsSelectedInGroupContext } from '../vs/workbench/common/contextkeys.js';
import { CLOSE_EDITOR_COMMAND_ID, CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID, CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, CLOSE_SAVED_EDITORS_COMMAND_ID, CLOSE_EDITORS_IN_GROUP_COMMAND_ID } from '../vs/workbench/browser/parts/editor/editorCommands.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID } from '../vs/workbench/contrib/files/browser/fileConstants.js';
import type { MacContextMenuService } from './macContextMenuService.js';

const tabMenuCommands = new Set([CLOSE_EDITOR_COMMAND_ID, CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID,
	CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, CLOSE_SAVED_EDITORS_COMMAND_ID, CLOSE_EDITORS_IN_GROUP_COMMAND_ID,
	COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID]);

export class NativeEditorTabs extends Disposable {
	private readonly ids = new WeakMap<EditorInput, string>();
	private nextId = 1;
	constructor(private readonly groups: IEditorGroupsService, private readonly send: (type: string, payload: unknown) => void,
		private readonly contextMenus?: Pick<MacContextMenuService, 'showNativeMenu'>) { super(); }
	private id(editor: EditorInput): string {
		let id = this.ids.get(editor);
		if (!id) { id = String(this.nextId++); this.ids.set(editor, id); }
		return id;
	}
	start(): void {
		const listen = (group: IEditorGroup) => this._register(group.onDidModelChange(event => {
			if (group !== this.groups.activeGroup) { return; }
			const changed = event.editor && (event.kind === GroupModelChangeKind.EDITOR_LABEL || event.kind === GroupModelChangeKind.EDITOR_DIRTY)
				? [event.editor] : undefined;
			this.paint(group, changed, event.kind === GroupModelChangeKind.EDITOR_ACTIVE);
		}));
		for (const group of this.groups.groups) { listen(group); }
		this._register(this.groups.onDidAddGroup(listen));
		this._register(this.groups.onDidChangeActiveGroup(group => this.paint(group, undefined, true)));
		this.paint(this.groups.activeGroup, undefined, true);
	}
	private paint(group: IEditorGroup, changed?: EditorInput[], reveal = false): void {
		const inputs = changed ?? group.getEditors(EditorsOrder.SEQUENTIAL);
		const tabs = inputs.map(editor => ({ id: this.id(editor), label: editor.getName(), tooltip: editor.getTitle(Verbosity.LONG),
			resource: EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY })?.toString(),
			dirty: editor.isDirty(), active: group.activeEditor === editor }));
		this.send('editorTabsPaint', { groupId: group.id, tabs, order: changed ? undefined : tabs.map(tab => tab.id),
			revealTargetId: reveal && group.activeEditor ? this.id(group.activeEditor) : undefined });
	}
	refresh(): void { this.paint(this.groups.activeGroup); }
	dispatch(payload: { eventType?: string; tabId?: string; groupId?: number; index?: number; anchor?: { x: number; y: number } }): boolean {
		if (payload.eventType !== 'select' && payload.eventType !== 'close' && payload.eventType !== 'context-menu' && payload.eventType !== 'move') { return false; }
		const group = typeof payload.groupId === 'number' ? this.groups.getGroup(payload.groupId) : undefined;
		const input = group?.getEditors(EditorsOrder.SEQUENTIAL).find(editor => this.ids.get(editor) === payload.tabId);
		if (!group || !input) { return false; }
		if (payload.eventType === 'move') {
			const index = payload.index;
			if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= group.count) { return false; }
			const moved = group.moveEditor(input, group, { index });
			// Also reconcile a no-op drop, which does not emit a model change.
			if (group === this.groups.activeGroup) { this.paint(group); }
			return moved;
		}
		if (payload.eventType === 'context-menu') {
			const anchor = payload.anchor;
			if (!this.contextMenus || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) { return false; }
			this.contextMenus.showNativeMenu(MenuId.EditorTitleContext,
				EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY }), [
					[ActiveEditorLastInGroupContext.key, group.getIndexOfEditor(input) === group.count - 1],
					[EditorGroupEditorsCountContext.key, group.count], [EditorTabsVisibleContext.key, true],
					[MultipleEditorsSelectedInGroupContext.key, false]
				], anchor, () => {
					const editorIndex = group.getIndexOfEditor(input);
					if (editorIndex < 0 || this.groups.getGroup(group.id) !== group) { throw new CancellationError(); }
					return { groupId: group.id, editorIndex };
				}, tabMenuCommands);
			return true;
		}
		void (payload.eventType === 'close' ? group.closeEditor(input) : group.openEditor(input)).catch(error =>
			this.send('error', { message: error instanceof Error ? error.message : String(error) }));
		return true;
	}
}
