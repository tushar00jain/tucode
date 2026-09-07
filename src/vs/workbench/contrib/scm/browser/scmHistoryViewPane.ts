/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived, IObservable, ISettableObservable, latestChangedValue, observableFromEvent, observableSignal, observableValue } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';
import { toISCMHistoryItemViewModelArray } from './scmHistory.js';
import { getProviderKey } from './util.js';
import { ISCMHistoryItemRef, ISCMHistoryProvider, SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { ISCMRepository, ISCMService, ISCMViewService, ViewMode } from '../common/scm.js';
import { ContextKeys } from './scmViewPane.js';
import { Event } from '../../../../base/common/event.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { clamp } from '../../../../base/common/numbers.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';

type HistoryItemRefsFilter = 'all' | 'auto' | string[];

type RepositoryState = {
	viewModels: SCMHistoryItemViewModelTreeElement[];
	historyItemsFilter: ISCMHistoryItemRef[];
	mergeBase: string | undefined;
	loadMore: boolean | string;
};

export class SCMHistoryViewModel extends Disposable {
	readonly viewMode: ISettableObservable<ViewMode>;

	/**
	 * The active | selected repository takes precedence over the first repository when the observable
	 * values are updated in the same transaction (or during the initial read of the observable value).
	 */
	readonly repository: IObservable<ISCMRepository | undefined>;
	private readonly _selectedRepository = observableValue<'auto' | ISCMRepository>(this, 'auto');

	readonly onDidChangeHistoryItemsFilter = observableSignal(this);
	readonly isViewModelEmpty = observableValue(this, false);

	private readonly _repositoryState = new Map<ISCMRepository, RepositoryState>();
	private readonly _repositoryFilterState = new Map<string, HistoryItemRefsFilter>();

	private readonly _scmHistoryItemCountCtx: IContextKey<number>;
	private readonly _scmHistoryViewModeCtx: IContextKey<ViewMode>;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ISCMService private readonly _scmService: ISCMService,
		@ISCMViewService private readonly _scmViewService: ISCMViewService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		this._repositoryFilterState = this._loadHistoryItemsFilterState();
		this.viewMode = observableValue<ViewMode>(this, this._getViewMode());

		this._extensionService.onWillStop(this._saveHistoryItemsFilterState, this, this._store);
		this._storageService.onWillSaveState(this._saveHistoryItemsFilterState, this, this._store);

		this._scmHistoryItemCountCtx = ContextKeys.SCMHistoryItemCount.bindTo(this._contextKeyService);
		this._scmHistoryViewModeCtx = ContextKeys.SCMHistoryViewMode.bindTo(this._contextKeyService);
		this._scmHistoryViewModeCtx.set(this.viewMode.get());

		const firstRepository = this._scmService.repositoryCount > 0
			? constObservable(Iterable.first(this._scmService.repositories))
			: observableFromEvent(this,
				Event.once(this._scmService.onDidAddRepository),
				repository => repository);

		const graphRepository = derived(reader => {
			const selectedRepository = this._selectedRepository.read(reader);
			if (selectedRepository !== 'auto') {
				return selectedRepository;
			}

			return this._scmViewService.activeRepository.read(reader)?.repository;
		});

		this.repository = latestChangedValue(this, [firstRepository, graphRepository]);

		const closedRepository = observableFromEvent(this,
			this._scmService.onDidRemoveRepository,
			repository => repository);

		// Closed repository cleanup
		this._register(autorun(reader => {
			const repository = closedRepository.read(reader);
			if (!repository) {
				return;
			}

			if (this.repository.read(undefined) === repository) {
				this._selectedRepository.set(Iterable.first(this._scmService.repositories) ?? 'auto', undefined);
			}

			this._repositoryState.delete(repository);
		}));
	}

	clearRepositoryState(): void {
		const repository = this.repository.get();
		if (!repository) {
			return;
		}

		this._repositoryState.delete(repository);
	}

	getHistoryItemsFilter(): 'all' | 'auto' | ISCMHistoryItemRef[] | undefined {
		const repository = this.repository.get();
		if (!repository) {
			return;
		}

		const filterState = this._repositoryFilterState.get(getProviderKey(repository.provider)) ?? 'auto';
		if (filterState === 'all' || filterState === 'auto') {
			return filterState;
		}

		const repositoryState = this._repositoryState.get(repository);
		return repositoryState?.historyItemsFilter;
	}

	getCurrentHistoryItemTreeElement(): SCMHistoryItemViewModelTreeElement | undefined {
		const repository = this.repository.get();
		if (!repository) {
			return undefined;
		}

		const state = this._repositoryState.get(repository);
		if (!state) {
			return undefined;
		}

		const historyProvider = repository?.provider.historyProvider.get();
		const historyItemRef = historyProvider?.historyItemRef.get();

		return state.viewModels
			.find(viewModel => viewModel.historyItemViewModel.historyItem.id === historyItemRef?.revision);
	}

	loadMore(cursor?: string): void {
		const repository = this.repository.get();
		if (!repository) {
			return;
		}

		const state = this._repositoryState.get(repository);
		if (!state) {
			return;
		}

		this._repositoryState.set(repository, { ...state, loadMore: cursor ?? true });
	}

	async getHistoryItems(): Promise<SCMHistoryItemViewModelTreeElement[]> {
		const repository = this.repository.get();
		const historyProvider = repository?.provider.historyProvider.get();
		const historyItemRef = historyProvider?.historyItemRef.get();
		const historyItemRemoteRef = historyProvider?.historyItemRemoteRef.get();

		if (!repository || !historyProvider) {
			this._scmHistoryItemCountCtx.set(0);
			this.isViewModelEmpty.set(true, undefined);
			return [];
		}

		let state = this._repositoryState.get(repository);

		if (!state || state.loadMore !== false) {
			const historyItems = state?.viewModels
				.filter(vm =>
					vm.historyItemViewModel.kind !== 'incoming-changes' &&
					vm.historyItemViewModel.kind !== 'outgoing-changes')
				.map(vm => vm.historyItemViewModel.historyItem) ?? [];

			const historyItemRefs = state?.historyItemsFilter ??
				await this._resolveHistoryItemFilter(repository, historyProvider);

			const limit = clamp(this._configurationService.getValue<number>('scm.graph.pageSize'), 1, 1000);
			const historyItemRefIds = historyItemRefs.map(ref => ref.revision ?? ref.id);

			do {
				// Fetch the next page of history items
				historyItems.push(...(await historyProvider.provideHistoryItems({
					historyItemRefs: historyItemRefIds, limit, skip: historyItems.length
				}) ?? []));
			} while (typeof state?.loadMore === 'string' && !historyItems.find(item => item.id === state?.loadMore));

			// Compute the merge base
			const mergeBase = historyItemRef && historyItemRemoteRef && state?.mergeBase === undefined
				? await historyProvider.resolveHistoryItemRefsCommonAncestor([
					historyItemRef.name,
					historyItemRemoteRef.name])
				: state?.mergeBase;

			// Create the color map
			const colorMap = this._getGraphColorMap(historyItemRefs);

			// Only show incoming changes node if the remote history item reference is part of the graph
			const addIncomingChangesNode = this._scmViewService.graphShowIncomingChangesConfig.get()
				&& historyItemRefs.some(ref => ref.id === historyItemRemoteRef?.id);

			// Only show outgoing changes node if the history item reference is part of the graph
			const addOutgoingChangesNode = this._scmViewService.graphShowOutgoingChangesConfig.get()
				&& historyItemRefs.some(ref => ref.id === historyItemRef?.id);

			const viewModels = toISCMHistoryItemViewModelArray(
				historyItems,
				colorMap,
				historyProvider.historyItemRef.get(),
				historyProvider.historyItemRemoteRef.get(),
				historyProvider.historyItemBaseRef.get(),
				addIncomingChangesNode,
				addOutgoingChangesNode,
				mergeBase)
				.map(historyItemViewModel => ({
					repository,
					historyItemViewModel,
					type: 'historyItemViewModel'
				}) satisfies SCMHistoryItemViewModelTreeElement);

			state = { historyItemsFilter: historyItemRefs, viewModels, mergeBase, loadMore: false };
			this._repositoryState.set(repository, state);

			this._scmHistoryItemCountCtx.set(viewModels.length);
			this.isViewModelEmpty.set(viewModels.length === 0, undefined);
		}

		return state.viewModels;
	}

	setRepository(repository: ISCMRepository | 'auto'): void {
		this._selectedRepository.set(repository, undefined);
	}

	setHistoryItemsFilter(filter: HistoryItemRefsFilter): void {
		const repository = this.repository.get();
		if (!repository) {
			return;
		}

		if (filter !== 'auto') {
			this._repositoryFilterState.set(getProviderKey(repository.provider), filter);
		} else {
			this._repositoryFilterState.delete(getProviderKey(repository.provider));
		}
		this._saveHistoryItemsFilterState();

		this.onDidChangeHistoryItemsFilter.trigger(undefined);
	}

	setViewMode(viewMode: ViewMode): void {
		if (viewMode === this.viewMode.get()) {
			return;
		}

		this.viewMode.set(viewMode, undefined);
		this._scmHistoryViewModeCtx.set(viewMode);
		this._storageService.store('scm.graphView.viewMode', viewMode, StorageScope.WORKSPACE, StorageTarget.USER);
	}

	private _getViewMode(): ViewMode {
		let mode = this._configurationService.getValue<'tree' | 'list'>('scm.defaultViewMode') === 'list' ? ViewMode.List : ViewMode.Tree;
		const storageMode = this._storageService.get('scm.graphView.viewMode', StorageScope.WORKSPACE) as ViewMode;
		if (typeof storageMode === 'string') {
			mode = storageMode;
		}

		return mode;
	}

	private _getGraphColorMap(historyItemRefs: ISCMHistoryItemRef[]): Map<string, ColorIdentifier | undefined> {
		const repository = this.repository.get();
		const historyProvider = repository?.provider.historyProvider.get();
		const historyItemRef = historyProvider?.historyItemRef.get();
		const historyItemRemoteRef = historyProvider?.historyItemRemoteRef.get();
		const historyItemBaseRef = historyProvider?.historyItemBaseRef.get();

		const colorMap = new Map<string, ColorIdentifier | undefined>();

		if (historyItemRef) {
			colorMap.set(historyItemRef.id, historyItemRef.color);

			if (historyItemRemoteRef) {
				colorMap.set(historyItemRemoteRef.id, historyItemRemoteRef.color);
			}
			if (historyItemBaseRef) {
				colorMap.set(historyItemBaseRef.id, historyItemBaseRef.color);
			}
		}

		// Add the remaining history item references to the color map
		// if not already present. These history item references will
		// be colored using the color of the history item to which they
		// point to.
		for (const ref of historyItemRefs) {
			if (!colorMap.has(ref.id)) {
				colorMap.set(ref.id, undefined);
			}
		}

		return colorMap;
	}

	private async _resolveHistoryItemFilter(repository: ISCMRepository, historyProvider: ISCMHistoryProvider): Promise<ISCMHistoryItemRef[]> {
		const historyItemRefs: ISCMHistoryItemRef[] = [];
		const historyItemsFilter = this._repositoryFilterState.get(getProviderKey(repository.provider)) ?? 'auto';

		switch (historyItemsFilter) {
			case 'all':
				historyItemRefs.push(...(await historyProvider.provideHistoryItemRefs() ?? []));
				break;
			case 'auto':
				historyItemRefs.push(...[
					historyProvider.historyItemRef.get(),
					historyProvider.historyItemRemoteRef.get(),
					historyProvider.historyItemBaseRef.get(),
				].filter(ref => !!ref));
				break;
			default: {
				// Get the latest revisions for the history items references in the filer
				const refs = (await historyProvider.provideHistoryItemRefs(historyItemsFilter) ?? [])
					.filter(ref => historyItemsFilter.some(filter => filter === ref.id));

				if (refs.length === 0) {
					// Reset the filter
					historyItemRefs.push(...[
						historyProvider.historyItemRef.get(),
						historyProvider.historyItemRemoteRef.get(),
						historyProvider.historyItemBaseRef.get(),
					].filter(ref => !!ref));
					this._repositoryFilterState.delete(getProviderKey(repository.provider));
				} else {
					// Update filter
					historyItemRefs.push(...refs);
					this._repositoryFilterState.set(getProviderKey(repository.provider), refs.map(ref => ref.id));
				}

				this._saveHistoryItemsFilterState();

				break;
			}
		}

		return historyItemRefs;
	}

	private _loadHistoryItemsFilterState() {
		try {
			const filterData = this._storageService.get('scm.graphView.referencesFilter', StorageScope.WORKSPACE);
			if (filterData) {
				return new Map<string, HistoryItemRefsFilter>(JSON.parse(filterData));
			}
		} catch { }

		return new Map<string, HistoryItemRefsFilter>();
	}

	private _saveHistoryItemsFilterState(): void {
		const filter = Array.from(this._repositoryFilterState.entries());
		this._storageService.store('scm.graphView.referencesFilter', JSON.stringify(filter), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	override dispose(): void {
		this._repositoryState.clear();
		super.dispose();
	}
}
