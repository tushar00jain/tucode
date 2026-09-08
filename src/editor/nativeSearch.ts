/* Native Search paint and input transport over the existing search model and data source. */
import { Disposable } from '../vs/base/common/lifecycle.js';
import { Emitter } from '../vs/base/common/event.js';
import { RunOnceScheduler } from '../vs/base/common/async.js';
import { isCancellationError } from '../vs/base/common/errors.js';
import { dirname } from '../vs/base/common/resources.js';
import { ObjectTreeModel } from '../vs/base/browser/ui/tree/objectTreeModel.js';
import { IObjectTreeElement, ITreeNode } from '../vs/base/browser/ui/tree/tree.js';
import { IConfigurationService } from '../vs/platform/configuration/common/configuration.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { ILabelService } from '../vs/platform/label/common/label.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import type { IDomRenderRun } from '../render/domRecords.js';
import { IWorkspaceContextService } from '../vs/platform/workspace/common/workspace.js';
import { IEditorService } from '../vs/workbench/services/editor/common/editorService.js';
import { ISearchConfigurationProperties, ViewMode } from '../vs/workbench/services/search/common/search.js';
import { QueryBuilder } from '../vs/workbench/services/search/common/queryBuilder.js';
import { RefreshTreeController, SearchViewDataSource } from '../vs/workbench/contrib/search/browser/searchView.js';
import { ISearchViewModelWorkbenchService } from '../vs/workbench/contrib/search/browser/searchTreeModel/searchViewModelWorkbenchService.js';
import { IChangeEvent, isSearchTreeFileMatch, isSearchTreeFolderMatch, isSearchTreeMatch, RenderableMatch } from '../vs/workbench/contrib/search/browser/searchTreeModel/searchTreeCommon.js';
import { searchMatchComparer } from '../vs/workbench/contrib/search/browser/searchCompare.js';
import { SearchRootController } from '../vs/workbench/contrib/search/tauri/searchRootController.js';
import { searchQueryOptions } from '../vs/workbench/contrib/search/common/searchQuery.js';
import { SearchQueryController } from '../vs/workbench/contrib/search/common/searchQueryController.js';
import { openSearchEditor } from '../vs/workbench/contrib/search/browser/searchEditor.js';
import { searchOnTypeDelay } from '../vs/workbench/contrib/search/common/searchOnType.js';
import { NativeFilterBox } from './nativeFilterBox.js';

export class NativeSearch extends Disposable {
	private readonly errors = this._register(new Emitter<unknown>());
	readonly onError = this.errors.event;
	readonly model;
	readonly root: SearchRootController<NativeFilterBox>;
	readonly source: SearchViewDataSource;
	readonly tree: ObjectTreeModel<RenderableMatch, void>;
	readonly rendered: ITreeNode<RenderableMatch, void>[] = [];
	private selected: RenderableMatch | undefined;
	private pending = Promise.resolve();
	private refreshWork = Promise.resolve();
	private readonly queryController = this._register(new SearchQueryController(newSearch => this.model.cancelSearch(newSearch), error => this.errors.fire(error)));
	private readonly refreshController: RefreshTreeController;
	private readonly pendingChanges: IChangeEvent[] = [];
	private cachedRows: ReturnType<NativeSearch['captureRows']> | undefined;
	private readonly builder: QueryBuilder;
	private readonly refreshScheduler: RunOnceScheduler;
	// Draft query and native disclosure state are local; replacement state belongs to the model.
	private readonly controls = { query: '', includes: '', excludes: '', caseSensitive: false, wholeWord: false,
		regex: false, detailsVisible: false, searching: false, message: '', revision: 0 };
	constructor(private readonly publish: () => void,
		@IInstantiationService instantiation: IInstantiationService,
		@ISearchViewModelWorkbenchService models: ISearchViewModelWorkbenchService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILabelService private readonly labels: ILabelService,
		@IEditorService private readonly editors: IEditorService,
		@IThemeService private readonly theme: IThemeService) {
		super();
		this.model = models.searchModel;
		this.builder = instantiation.createInstance(QueryBuilder);
		this.source = instantiation.createInstance(SearchViewDataSource, {
			model: this.model, shouldShowAIResults: () => false, cachedResults: undefined, _pendingSemanticSearchPromise: undefined,
			addAIResults: async () => {}, get isTreeLayoutViewVisible() { return configuration.getValue<ISearchConfigurationProperties>('search').defaultViewMode === ViewMode.Tree; }
		});
		this.root = this._register(new SearchRootController(() => ({
			updateChildren: () => this.rebuild(), getFocus: () => this.selected ? [this.selected] : [],
			setFocus: rows => { this.selected = rows[0]; this.rowsChanged(); }, reveal() {}, domFocus() {},
			navigate: () => { let index = 0; return { next: () => this.rendered[index++]?.element ?? null }; }
		}), labels, () => new NativeFilterBox(), () => this.changed(), work => { void this.queue(work); }));
		this.tree = new ObjectTreeModel('Mac Search', { filter: this.root.filter, identityProvider: { getId: row => row.id() } });
		this._register(this.tree.onDidSpliceRenderedNodes(e => this.rendered.splice(e.start, e.deleteCount, ...e.elements as ITreeNode<RenderableMatch, void>[])));
		this.refreshController = this._register(instantiation.createInstance(RefreshTreeController, {
			model: this.model, rootController: this.root,
			getControl: () => ({
				updateChildren: element => this.queue(() => this.rebuild(element)),
				hasNode: element => this.tree.has(element),
				rerender: () => this.rowsChanged(),
				cancelAllRefreshPromises() {}
			})
		}, () => this.config));
		this.refreshScheduler = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 80));
		this._register(this.model.onSearchResultChanged(event => { this.pendingChanges.push(event); this.scheduleRefresh(); }));
		this._register(this.model.onReplaceTermChanged(() => this.scheduleRefresh()));
		this._register(configuration.onDidChangeConfiguration(e => { if (e.affectsConfiguration('search')) { this.pendingChanges.length = 0; void this.refresh(); } }));
		this._register(theme.onDidColorThemeChange(() => this.rowsChanged()));
	}
	private rowsChanged(): void { this.cachedRows = undefined; this.changed(); }
	private changed(): void { if (!this._store.isDisposed) { this.publish(); } }
	private scheduleRefresh(): void { if (!this.refreshScheduler.isScheduled()) { this.refreshScheduler.schedule(); } }
	private get config(): ISearchConfigurationProperties { return this.configuration.getValue<ISearchConfigurationProperties>('search'); }
	private queue(work: () => Promise<void>): Promise<void> {
		this.pending = this.pending.then(async () => { if (!this._store.isDisposed) { await work(); } }).catch(error => { if (!this._store.isDisposed) { this.errors.fire(error); } });
		return this.pending;
	}
	refresh(): Promise<void> {
		this.refreshScheduler.cancel();
		const changes = this.pendingChanges.splice(0);
		return this.refreshWork = this.refreshController.queue(changes.length ? changes : undefined);
	}
	async whenSettled(): Promise<void> {
		let work: Promise<void>;
		await this.queryController.whenSettled();
		if (this.refreshScheduler.isScheduled()) { await this.refresh(); }
		await this.root.whenSettled();
		do { work = this.refreshWork; await work; await this.pending; } while (work !== this.refreshWork);
	}
	private requestSearch(onType = false): void {
		try {
			const delay = onType ? searchOnTypeDelay(this.controls.query, this.controls.regex, this.config.searchOnTypeDebouncePeriod) : 0;
			this.queryController.trigger(delay, version => this.search(version));
		} catch {
			// Match SearchWidget: do not submit an incomplete regex while typing.
			this.queryController.cancel();
			this.controls.searching = false;
			this.changed();
		}
	}
	private async rebuild(parent?: RenderableMatch): Promise<void> {
		const version = this.queryController.currentVersion;
		this.root.invalidate();
		// AsyncDataTree's lazy branch policy: collapsed items become stale and are
		// fetched on expansion. Do not materialize their match leaves for native paint.
		const visit = async (element: RenderableMatch): Promise<IObjectTreeElement<RenderableMatch>> => {
			const collapsible = !isSearchTreeMatch(element);
			const collapsed = this.tree.getNodeByIdentity(element.id())?.collapsed ?? (collapsible &&
				(this.config.collapseResults === 'alwaysCollapse' || (element.count() > 10 && this.config.collapseResults !== 'alwaysExpand')));
			return { element, collapsible, collapsed,
				children: collapsible && !collapsed && this.source.hasChildren(element)
					? await Promise.all(Array.from(await this.source.getChildren(element), visit)) : undefined };
		};
		if (parent && (!this.tree.has(parent) || this.tree.isCollapsed(parent))) {
			if (this.root.input.isOpen) { this.tree.refilter(); }
			this.rowsChanged(); return;
		}
		const children = await Promise.all(Array.from(await this.source.getChildren(parent ?? this.model.searchResult), visit));
		if (!this.queryController.isCurrent(version)) { return; }
		this.tree.setChildren(parent ?? null, children);
		if (parent && this.root.input.isOpen) { this.tree.refilter(); }
		if (this.selected && !this.tree.has(this.selected)) { this.selected = this.rendered[0]?.element; }
		this.rowsChanged();
	}

	private search(version: number): Promise<void> {
		return this.queryController.enqueue(version, async () => {
			this.controls.searching = !!this.controls.query;
			this.controls.message = '';
			this.changed();
			try {
				if (!this.controls.query) { this.model.searchResult.clear(); }
				else {
					const content = { pattern: this.controls.query, isRegExp: this.controls.regex,
						isCaseSensitive: this.controls.caseSensitive, isWordMatch: this.controls.wholeWord };
					const query = this.builder.text(content, this.workspace.getWorkspace().folders.map(folder => folder.uri),
						searchQueryOptions(content, this.config, this.controls.includes || undefined,
							this.controls.excludes ? [{ pattern: this.controls.excludes }] : undefined));
					await this.model.search(query, () => { if (this.queryController.isCurrent(version)) { this.scheduleRefresh(); } }).asyncResults;
				}
			} catch (error) {
				if (!this.queryController.isCurrent(version)) { return; }
				if (!isCancellationError(error)) { this.controls.message = error instanceof Error ? error.message : String(error); this.model.searchResult.clear(); }
			}
			if (!this.queryController.isCurrent(version)) { return; }
			this.controls.searching = false;
			await this.refresh();
		});
	}

	get snapshot() {
		const count = this.model.searchResult.count();
		return { filter: this.root.input.snapshot, search: { ...this.controls, replace: this.model.replaceString,
			preserveCase: this.model.preserveCase, replaceVisible: this.model.isReplaceActive(),
			message: this.controls.message || (this.controls.query ? `${count} results in ${this.model.searchResult.fileCount()} files` : '') },
			outlineRows: this.cachedRows ??= this.captureRows() };
	}
	private captureRows() {
		return this.rendered.map(node => {
				const row = node.element;
				const parent = this.tree.getParentNodeLocation(row);
				const match = isSearchTreeMatch(row);
				const label = match ? `${row.range().startLineNumber}: ${row.text()}` : isSearchTreeFileMatch(row) ? `${row.name()} (${row.count()})${this.config.defaultViewMode !== ViewMode.Tree ? `  ${this.labels.getUriLabel(dirname(row.resource), { relative: true })}` : ''}`
					: isSearchTreeFolderMatch(row) ? `${row.name()} (${row.count()})` : 'Search results';
				return { id: row.id(), parentId: parent?.id(), resource: (match ? row.parent().resource : isSearchTreeFileMatch(row) || isSearchTreeFolderMatch(row) ? row.resource : undefined)?.toString(),
					isDirectory: !match && !isSearchTreeFileMatch(row), kind: match ? 'search-match' : undefined,
					expandable: node.collapsible, expanded: node.collapsible && !node.collapsed, selected: row === this.selected, focused: row === this.selected,
					render: { root: {}, runs: match ? this.matchRuns(row) : [{ text: label, style: {} }], accessibleLabel: label } };
			});
	}
	private matchRuns(row: RenderableMatch): IDomRenderRun[] {
		if (!isSearchTreeMatch(row)) { return []; }
		const preview = row.preview();
		const replace = this.model.isReplaceActive() && !!this.model.replaceString && !row.isReadonly;
		const theme = this.theme.getColorTheme();
		const extra = row.range().endLineNumber - row.range().startLineNumber;
		const line = `${this.config.showLineNumbers ? `${row.range().startLineNumber}:` : ''}${extra > 0 ? `+${extra}` : ''}`;
		return [
			{ text: line ? `${line} ` : '', style: { fg: theme.getColor('search.resultsInfoForeground') } },
			{ text: preview.before, style: {} },
			{ text: preview.inside, style: { bg: theme.getColor(replace ? 'diffEditor.removedTextBackground' : 'editor.findMatchHighlightBackground'), strikethrough: replace } },
			...(replace ? [{ text: row.replaceString, style: { bg: theme.getColor('diffEditor.insertedTextBackground') } }] : []),
			{ text: preview.after, style: {} }
		];
	}
	dispatch(payload: any): boolean {
		if (this._store.isDisposed) { return false; }
		if (this.root.input.dispatch(this.root, 'search', payload)) { return true; }
		const field = ({ 'search-query-change': 'query', 'search-replace-change': 'replace', 'search-includes-change': 'includes', 'search-excludes-change': 'excludes' } as const)[payload.eventType as string];
		if (field && typeof payload.value === 'string') {
			this.controls.revision = payload.revision ?? this.controls.revision + 1;
			if (field === 'replace') { this.model.replaceString = payload.value; void this.refresh(); }
			else { this.controls[field] = payload.value; if (this.config.searchOnType) { this.requestSearch(true); } }
			this.changed(); return true;
		}
		const toggle = ({ 'search-toggle-case': 'caseSensitive', 'search-toggle-word': 'wholeWord', 'search-toggle-regex': 'regex',
			'search-toggle-preserve-case': 'preserveCase', 'search-toggle-replace': 'replaceVisible', 'search-toggle-details': 'detailsVisible' } as const)[payload.eventType as string];
		if (toggle) {
			if (toggle === 'replaceVisible') { this.model.replaceActive = !this.model.isReplaceActive(); }
			else if (toggle === 'preserveCase') { this.model.preserveCase = !this.model.preserveCase; }
			else { this.controls[toggle] = !this.controls[toggle]; }
			if (toggle === 'caseSensitive' || toggle === 'wholeWord' || toggle === 'regex') { this.requestSearch(); }
			else { void this.refresh(); } return true;
		}
		if (payload.eventType === 'search-submit') { this.requestSearch(); return true; }
		if (payload.eventType === 'search-focus-results') { this.changed(); return true; }
		const row = typeof payload.id === 'string' ? this.rendered.find(node => node.element.id() === payload.id)?.element : this.selected;
		if (!row) { return false; }
		if (payload.eventType === 'outline-focus') { this.selected = row; this.cachedRows = undefined; return true; }
		if (payload.eventType === 'outline-toggle') {
			void this.queue(async () => {
				if (!this.tree.has(row)) { return; }
				this.tree.setCollapsed(row, !payload.expanded);
				if (payload.expanded) { await this.rebuild(row); } else { this.rowsChanged(); }
			}); return true;
		}
		if (payload.eventType === 'search-replace-selected') { void this.queue(async () => { await this.model.searchResult.batchReplace([row]); await this.rebuild(); }); return true; }
		if (payload.eventType === 'outline-open') {
			const match = isSearchTreeMatch(row) ? row : isSearchTreeFileMatch(row) ? row.matches().sort(searchMatchComparer)[0] : undefined;
			if (match) { void this.queue(async () => { await openSearchEditor(this.editors, this.model, match, { preserveFocus: true, pinned: true }); }); }
			return true;
		}
		return false;
	}
}
