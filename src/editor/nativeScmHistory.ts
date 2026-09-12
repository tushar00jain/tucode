/* Native graph projection. SCM services and the shared history tree own all semantic work. */
import { Emitter } from '../vs/base/common/event.js';
import { IDecorationsService } from '../vs/workbench/services/decorations/common/decorations.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { autorun, runOnChange } from '../vs/base/common/observable.js';
import { Action } from '../vs/base/common/actions.js';
import { basename, dirname, relativePath } from '../vs/base/common/resources.js';
import { stripIcons } from '../vs/base/common/iconLabels.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../vs/platform/configuration/common/configuration.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { IContextMenuService } from '../vs/platform/contextview/browser/contextView.js';
import { IClipboardService } from '../vs/platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../vs/platform/dialogs/common/dialogs.js';
import { IEditorService } from '../vs/workbench/services/editor/common/editorService.js';
import { ISCMViewService, ViewMode } from '../vs/workbench/contrib/scm/common/scm.js';
import { SCMHistoryViewModel } from '../vs/workbench/contrib/scm/browser/scmHistoryViewPane.js';
import { SCMHistoryTreeModel } from '../vs/workbench/contrib/scm/browser/scmHistoryTreeModel.js';
import { HistoryItemRefPicker, openSCMHistoryChange, resolveSCMHistoryItemComparison, TreeElement } from '../vs/workbench/contrib/scm/browser/scmHistoryTree.js';
import { RepositoryPicker } from '../vs/workbench/contrib/scm/browser/scmViewService.js';
import { getSCMHistoryGraphGeometry, getSCMHistoryGraphPlaceholderGeometry, getHistoryItemIndex, scmHistoryGraphPathCommands } from '../vs/workbench/contrib/scm/browser/scmHistory.js';
import { getHistoryItemEditorTitle, isSCMHistoryItemChangeNode, isSCMHistoryItemChangeViewModelTreeElement, isSCMHistoryItemLoadMoreTreeElement, isSCMHistoryItemViewModelTreeElement } from '../vs/workbench/contrib/scm/browser/util.js';
import { ScmHistoryItemResolver } from '../vs/workbench/contrib/multiDiffEditor/browser/scmMultiDiffSourceResolver.js';
import type { MacContextMenuService } from './macContextMenuService.js';

export class NativeSCMHistory extends Disposable {
	readonly viewModel: SCMHistoryViewModel;
	readonly model: SCMHistoryTreeModel;
	private readonly errors = this._register(new Emitter<unknown>());
	readonly onError = this.errors.event;
	private visible = false;
	private stale = true;
	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && this.stale) { this.stale = false; void this.model.refresh(); }
	}
	private refresh(): void { this.stale = true; if (this.visible) { this.stale = false; void this.model.refresh(); } }
	private run(work: Promise<unknown>): void { void work.catch(error => { if (!this._store.isDisposed) { this.errors.fire(error); } }); }
	constructor(private readonly publish: () => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ISCMViewService view: ISCMViewService,
		@IThemeService private readonly theme: IThemeService,
		@IEditorService private readonly editors: IEditorService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
		@IDecorationsService private readonly decorations: IDecorationsService) {
		super();
		this.viewModel = this._register(instantiation.createInstance(SCMHistoryViewModel));
		this.model = this._register(new SCMHistoryTreeModel(this.viewModel));
		this._register(this.model.onError(error => this.errors.fire(error)));
		this._register(decorations.onDidChangeDecorations(publish));
		this._register(this.model.onDidChange(publish));
		this._register(autorun(reader => {
			const repository = this.viewModel.repository.read(reader);
			const provider = repository?.provider.historyProvider.read(reader);
			provider?.historyItemRef.read(reader);
			provider?.historyItemRemoteRef.read(reader);
			provider?.historyItemBaseRef.read(reader);
			provider?.historyItemRefChanges.read(reader);
			this.refresh();
		}));
		this._register(runOnChange(this.viewModel.onDidChangeHistoryItemsFilter, () => this.refresh()));
		this._register(runOnChange(this.viewModel.viewMode, () => { void this.model.setViewMode(); }));
		this._register(runOnChange(view.graphShowIncomingChangesConfig, () => this.refresh()));
		this._register(runOnChange(view.graphShowOutgoingChangesConfig, () => this.refresh()));
		this._register(configuration.onDidChangeConfiguration(e => { if (e.affectsConfiguration('scm.compactFolders')) { this.model.setCompression(configuration.getValue('scm.compactFolders') !== false); } }));
		this._register(theme.onDidColorThemeChange(publish));
		this.model.setCompression(configuration.getValue('scm.compactFolders') !== false);
	}
	get snapshot() {
		const repository = this.viewModel.repository.get();
		const filter = this.viewModel.getHistoryItemsFilter();
		const color = (id: string | undefined) => this.theme.getColorTheme().getColor(id ?? 'sideBar.background');
		const outlineRows = this.model.rendered.flatMap(node => {
			const element = node.element;
			if (!element) { return []; }
			const commit = isSCMHistoryItemViewModelTreeElement(element);
			const folder = isSCMHistoryItemChangeNode(element);
			const change = isSCMHistoryItemChangeViewModelTreeElement(element);
			const more = isSCMHistoryItemLoadMoreTreeElement(element);
			const vm = folder ? element.context.historyItemViewModel : more ? undefined : element.historyItemViewModel;
			const geometry = commit ? getSCMHistoryGraphGeometry(element.historyItemViewModel)
				: getSCMHistoryGraphPlaceholderGeometry(folder ? element.context.historyItemViewModel.outputSwimlanes : element.graphColumns, vm ? getHistoryItemIndex(vm) : undefined);
			const label = commit ? stripIcons(element.historyItemViewModel.historyItem.subject)
				: more ? this.model.loading ? 'Loading…' : 'Load More'
				: folder ? this.model.tree.getCompressedTreeNode(element).element!.elements.map(e => isSCMHistoryItemChangeNode(e) ? e.name : '').join('/')
				: `${basename(element.historyItemChange.uri)}${this.viewModel.viewMode.get() === ViewMode.List && repository?.provider.rootUri ? `  ${relativePath(repository.provider.rootUri, dirname(element.historyItemChange.uri)) ?? ''}` : ''}`.trimEnd();
			const details = commit ? [vm?.historyItem.author, vm?.historyItem.displayId ?? vm?.historyItem.id, vm?.historyItem.references?.map(ref => ref.name).join(', ')].filter(Boolean).join(' · ') : undefined;
			const parent = this.model.tree.getParentNodeLocation(element);
			const id = this.model.identity.getId(element);
			const decoration = change ? this.decorations.getDecoration(element.historyItemChange.uri, false) : undefined;
			const status = decoration?.badgeText, statusColor = decoration?.color;
			decoration?.dispose();
			return [{ id, parentId: parent ? this.model.identity.getId(parent) : undefined,
				status, statusColor, kind: commit ? 'history-commit' : more ? 'history-more' : 'history-change',
				resource: change ? element.historyItemChange.uri.toString() : folder ? element.uri.toString() : undefined,
				isDirectory: folder, expandable: node.collapsible, expanded: node.collapsible && !node.collapsed,
				selected: id === this.model.selectedId, focused: id === this.model.selectedId,
				graph: { width: geometry.width, height: geometry.height, shapes: geometry.shapes.map(shape => ({
					...shape, d: undefined, commands: shape.d ? scmHistoryGraphPathCommands(shape.d) : undefined,
					color: color(shape.color), fill: shape.kind === 'circle' ? color(shape.fill) : undefined })) },
				detail: details,
				render: { root: {}, runs: commit ? [
					{ text: label, style: { bold: vm?.kind === 'HEAD' } },
					{ text: `  ${vm?.historyItem.author ?? ''} · ${vm?.historyItem.displayId ?? vm?.historyItem.id}`, style: { fg: color('descriptionForeground') } },
					...(vm?.historyItem.references ?? []).map(ref => ({ text: `  ${ref.name}`, style: { fg: color(ref.color ?? 'foreground') } }))
				] : [{ text: label, style: {} }], accessibleLabel: details ? `${label}, ${details}` : label } }];
		});
		return { outlineRows, history: { graphWidth: outlineRows.reduce((width, row) => Math.max(width, row.graph.width), 22), repository: repository?.provider.name ?? 'No repository',
			refs: Array.isArray(filter) ? filter.map(ref => ref.name).join(', ') : filter === 'all' ? 'All' : 'Auto',
			loading: this.model.loading, pageOnScroll: this.configuration.getValue('scm.graph.pageOnScroll') === true, viewMode: this.viewModel.viewMode.get(), enabled: !!repository?.provider.historyProvider.get() } };
	}
	private async control(id: string): Promise<void> {
		const repository = this.viewModel.repository.get();
		if (id === 'page') { if (this.visible && !this.model.loading && this.viewModel.hasMoreHistoryItems()) { await this.model.refresh(false); } }
		else if (id === 'refresh') { await this.model.refresh(); }
		else if (id === 'repository') {
			const result = await this.instantiation.createInstance(RepositoryPicker, 'Select repository', 'Show the graph for the active repository').pickRepository();
			if (result && !this._store.isDisposed) { this.viewModel.setRepository(result.repository); }
		} else if (id === 'refs') {
			const provider = repository?.provider.historyProvider.get(), filter = this.viewModel.getHistoryItemsFilter();
			if (!provider || !filter) { return; }
			const picker = this._register(this.instantiation.createInstance(HistoryItemRefPicker, provider, filter));
			const result = await picker.pickHistoryItemRef();
			if (result && !this._store.isDisposed && repository === this.viewModel.repository.get()) { this.viewModel.setHistoryItemsFilter(result); }
		} else if (id === 'mode') { this.viewModel.setViewMode(this.viewModel.viewMode.get() === ViewMode.Tree ? ViewMode.List : ViewMode.Tree); }
		else if (id === 'head') {
			const ref = repository?.provider.historyProvider.get()?.historyItemRef.get();
			const filter = this.viewModel.getHistoryItemsFilter();
			if (!ref?.revision || (Array.isArray(filter) && !filter.some(item => item.id === ref.id))) { return; }
			let head = this.viewModel.getCurrentHistoryItemTreeElement();
			if (!head) { await this.model.refresh(false, ref.revision); head = this.viewModel.getCurrentHistoryItemTreeElement(); }
			if (head && !this._store.isDisposed && repository === this.viewModel.repository.get()) { this.model.selectedId = this.model.identity.getId(head); this.publish(); }
		}
	}
	dispatch(payload: any): boolean {
		if (this._store.isDisposed) { return false; }
		if (payload.eventType === 'history-action') { this.run(this.control(payload.id)); return true; }
		const element = typeof payload.id === 'string' ? this.model.get(payload.id) : undefined;
		if (!element) { return false; }
		if (payload.eventType === 'outline-focus') { this.model.selectedId = payload.id; return true; }
		if (payload.eventType === 'outline-context-menu') { this.contextMenu(element, payload.anchor); return true; }
		if (payload.eventType !== 'outline-open' && payload.eventType !== 'outline-toggle') { return false; }
		this.model.selectedId = payload.id;
		if (isSCMHistoryItemLoadMoreTreeElement(element)) { if (!this.model.loading) { void this.model.refresh(false); } }
		else if (isSCMHistoryItemChangeViewModelTreeElement(element)) { this.run(openSCMHistoryChange(this.editors, element, { preserveFocus: true })); }
		else { void this.model.toggle(payload.id, payload.eventType === 'outline-toggle' ? payload.expanded : undefined); }
		return true;
	}
	private contextMenu(element: TreeElement, anchor: { x: number; y: number }): void {
		if (!Number.isFinite(anchor?.x) || !Number.isFinite(anchor?.y)) { return; }
		const actions: Action[] = [];
		const action = (id: string, label: string, run: () => Promise<unknown>) => actions.push(new Action(id, label, undefined, true, async () => { if (!this._store.isDisposed && this.model.get(this.model.identity.getId(element)) === element) { await run(); } }));
		if (isSCMHistoryItemViewModelTreeElement(element) && !['incoming-changes', 'outgoing-changes'].includes(element.historyItemViewModel.kind)) {
			const item = element.historyItemViewModel.historyItem;
			action('history.openChanges', 'Open All Changes', async () => {
				const comparison = await resolveSCMHistoryItemComparison(element);
				if (comparison && this.model.get(this.model.identity.getId(element)) === element) {
					await this.editors.openEditor({ label: getHistoryItemEditorTitle(item), multiDiffSource: ScmHistoryItemResolver.getMultiDiffSourceUri(element.repository.provider, comparison.historyItemId, comparison.historyItemParentId, item.displayId) });
				}
			});
			action('history.copyId', 'Copy Commit ID', () => this.clipboard.writeText(item.id));
			action('history.copyMessage', 'Copy Commit Message', () => this.clipboard.writeText(item.message));
			action('history.details', 'Commit Details', () => this.dialogs.info([item.subject, item.id, item.author, item.timestamp ? new Date(item.timestamp).toLocaleString() : '', item.message].filter(Boolean).join('\n\n')));
		} else if (isSCMHistoryItemChangeViewModelTreeElement(element)) {
			action('history.openChange', 'Open Change', () => openSCMHistoryChange(this.editors, element));
			if (element.historyItemChange.modifiedUri) {
				action('history.openFile', 'Open File at Revision', () => this.editors.openEditor({ resource: element.historyItemChange.modifiedUri, label: `${basename(element.historyItemChange.modifiedUri!)} (${element.historyItemViewModel.historyItem.displayId ?? element.historyItemViewModel.historyItem.id})` }));
			}
		}
		(this.menus as MacContextMenuService).showContextMenu({ getAnchor: () => anchor, getActions: () => actions }, anchor);
	}
}
