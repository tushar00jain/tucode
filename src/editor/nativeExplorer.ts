/*---------------------------------------------------------------------------------------------
 * AppKit Explorer presentation over VS Code's filesystem model, filter, sorter and compact tree.
 * No browser view is mounted. AppKit owns gestures/selection; this tree owns derived row ancestry.
 *--------------------------------------------------------------------------------------------*/
import { Throttler } from '../vs/base/common/async.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { CancellationError } from '../vs/base/common/errors.js';
import { URI } from '../vs/base/common/uri.js';
import { FuzzyScore, createMatches } from '../vs/base/common/filters.js';
import { CompressibleObjectTreeModel, ICompressedTreeElement } from '../vs/base/browser/ui/tree/compressedObjectTreeModel.js';
import { ITreeNode, TreeVisibility } from '../vs/base/browser/ui/tree/tree.js';
import type { IAsyncDataTreeViewState } from '../vs/base/browser/ui/tree/asyncDataTree.js';
import { IConfigurationService } from '../vs/platform/configuration/common/configuration.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../vs/platform/workspace/common/workspace.js';
import { IExplorerService, IExplorerView } from '../vs/workbench/contrib/files/browser/files.js';
import { ExplorerCompressionDelegate, FilesFilter, FileSorter } from '../vs/workbench/contrib/files/browser/views/explorerViewer.js';
import { ExplorerDecorationsProvider } from '../vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.js';
import { ExplorerItem } from '../vs/workbench/contrib/files/common/explorerModel.js';
import { VIEW_ID } from '../vs/workbench/contrib/files/common/files.js';
import { IDecorationsService } from '../vs/workbench/services/decorations/common/decorations.js';
import { IEditorService } from '../vs/workbench/services/editor/common/editorService.js';
import { NativeSCM } from './nativeScm.js';
import { NativeSearch } from './nativeSearch.js';
import { NativeFilterBox } from './nativeFilterBox.js';
import { ExplorerRootController } from '../vs/workbench/contrib/files/tauri/explorerRootController.js';
import { listFilterMatchHighlight } from '../vs/platform/theme/common/colors/listColors.js';
import { highlightedLabelRuns } from '../render/highlightedLabelRuns.js';
import { MenuId } from '../vs/platform/actions/common/actions.js';
import { IContextMenuService } from '../vs/platform/contextview/browser/contextView.js';
import { IFileService, FileSystemProviderCapabilities } from '../vs/platform/files/common/files.js';
import { ExplorerFolderContext, ExplorerRootContext, ExplorerResourceReadonlyContext, ExplorerResourceParentReadOnlyContext, ExplorerResourceMoveableToTrash, FilesExplorerFocusedContext, ExplorerFocusedContext } from '../vs/workbench/contrib/files/common/files.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID, OPEN_TO_SIDE_COMMAND_ID, SELECT_FOR_COMPARE_COMMAND_ID, COMPARE_RESOURCE_COMMAND_ID } from '../vs/workbench/contrib/files/browser/fileConstants.js';
import type { MacContextMenuService } from './macContextMenuService.js';

// Inline create/rename, native file pickers and workspace changes are not implemented by this view.
// File clipboard actions also require a native clipboard service; the browser service prompts
// for clipboard permission even when merely checking whether Paste should be enabled.
const explorerMenuCommands = new Set([
	OPEN_TO_SIDE_COMMAND_ID, SELECT_FOR_COMPARE_COMMAND_ID, COMPARE_RESOURCE_COMMAND_ID,
	COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID,
	'moveFileToTrash', 'deleteFile'
]);

/** A derived tree of ExplorerItem references, never an independent filesystem model. */
export class NativeExplorer extends Disposable implements IExplorerView {
	readonly id = VIEW_ID;
	private generation = 1;
	private activeContainerId = 'workbench.view.explorer';
	private focusedSectionId = VIEW_ID;
	private focused = false;
	private selectedId: string | undefined;
	private readonly tree: CompressibleObjectTreeModel<ExplorerItem, FuzzyScore>;
	private readonly rows: ITreeNode<ExplorerItem | null, FuzzyScore>[] = [];
	private readonly filter: FilesFilter;
	readonly root: ExplorerRootController<NativeFilterBox>;
	private readonly compression = new ExplorerCompressionDelegate();
	private refreshing: Promise<void> = Promise.resolve();
	private publishQueued = false;
	private readonly publications = this._register(new Throttler());
	private readonly pendingToggles = new Map<ExplorerItem, object>();
	private changes: NativeSCM | undefined;
	private search: NativeSearch | undefined;
	attachSearch(search: NativeSearch): void {
		this.search = search;
		this._register(search.onError(error => this.send('error', { message: error instanceof Error ? error.message : String(error) })));
	}
	attachChanges(changes: NativeSCM): void {
		this.changes = changes;
		this._register(changes.onError(error => this.send('error', { message: error instanceof Error ? error.message : String(error) })));
	}
	changesUpdated(): void { this.schedulePublish(); }

	constructor(
		private readonly send: (type: string, payload: unknown) => unknown,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExplorerService private readonly explorer: IExplorerService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IThemeService private readonly theme: IThemeService,
		@IDecorationsService private readonly decorations: IDecorationsService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IFileService private readonly files: IFileService
	) {
		super();
		this.filter = this._register(instantiationService.createInstance(FilesFilter));
		this.root = this._register(new ExplorerRootController(
			{ setTreeInput: state => this.rebuild(state), selectResource: resource => this.selectResource(resource) },
			() => ({
				updateOptions: options => this.tree.setCompressionEnabled(options.compressionEnabled),
				updateChildren: () => this.rebuild(),
				getNode: () => this.tree.getNode(),
				getFocus: () => this.getFocus(),
				getViewState: () => this.viewState(),
				setFocus: items => { this.selectedId = items[0]?.getId(); this.publish(); },
				reveal() {}, domFocus() {}
			}),
			() => this.configuration.getValue<boolean>('explorer.compactFolders'),
			this.filter, instantiationService.createInstance(FileSorter), this.explorer,
			() => new NativeFilterBox(), () => this.schedulePublish(),
			work => { void this.queue(work); }
		));
		this.tree = new CompressibleObjectTreeModel('Mac Explorer', {
			identityProvider: { getId: item => item.getId() },
			filter: this.root.filter,
			sorter: this.root.filter,
			compressionEnabled: this.configuration.getValue<boolean>('explorer.compactFolders')
		});
		this.explorer.registerView(this);
		this._register(this.tree.onDidSpliceRenderedNodes(({ start, deleteCount, elements }) => {
			this.rows.splice(start, deleteCount, ...elements);
		}));
		this._register(this.filter.onDidChange(() => { void this.refresh(); }));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('explorer.compactFolders')) {
				this.tree.setCompressionEnabled(!this.root.input.isOpen && this.configuration.getValue<boolean>('explorer.compactFolders'));
			}
			if (event.affectsConfiguration('explorer')) { void this.refresh(); }
		}));
		this._register(this.theme.onDidColorThemeChange(() => this.schedulePublish()));
		this._register(this.decorations.onDidChangeDecorations(() => this.schedulePublish()));
		const provider = this._register(instantiationService.createInstance(ExplorerDecorationsProvider));
		this._register(this.decorations.registerDecorationsProvider(provider));
		this._register(this.editors.onDidActiveEditorChange(() => {
			const resource = this.editors.activeEditor?.resource;
			if (this.autoReveal && resource) { void this.explorer.select(resource, this.autoReveal); }
		}));
	}

	get autoReveal(): boolean | 'force' | 'focusNoScroll' { return this.configuration.getValue('explorer.autoReveal'); }
	async start(): Promise<void> { await this.setTreeInput(); }
	setTreeInput(): Promise<void> { return this.refresh(); }

	private queue(work: () => Promise<void>): Promise<void> {
		this.refreshing = this.refreshing.then(async () => {
			if (this._store.isDisposed) { return; }
			await work();
		}).catch(error => {
			if (!this._store.isDisposed) { this.send('error', { message: error instanceof Error ? error.message : String(error) }); }
		});
		return this.refreshing;
	}
	refresh(): Promise<void> { return this.queue(() => this.rebuild()); }
	private async rebuild(state?: IAsyncDataTreeViewState): Promise<void> {
			if (this._store.isDisposed) { return; }
			const roots = this.explorer.roots;
			const input = this.root.rootInput(this.workspace.getWorkbenchState() === WorkbenchState.FOLDER && roots.length === 1 ? roots[0] : roots);
			const children = input instanceof ExplorerItem ? await input.fetchChildren(this.explorer.sortOrderConfiguration.sortOrder) : input;
			const expanded = state && new Set(state.expanded);
			const elements = await Promise.all(children.map(item => this.element(item, expanded)));
			if (this._store.isDisposed) { return; }
			// A native collapse can arrive while children are being resolved. Reapply the current
			// compact-tree state at commit time, not the state captured before the await.
			const currentState = (element: ICompressedTreeElement<ExplorerItem>): ICompressedTreeElement<ExplorerItem> => ({
				...element, collapsed: expanded ? !expanded.has(element.element.getId()) : this.tree.getNodeByIdentity(element.element.getId())?.collapsed ?? element.collapsed,
				children: Array.from(element.children ?? [], currentState)
			});
			this.tree.setChildren(null, elements.map(currentState));
			if (state) { this.selectedId = state.focus?.find(id => !!this.tree.getNodeByIdentity(id)); }
			this.publish();
	}

	/** AsyncDataTree.getViewState's compact-node traversal, over our existing native tree. */
	private viewState(): IAsyncDataTreeViewState {
		const expanded: string[] = [];
		const root = this.tree.getCompressedTreeNode();
		const stack = [root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node !== root && node.collapsible && !node.collapsed) {
				for (const item of node.element!.elements) { expanded.push(item.getId()); }
			}
			stack.push(...node.children);
		}
		const focus = this.getFocus().map(item => item.getId());
		return { focus, selection: focus, expanded };
	}

	private async element(item: ExplorerItem, expanded?: ReadonlySet<string>): Promise<ICompressedTreeElement<ExplorerItem>> {
		if (this._store.isDisposed) { return { element: item }; }
		const previous = this.tree.getNodeByIdentity(item.getId());
		const collapsed = expanded ? !expanded.has(item.getId()) : previous?.collapsed ?? true;
		const collapsible = item.hasChildren(child => this.filter.filter(child, TreeVisibility.Visible));
		// fetchChildren itself owns file nesting and single-child descendant resolution. Only visit
		// known children or an expanded row: no native filesystem traversal or duplicate item cache.
		const children = collapsible && (item.isDirectoryResolved || !collapsed || !!item.nestedChildren)
			? await item.fetchChildren(this.explorer.sortOrderConfiguration.sortOrder) : [];
		return { element: item, collapsible, collapsed,
			incompressible: this.compression.isIncompressible(item),
			children: await Promise.all(children.map(child => this.element(child, expanded))) };
	}

	dispatch(payload: any): boolean {
		if (this._store.isDisposed) { return false; }
		if (this.activeContainerId === 'workbench.view.scm' && this.changes?.dispatch(payload)) { return true; }
		if (this.activeContainerId === 'workbench.view.search' && this.search?.dispatch(payload)) { return true; }
		if (this.activeContainerId === 'workbench.view.explorer' && this.root.input.dispatch(this.root, 'explorer', payload)) { return true; }
		if (payload?.eventType === 'outline-focus-state' && typeof payload.focused === 'boolean') {
			this.focused = payload.focused;
			return true;
		}
		if (typeof payload?.id !== 'string') { return false; }
		if (payload.eventType === 'select-container') {
			if (!this.containers.some(container => container.id === payload.id)) { return false; }
			if (this.activeContainerId === 'workbench.view.scm' && payload.id !== this.activeContainerId) { this.changes?.root.cancel(); }
			if (this.activeContainerId === 'workbench.view.search' && payload.id !== this.activeContainerId) { this.search?.root.cancel(); }
			if (this.activeContainerId === 'workbench.view.explorer' && payload.id !== this.activeContainerId) {
				this.root.input.hasKeyboard = false;
				this.root.cancel();
			}
			this.activeContainerId = payload.id;
			this.focusedSectionId = this.sectionsFor(payload.id)[0]?.id;
			this.publish();
			return true;
		}
		if (payload.eventType === 'focus-section') {
			if (!this.sectionsFor(this.activeContainerId).some(section => section.id === payload.id)) { return false; }
			this.focusedSectionId = payload.id;
			this.publish();
			return true;
		}
		const item = this.rows.find(node => node.element?.getId() === payload.id)?.element;
		if (!item || this.activeContainerId !== 'workbench.view.explorer') { return false; }
		if (payload.eventType === 'outline-context-menu' && Number.isFinite(payload.anchor?.x) && Number.isFinite(payload.anchor?.y)) {
			this.selectedId = item.getId();
			void this.showContextMenu(item, payload.anchor).catch(error => this.send('error', { message: String(error) }));
			return true;
		}
		if (payload.eventType === 'outline-focus') {
			this.selectedId = item.getId();
			// Selection already happened in AppKit; avoid asynchronously replaying stale selection.
			return true;
		}
		if (payload.eventType === 'outline-toggle' && typeof payload.expanded === 'boolean') {
			this.selectedId = item.getId();
			void this.toggle(item, payload.expanded);
			return true;
		}
		if (payload.eventType === 'outline-open') {
			this.selectedId = item.getId();
			if (item.isDirectory) { void this.toggle(item, this.tree.isCollapsed(item)); }
			else { void this.editors.openEditor({ resource: item.resource, options: { preserveFocus: true } }); }
			return true;
		}
		return false;
	}

	private async showContextMenu(item: ExplorerItem, anchor: { x: number; y: number }): Promise<void> {
		if (this._store.isDisposed || this.activeContainerId !== 'workbench.view.explorer' || this.selectedId !== item.getId() || !this.tree.has(item)) { return; }
		(this.contextMenus as MacContextMenuService).showNativeMenu(MenuId.ExplorerContext, item.resource, [
			[ExplorerFolderContext.key, item.isDirectory], [ExplorerRootContext.key, item.isRoot],
			[ExplorerResourceReadonlyContext.key, !!item.isReadonly],
			[ExplorerResourceParentReadOnlyContext.key, !!item.parent?.isReadonly],
			[ExplorerResourceMoveableToTrash.key, !!this.configuration.getValue('files.enableTrash') && this.files.hasCapability(item.resource, FileSystemProviderCapabilities.Trash)],
			[FilesExplorerFocusedContext.key, true], [ExplorerFocusedContext.key, true]
		], anchor, () => {
			if (this.activeContainerId !== 'workbench.view.explorer' || this.getFocus()[0] !== item) { throw new CancellationError(); }
			return [item.resource];
		}, explorerMenuCommands);
	}

	private async toggle(item: ExplorerItem, expanded: boolean): Promise<void> {
		if (this._store.isDisposed || !this.tree.has(item)) { return; }
		const request = {};
		this.pendingToggles.set(item, request);
		this.tree.setCollapsed(item, !expanded);
		if (expanded) {
			await this.refresh();
			if (this._store.isDisposed || this.pendingToggles.get(item) !== request) { return; }
			if (this.tree.has(item)) {
				this.tree.setCollapsed(item, false);
				if (this.selectedId === item.getId()) { this.selectedId = this.tree.getNode(item).element?.getId(); }
			}
		}
		this.pendingToggles.delete(item);
		this.publish();
	}

	getContext(): ExplorerItem[] { return this.getFocus(); }
	getFocus(): ExplorerItem[] {
		const item = this.selectedId && this.tree.getNodeByIdentity(this.selectedId)?.element;
		return item ? [item] : [];
	}
	hasFocus(): boolean { return this.focused; }
	isItemVisible(item: ExplorerItem): boolean { return this.tree.has(item) && this.tree.getListIndex(item) >= 0; }
	isItemCollapsed(item: ExplorerItem): boolean { return !this.tree.has(item) || this.tree.isCollapsed(item); }
	hasPhantomElements(): boolean { return false; }
	focusNext(): void {
		const index = this.rows.findIndex(row => row.element?.getId() === this.selectedId);
		this.selectedId = this.rows[Math.min(index + 1, this.rows.length - 1)]?.element?.getId();
		this.publish();
	}
	focusLast(): void { this.selectedId = this.rows.at(-1)?.element?.getId(); this.publish(); }
	itemsCopied(): void { this.schedulePublish(); }
	async setEditable(item: ExplorerItem, editing: boolean): Promise<void> {
		// There is no native inline text field. Cancel through the existing edit completion so a
		// command cannot leave ExplorerService stuck in editable mode or retain a new-item row.
		if (editing) { await this.explorer.getEditableData(item)?.onFinish(item.name, false); }
	}
	async selectResource(resource: URI | undefined): Promise<void> {
		if (!resource || this._store.isDisposed) { return; }
		const item = this.explorer.findClosest(resource);
		if (!item || item.resource.toString() !== resource.toString()) { return; }
		const parents: ExplorerItem[] = [];
		for (let parent = item.nestedParent ?? item.parent; parent; parent = parent.nestedParent ?? parent.parent) { parents.unshift(parent); }
		for (const parent of parents) {
			if (this._store.isDisposed) { return; }
			if (this.tree.has(parent) && this.tree.isCollapsed(parent)) { await this.toggle(parent, true); }
		}
		if (!this._store.isDisposed && this.tree.has(item)) {
			this.tree.expandTo(item);
			this.selectedId = this.tree.getNode(item).element?.getId();
			this.publish();
		}
	}

	private readonly containers = Object.freeze([
		{ id: 'workbench.view.explorer', title: 'Explorer', icon: { kind: 'theme', id: 'files' } },
		{ id: 'workbench.view.search', title: 'Search', icon: { kind: 'theme', id: 'search' } },
		{ id: 'workbench.view.scm', title: 'Source Control', icon: { kind: 'theme', id: 'source-control' } }
	]);

	private sectionsFor(containerId: string): readonly { id: string; title: string; order: number; expanded: boolean }[] {
		switch (containerId) {
			case 'workbench.view.explorer': return [{ id: 'workbench.explorer.fileView', title: 'Folders', order: 0, expanded: true }];
			case 'workbench.view.search': return [{ id: 'workbench.view.search', title: 'Search', order: 0, expanded: true }];
			case 'workbench.view.scm': return [{ id: 'workbench.scm', title: 'Changes', order: 0, expanded: true }];
			default: return [];
		}
	}


	private schedulePublish(): void {
		if (this.publishQueued || this._store.isDisposed) { return; }
		this.publishQueued = true;
		queueMicrotask(() => { this.publishQueued = false; this.publish(); });
	}

	private publish(): void {
		if (this._store.isDisposed) { return; }
		// Use the upstream throttler across the actual native acknowledgement. The
		// queued factory reads current state only after AppKit finished the last update.
		void this.publications.queue(() => this.publishCurrent()).catch(error => {
			if (!this._store.isDisposed) { this.send('error', { message: String(error) }); }
		});
	}
	private async publishCurrent(): Promise<void> {
		if (this._store.isDisposed) { return; }
		const changes = this.activeContainerId === 'workbench.view.scm' ? this.changes?.snapshot : undefined;
		const search = this.activeContainerId === 'workbench.view.search' ? this.search?.snapshot : undefined;
		const outlineRows = this.activeContainerId === 'workbench.view.explorer'
			? this.rows.flatMap(node => {
				const item = node.element;
				if (!item) { return []; }
				// Compressed rows use the compact-tree parent, never the filesystem parent.
				const parent = this.tree.getParentNodeLocation(item);
				const items = this.tree.getCompressedTreeNode(item).element!.elements;
				const name = items.map(item => item.name).join('/');
				const decoration = this.decorations.getDecoration(item.resource, item.isDirectory);
				const color = this.configuration.getValue<boolean>('explorer.decorations.colors') ? decoration?.color : undefined;
				const fg = color ?? this.theme.getColorTheme().getColor('list.foreground')
					?? this.theme.getColorTheme().getColor('foreground');
				const row = {
					id: item.getId(), parentId: parent?.getId(),
					resource: item.resource.toString(), isDirectory: item.isDirectory,
					status: this.configuration.getValue<boolean>('explorer.decorations.badges') ? decoration?.badgeText : undefined,
					statusColor: decoration?.color,
					expandable: node.collapsible, expanded: node.collapsible && !node.collapsed,
					focused: item.getId() === this.selectedId, selected: item.getId() === this.selectedId,
					// ExplorerRenderer.renderStat's ranges; views.css gives them the match
					// background while leaving the filename foreground unchanged.
					render: { root: {}, runs: highlightedLabelRuns(name, createMatches(node.filterData),
						{ fg, bold: item.isDirectory }, { bg: this.theme.getColorTheme().getColor(listFilterMatchHighlight) }), accessibleLabel: name }
				};
				decoration?.dispose();
				return [row];
			}) : changes?.outlineRows ?? search?.outlineRows ?? [];
		await this.send('navigatorSnapshot', {
			generation: this.generation++, activeContainerId: this.activeContainerId,
			focusedSectionId: this.focusedSectionId, containers: this.containers,
			sections: this.sectionsFor(this.activeContainerId), outlineRows,
			filter: this.activeContainerId === 'workbench.view.explorer' ? this.root.input.snapshot : changes?.filter ?? search?.filter,
			search: search?.search
		});
	}
}
