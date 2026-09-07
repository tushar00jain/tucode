/* AppKit Changes rows over the existing SCM graph and shared view-root interaction. */
import { Disposable, DisposableStore } from '../vs/base/common/lifecycle.js';
import { Emitter } from '../vs/base/common/event.js';
import { CompressibleObjectTreeModel, ICompressedTreeElement } from '../vs/base/browser/ui/tree/compressedObjectTreeModel.js';
import { ITreeNode } from '../vs/base/browser/ui/tree/tree.js';
import { basename, dirname, relativePath } from '../vs/base/common/resources.js';
import { IConfigurationService } from '../vs/platform/configuration/common/configuration.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../vs/platform/storage/common/storage.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { TauriGitResource } from '../vs/workbench/contrib/scm/tauri/tauriGitProvider.js';
import { GitResourceGroupType } from '../vs/workbench/contrib/scm/tauri/scmIpc.js';
import { getStatusColor } from '../vs/workbench/contrib/scm/tauri/gitStatus.js';
import { ISCMViewService, ViewMode } from '../vs/workbench/contrib/scm/common/scm.js';
import { SCMResourceIdentityProvider, SCMTreeCompressionDelegate, SCMTreeDataSource, SCMTreeFilter, SCMTreeSorter, TreeElement, ViewSortKey } from '../vs/workbench/contrib/scm/browser/scmViewPane.js';
import { isSCMResource, isSCMRepository, isSCMResourceGroup, isSCMResourceNode, isSCMInput, isSCMActionButton } from '../vs/workbench/contrib/scm/browser/util.js';
import { createSCMFilter, SCMFilterData, SCMViewRootDataSource, rootCompression, ISCMViewRoot, queryFor, rootFor, scmNodes } from '../vs/workbench/contrib/scm/tauri/scmFilter.js';
import { ViewRootController } from '../vs/workbench/browser/tauri/viewRootController.js';
import { NativeFilterBox } from './nativeFilterBox.js';
import { descend, splitQuery } from '../vs/workbench/browser/tauri/viewRoot.js';

export class NativeSCM extends Disposable {
	private readonly errors = this._register(new Emitter<unknown>());
	readonly onError = this.errors.event;
	readonly identity = new SCMResourceIdentityProvider();
	readonly model: CompressibleObjectTreeModel<TreeElement, SCMFilterData>;
	readonly rendered: ITreeNode<TreeElement | null, SCMFilterData>[] = [];
	readonly filter;
	readonly source: SCMViewRootDataSource;
	readonly root: NativeSCMViewRoot;
	selected: TreeElement | undefined;
	private pending = Promise.resolve();
	private revision = 0;
	private readonly repositories = this._register(new DisposableStore());
	readonly mode = () => (this.storage.get('scm.viewMode', StorageScope.WORKSPACE) ?? this.configuration.getValue<string>('scm.defaultViewMode')) === 'tree' ? ViewMode.Tree : ViewMode.List;
	constructor(readonly publish: () => void,
		@IInstantiationService instantiation: IInstantiationService,
		@IConfigurationService readonly configuration: IConfigurationService,
		@ISCMViewService readonly view: ISCMViewService,
		@IStorageService private readonly storage: IStorageService,
		@IThemeService private readonly theme: IThemeService) {
		super();
		this.filter = this._register(createSCMFilter(instantiation, this.mode, new SCMTreeFilter(), new SCMTreeSorter(this.mode, () => this.storage.get('scm.viewSortKey', StorageScope.WORKSPACE) as ViewSortKey ?? this.configuration.getValue<ViewSortKey>('scm.defaultViewSortKey') ?? ViewSortKey.Path)));
		this.source = new SCMViewRootDataSource(this._register(instantiation.createInstance(SCMTreeDataSource, this.mode)), this.mode, this.filter);
		this.model = new CompressibleObjectTreeModel('Mac Changes', { identityProvider: this.identity, filter: this.filter, sorter: this.filter, compressionEnabled: this.compact });
		this._register(this.model.onDidSpliceRenderedNodes(e => this.rendered.splice(e.start, e.deleteCount, ...e.elements)));
		this.root = this._register(new NativeSCMViewRoot(this));
		this._register(view.onDidChangeVisibleRepositories(() => this.observe()));
		this._register(configuration.onDidChangeConfiguration(e => { if (e.affectsConfiguration('scm')) { void this.refresh(); } }));
		this._register(storage.onDidChangeValue(StorageScope.WORKSPACE, undefined, this._store)(e => {
			if (e.key === 'scm.viewMode' || e.key === 'scm.viewSortKey') { void this.refresh(); }
		}));
		this._register(theme.onDidColorThemeChange(() => this.publish()));
		this.observe();
	}
	get compact(): boolean { return this.mode() === ViewMode.Tree && this.configuration.getValue<boolean>('scm.compactFolders') !== false && !this.root?.input.isOpen; }
	get disposed(): boolean { return this._store.isDisposed; }
	queue(work: () => Promise<void>): Promise<void> {
		this.pending = this.pending.then(async () => { if (!this._store.isDisposed) { await work(); } }).catch(error => { if (!this.disposed) { this.errors.fire(error); } });
		return this.pending;
	}
	private observe(): void {
		this.repositories.clear();
		this.root.repositoryChanged();
		for (const repository of this.view.visibleRepositories) {
			this.repositories.add(repository.provider.onDidChangeResources(() => { void this.refresh(); }));
			this.repositories.add(repository.provider.onDidChangeResourceGroups(() => { void this.refresh(); }));
		}
		void this.refresh();
	}
	refresh(): Promise<void> { this.revision++; return this.queue(() => this.rebuild()); }
	async rebuild(): Promise<void> {
		if (this.disposed) { return; }
		const revision = this.revision;
		this.filter.clearRanked();
		const compression = rootCompression(new SCMTreeCompressionDelegate(), this.filter);
		const visit = async (element: TreeElement): Promise<ICompressedTreeElement<TreeElement>> => ({ element,
			incompressible: compression.isIncompressible(element), collapsible: this.source.hasChildren(element),
			collapsed: this.root.input.isOpen ? false : this.model.getNodeByIdentity(this.identity.getId(element))?.collapsed ?? false,
			children: await Promise.all(Array.from(await this.source.getChildren(element), visit)) });
		const children = await Promise.all(Array.from(await this.source.getChildren(this.view), visit));
		if (this._store.isDisposed || revision !== this.revision) { return; }
		this.model.setCompressionEnabled(this.compact);
		this.model.setChildren(null, children);
		if (this.selected) { this.selected = this.model.getNodeByIdentity(this.identity.getId(this.selected))?.element ?? undefined; }
		this.publish();
	}
	get snapshot() {
		return { filter: this.root.input.snapshot, outlineRows: this.rendered.flatMap(node => {
			const element = node.element;
			if (!element || isSCMInput(element) || isSCMActionButton(element)) { return []; }
			const parent = this.model.getParentNodeLocation(element);
			const label = isSCMRepository(element) ? element.provider.name : isSCMResourceGroup(element) ? `${element.label} (${element.resources.length})`
				: isSCMResourceNode(element) ? this.model.getCompressedTreeNode(element).element!.elements.map(e => isSCMResourceNode(e) ? e.name : '').join('/')
				: `${basename(element.sourceUri)}${this.mode() === ViewMode.List && element.resourceGroup.provider.rootUri ? `  ${relativePath(element.resourceGroup.provider.rootUri, dirname(element.sourceUri)) ?? ''}` : ''}`.trimEnd();
			const status = element instanceof TauriGitResource ? element.letter : undefined;
			const statusColor = element instanceof TauriGitResource ? this.theme.getColorTheme().getColor(getStatusColor(element.status)) : undefined;
			return [{ id: this.identity.getId(element), parentId: parent ? this.identity.getId(parent) : undefined,
				resource: (isSCMResource(element) ? element.sourceUri : isSCMResourceNode(element) ? element.uri : isSCMRepository(element) ? element.provider.rootUri : undefined)?.toString(),
				isDirectory: !isSCMResource(element),
				status, statusColor, icon: isSCMResourceGroup(element) && (element.id === GitResourceGroupType.WorkingTree || element.id === GitResourceGroupType.Index) ? 'diff' : undefined,
				expandable: node.collapsible, expanded: node.collapsible && !node.collapsed,
				selected: element === this.selected, focused: element === this.selected,
				render: { root: {}, runs: [{ text: label, style: { bold: isSCMRepository(element) || isSCMResourceGroup(element) } }], accessibleLabel: isSCMResource(element) ? `${label} ${element.decorations.tooltip ?? ''}`.trimEnd() : label } }];
		}) };
	}
	dispatch(payload: any): boolean {
		if (this._store.isDisposed) { return false; }
		if (this.root.input.dispatch(this.root, 'scm', payload)) { return true; }
		// A native field blur may restore the previous root before the click arrives. Stable
		// model identity also resolves rows hidden by that restore's collapsed ancestors.
		const element = typeof payload.id === 'string' ? this.model.getNodeByIdentity(payload.id)?.element : undefined;
		if (!element) { return false; }
		if (payload.eventType === 'outline-focus') { this.selected = element; return true; }
		if (payload.eventType === 'outline-toggle' || payload.eventType === 'outline-open') {
			void this.queue(async () => {
				const current = this.model.getNodeByIdentity(this.identity.getId(element))?.element;
				if (!current) { return; }
				this.selected = current;
				if (payload.eventType === 'outline-open' && isSCMResource(current)) { await current.open(false); }
				else { this.model.setCollapsed(current, payload.eventType === 'outline-toggle' ? !payload.expanded : !this.model.isCollapsed(current)); }
				if (!this._store.isDisposed) { this.publish(); }
			});
			return true;
		}
		return false;
	}
}

class NativeSCMViewRoot extends ViewRootController<TreeElement, NativeFilterBox> {
	private restore: ISCMViewRoot | undefined;
	private restoreFocus: TreeElement | undefined;
	get input(): NativeFilterBox { return this.box; }
	constructor(private readonly owner: NativeSCM) { super(() => new NativeFilterBox(), work => { void owner.queue(work); }); }
	protected opening(): string { this.restore = this.owner.source.root; this.restoreFocus = this.owner.selected; return queryFor(this.owner.source.root); }
	protected async applyQuery(query: string): Promise<void> {
		if (!this.box.isOpen) { return; }
		const { path, pattern } = splitQuery(query);
		const { root, resolved } = await descend(scmNodes(this.owner.view), path);
		if (this.owner.disposed || !this.box.isOpen) { return; }
		this.owner.source.root = root;
		this.owner.filter.set(pattern, resolved);
		await this.owner.rebuild();
		this.focusTo(this.rows.find(row => this.owner.filter.ranks(row)) ?? this.rows[0]);
	}
	protected async cancelRoot(): Promise<void> { await this.close(this.restore, this.restoreFocus); }
	protected async commitRoot(): Promise<void> {
		const element = splitQuery(this.box.value).pattern ? this.owner.selected : undefined;
		const root = rootFor(this.owner.view, element);
		await this.close(root ?? this.owner.source.root, root ? undefined : element);
	}
	private async close(root: ISCMViewRoot | undefined, focus: TreeElement | undefined): Promise<void> {
		if (root && !this.owner.view.visibleRepositories.includes(root.repository)) { root = undefined; focus = undefined; }
		this.owner.source.root = root; this.restore = undefined; this.restoreFocus = undefined;
		// The native field stays visible while inactive; display the committed/restored root.
		this.box.value = queryFor(root);
		this.owner.filter.clear(); await this.owner.rebuild();
		this.focusTo(focus && this.rows.includes(focus) ? focus : this.rows[0]);
	}
	repositoryChanged(): void {
		if (this.owner.source.root && !this.owner.view.visibleRepositories.includes(this.owner.source.root.repository)) { this.owner.source.root = undefined; }
		if (this.restore && !this.owner.view.visibleRepositories.includes(this.restore.repository)) { this.restore = undefined; }
	}
	protected get rows(): TreeElement[] { return this.owner.rendered.flatMap(row => row.element ? [row.element] : []); }
	protected name(element: TreeElement): string | undefined { return this.owner.filter.name(element); }
	protected get tree() { return { setFocus: (elements: TreeElement[]) => { if (!this.owner.disposed) { this.owner.selected = elements[0]; this.owner.publish(); } }, reveal() {}, domFocus() {} }; }
	protected relayout(): void { if (!this.owner.disposed) { this.owner.publish(); } }
}
