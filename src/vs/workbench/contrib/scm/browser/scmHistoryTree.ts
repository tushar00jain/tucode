/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Model-side history tree and pickers restored from the local vendor branch.
import { IIdentityProvider } from '../../../../base/browser/ui/list/list.js';
import { IAsyncDataSource } from '../../../../base/browser/ui/tree/tree.js';
import { ITreeCompressionDelegate } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IResourceNode, ResourceTree } from '../../../../base/common/resourceTree.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { delta, groupBy } from '../../../../base/common/arrays.js';
import { compare } from '../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ViewMode } from '../common/scm.js';
import { ISCMHistoryItemRef, ISCMHistoryProvider, SCMHistoryItemChangeViewModelTreeElement, SCMHistoryItemLoadMoreTreeElement, SCMHistoryItemViewModelTreeElement, SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId } from '../common/history.js';
import { isSCMRepository, isSCMHistoryItemViewModelTreeElement, isSCMHistoryItemChangeViewModelTreeElement, isSCMHistoryItemChangeNode, isSCMHistoryItemLoadMoreTreeElement } from './util.js';
import { SCMHistoryViewModel } from './scmHistoryViewPane.js';

export type TreeElement = SCMHistoryItemViewModelTreeElement | SCMHistoryItemLoadMoreTreeElement | SCMHistoryItemChangeViewModelTreeElement | IResourceNode<SCMHistoryItemChangeViewModelTreeElement, SCMHistoryItemViewModelTreeElement>;

export class SCMHistoryTreeIdentityProvider implements IIdentityProvider<TreeElement> {

	getId(element: TreeElement): string {
		if (isSCMRepository(element)) {
			const provider = element.provider;
			return `repo:${provider.id}`;
		} else if (isSCMHistoryItemViewModelTreeElement(element)) {
			const provider = element.repository.provider;
			const historyItem = element.historyItemViewModel.historyItem;
			return `historyItem:${provider.id}/${historyItem.id}/${historyItem.parentIds.join(',')}`;
		} else if (isSCMHistoryItemChangeViewModelTreeElement(element)) {
			const provider = element.repository.provider;
			const historyItem = element.historyItemViewModel.historyItem;
			return `historyItemChange:${provider.id}/${historyItem.id}/${historyItem.parentIds.join(',')}/${element.historyItemChange.uri.fsPath}`;
		} else if (isSCMHistoryItemChangeNode(element)) {
			const provider = element.context.repository.provider;
			const historyItem = element.context.historyItemViewModel.historyItem;
			return `historyItemChangeFolder:${provider.id}/${historyItem.id}/${historyItem.parentIds.join(',')}/${element.uri.fsPath}`;
		} else if (isSCMHistoryItemLoadMoreTreeElement(element)) {
			const provider = element.repository.provider;
			return `historyItemLoadMore:${provider.id}`;
		} else {
			throw new Error('Invalid tree element');
		}
	}
}

export class SCMHistoryTreeCompressionDelegate implements ITreeCompressionDelegate<TreeElement> {

	isIncompressible(element: TreeElement): boolean {
		if (ResourceTree.isResourceNode(element)) {
			return element.childrenCount === 0 || !element.parent || !element.parent.parent;
		}

		return true;
	}
}

export class SCMHistoryTreeDataSource extends Disposable implements IAsyncDataSource<SCMHistoryViewModel, TreeElement> {
	constructor(private readonly viewMode: () => ViewMode) {
		super();
	}

	async getChildren(inputOrElement: SCMHistoryViewModel | TreeElement): Promise<Iterable<TreeElement>> {
		const children: TreeElement[] = [];

		if (inputOrElement instanceof SCMHistoryViewModel) {
			// History items
			const historyItems = await inputOrElement.getHistoryItems();
			children.push(...historyItems);

			// Load More element
			const repository = inputOrElement.repository.get();
			const lastHistoryItem = historyItems.at(-1);
			if (repository && lastHistoryItem && inputOrElement.hasMoreHistoryItems() && lastHistoryItem.historyItemViewModel.outputSwimlanes.length > 0) {
				children.push({
					repository,
					graphColumns: lastHistoryItem.historyItemViewModel.outputSwimlanes,
					type: 'historyItemLoadMore'
				} satisfies SCMHistoryItemLoadMoreTreeElement);
			}
		} else if (isSCMHistoryItemViewModelTreeElement(inputOrElement)) {
			// History item changes
			const historyProvider = inputOrElement.repository.provider.historyProvider.get();
			const comparison = await resolveSCMHistoryItemComparison(inputOrElement);
			if (!comparison) { return []; }
			const { historyItemId, historyItemParentId } = comparison;

			const historyItemChanges = await historyProvider?.provideHistoryItemChanges(historyItemId, historyItemParentId) ?? [];

			if (this.viewMode() === ViewMode.List) {
				// List
				children.push(...historyItemChanges.map(change => ({
					repository: inputOrElement.repository,
					historyItemViewModel: inputOrElement.historyItemViewModel,
					historyItemChange: change,
					graphColumns: inputOrElement.historyItemViewModel.outputSwimlanes,
					type: 'historyItemChangeViewModel'
				} satisfies SCMHistoryItemChangeViewModelTreeElement)));
			} else if (this.viewMode() === ViewMode.Tree) {
				// Tree
				const rootUri = inputOrElement.repository.provider.rootUri ?? URI.file('/');
				const historyItemChangesTree = new ResourceTree<SCMHistoryItemChangeViewModelTreeElement, SCMHistoryItemViewModelTreeElement>(inputOrElement, rootUri);
				for (const change of historyItemChanges) {
					historyItemChangesTree.add(change.uri, {
						repository: inputOrElement.repository,
						historyItemViewModel: inputOrElement.historyItemViewModel,
						historyItemChange: change,
						graphColumns: inputOrElement.historyItemViewModel.outputSwimlanes,
						type: 'historyItemChangeViewModel'
					});
				}
				for (const node of historyItemChangesTree.root.children) {
					children.push(node.element ?? node);
				}
			}
		} else if (ResourceTree.isResourceNode(inputOrElement) && isSCMHistoryItemChangeNode(inputOrElement)) {
			// Tree
			for (const node of inputOrElement.children) {
				children.push(node.element && node.childrenCount === 0 ? node.element : node);
			}
		}

		return children;
	}

	hasChildren(inputOrElement: SCMHistoryViewModel | TreeElement): boolean {
		return inputOrElement instanceof SCMHistoryViewModel ||
			isSCMHistoryItemViewModelTreeElement(inputOrElement) ||
			(isSCMHistoryItemChangeNode(inputOrElement) && inputOrElement.childrenCount > 0);
	}
}

type HistoryItemRefsFilter = 'all' | 'auto' | string[];
type HistoryItemRefQuickPickItem = IQuickPickItem & { historyItemRef: 'all' | 'auto' | ISCMHistoryItemRef };

export class HistoryItemRefPicker extends Disposable {
	private readonly _allQuickPickItem: HistoryItemRefQuickPickItem = {
		id: 'all',
		label: localize('all', "All"),
		description: localize('allHistoryItemRefs', "All history item references"),
		historyItemRef: 'all'
	};

	private readonly _autoQuickPickItem: HistoryItemRefQuickPickItem = {
		id: 'auto',
		label: localize('auto', "Auto"),
		description: localize('currentHistoryItemRef', "Current history item reference(s)"),
		historyItemRef: 'auto'
	};

	constructor(
		private readonly _historyProvider: ISCMHistoryProvider,
		private readonly _historyItemsFilter: 'all' | 'auto' | ISCMHistoryItemRef[],
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super();
	}

	async pickHistoryItemRef(): Promise<HistoryItemRefsFilter | undefined> {
		const quickPick = this._quickInputService.createQuickPick<HistoryItemRefQuickPickItem>({ useSeparators: true });
		this._store.add(quickPick);

		quickPick.placeholder = localize('scmGraphHistoryItemRef', "Select one/more history item references to view, type to filter");
		quickPick.canSelectMany = true;
		quickPick.hideCheckAll = true;
		quickPick.busy = true;
		quickPick.show();

		const items = await this._createQuickPickItems();
		if (this._store.isDisposed) { return undefined; }

		// Set initial selection
		let selectedItems: HistoryItemRefQuickPickItem[] = [];
		if (this._historyItemsFilter === 'all') {
			selectedItems.push(this._allQuickPickItem);
		} else if (this._historyItemsFilter === 'auto') {
			selectedItems.push(this._autoQuickPickItem);
		} else {
			let index = 0;
			while (index < items.length) {
				if (items[index].type === 'separator') {
					index++;
					continue;
				}

				if (this._historyItemsFilter.some(ref => ref.id === items[index].id)) {
					const item = items.splice(index, 1) as HistoryItemRefQuickPickItem[];
					selectedItems.push(...item);
				} else {
					index++;
				}
			}

			// Insert the selected items after `All` and `Auto`
			items.splice(2, 0, { type: 'separator' }, ...selectedItems);
		}

		quickPick.items = items;
		quickPick.selectedItems = selectedItems;
		quickPick.busy = false;

		return new Promise<HistoryItemRefsFilter | undefined>(resolve => {
			this._store.add(quickPick.onDidChangeSelection(items => {
				const { added } = delta(selectedItems, items, (a, b) => compare(a.id ?? '', b.id ?? ''));
				if (added.length > 0) {
					if (added[0].historyItemRef === 'all' || added[0].historyItemRef === 'auto') {
						quickPick.selectedItems = [added[0]];
					} else {
						// Remove 'all' and 'auto' items if present
						quickPick.selectedItems = [...quickPick.selectedItems
							.filter(i => i.historyItemRef !== 'all' && i.historyItemRef !== 'auto')];
					}
				}

				selectedItems = [...quickPick.selectedItems];
			}));

			this._store.add(quickPick.onDidAccept(() => {
				if (selectedItems.length === 0) {
					resolve(undefined);
				} else if (selectedItems.length === 1 && selectedItems[0].historyItemRef === 'all') {
					resolve('all');
				} else if (selectedItems.length === 1 && selectedItems[0].historyItemRef === 'auto') {
					resolve('auto');
				} else {
					resolve(selectedItems.map(item => (item.historyItemRef as ISCMHistoryItemRef).id));
				}

				quickPick.hide();
			}));

			this._store.add(quickPick.onDidHide(() => {
				resolve(undefined);
				this.dispose();
			}));
		});
	}

	private async _createQuickPickItems(): Promise<(HistoryItemRefQuickPickItem | IQuickPickSeparator)[]> {
		const picks: (HistoryItemRefQuickPickItem | IQuickPickSeparator)[] = [
			this._allQuickPickItem, this._autoQuickPickItem
		];

		const historyItemRefs = await this._historyProvider.provideHistoryItemRefs() ?? [];
		const historyItemRefsByCategory = groupBy(historyItemRefs, (a, b) => compare(a.category ?? '', b.category ?? ''));

		for (const refs of historyItemRefsByCategory) {
			if (refs.length === 0) {
				continue;
			}

			picks.push({ type: 'separator', label: refs[0].category });

			picks.push(...refs.map(ref => {
				return {
					id: ref.id,
					label: ref.name,
					description: ref.description,
					iconClass: ThemeIcon.isThemeIcon(ref.icon) ?
						ThemeIcon.asClassName(ref.icon) : undefined,
					historyItemRef: ref
				};
			}));
		}

		return picks;
	}
}


/** The browser history pane's single-file historical editor behavior. */
export async function openSCMHistoryChange(editorService: IEditorService, element: SCMHistoryItemChangeViewModelTreeElement, options?: IEditorOptions): Promise<void> {
	const historyItemChange = element.historyItemChange;
	const historyItem = element.historyItemViewModel.historyItem;
	const historyItemDisplayId = historyItem.id === SCMIncomingHistoryItemId
		? localize('incomingChanges', "Incoming Changes")
		: historyItem.id === SCMOutgoingHistoryItemId
			? localize('outgoingChanges', "Outgoing Changes")
			: historyItem.displayId ?? historyItem.id;

	const historyItemParentId = historyItem.parentIds.length > 0 ? historyItem.parentIds[0] : undefined;
	const historyItemParentDisplayId = historyItemParentId && historyItem.displayId
		? historyItemParentId.substring(0, historyItem.displayId.length)
		: historyItemParentId;

	if (historyItemChange.originalUri && historyItemChange.modifiedUri) {
		// Diff Editor
		const originalUriTitle = `${basename(historyItemChange.originalUri.fsPath)} (${historyItemParentDisplayId})`;
		const modifiedUriTitle = `${basename(historyItemChange.modifiedUri.fsPath)} (${historyItemDisplayId})`;

		const title = `${originalUriTitle} \u2194 ${modifiedUriTitle}`;
		await editorService.openEditor({
			label: title,
			original: { resource: historyItemChange.originalUri },
			modified: { resource: historyItemChange.modifiedUri },
			options
		});
	} else if (historyItemChange.modifiedUri) {
		await editorService.openEditor({
			label: `${basename(historyItemChange.modifiedUri.fsPath)} (${historyItemDisplayId})`,
			resource: historyItemChange.modifiedUri,
			options
		});
	} else if (historyItemChange.originalUri) {
		// Editor (Deleted)
		await editorService.openEditor({
			label: `${basename(historyItemChange.originalUri.fsPath)} (${historyItemParentDisplayId})`,
			resource: historyItemChange.originalUri,
			options
		});
	}
}

/** Includes upstream incoming/outgoing and synthetic-parent comparison rules. */
export async function resolveSCMHistoryItemComparison(element: SCMHistoryItemViewModelTreeElement): Promise<{ historyItemId: string; historyItemParentId: string | undefined } | undefined> {
	const historyProvider = element.repository.provider.historyProvider.get();
	const historyItemViewModel = element.historyItemViewModel;
	const historyItem = historyItemViewModel.historyItem;

	let historyItemId: string, historyItemParentId: string | undefined;

	if (
		historyItemViewModel.kind === 'incoming-changes' ||
		historyItemViewModel.kind === 'outgoing-changes'
	) {
		// Incoming/Outgoing changes history item
		const historyItemRef = historyProvider?.historyItemRef.get();
		const historyItemRemoteRef = historyProvider?.historyItemRemoteRef.get();

		if (!historyProvider || !historyItemRef || !historyItemRemoteRef) {
			return undefined;
		}

		historyItemId = historyItemViewModel.kind === 'incoming-changes'
			? historyItemRemoteRef.id
			: historyItemRef.id;

		historyItemParentId = await historyProvider.resolveHistoryItemRefsCommonAncestor([
			historyItemRef.name,
			historyItemRemoteRef.name]);
	} else {
		// History item
		historyItemId = historyItem.id;

		if (historyItem.parentIds.length > 0) {
			// History item right above the incoming changes history item
			if (historyItem.parentIds[0] === SCMIncomingHistoryItemId) {
				const historyItemRef = historyProvider?.historyItemRef.get();
				const historyItemRemoteRef = historyProvider?.historyItemRemoteRef.get();

				if (!historyProvider || !historyItemRef || !historyItemRemoteRef) {
					return undefined;
				}

				historyItemParentId = await historyProvider.resolveHistoryItemRefsCommonAncestor([
					historyItemRef.name,
					historyItemRemoteRef.name]);
			} else {
				historyItemParentId = historyItem.parentIds[0];
			}
		}
	}

	return { historyItemId, historyItemParentId };
}
