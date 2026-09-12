/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CompressibleObjectTreeModel, ICompressedTreeElement } from '../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { ITreeNode } from '../../../../base/browser/ui/tree/tree.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SCMHistoryViewModel } from './scmHistoryViewPane.js';
import { SCMHistoryTreeCompressionDelegate, SCMHistoryTreeDataSource, SCMHistoryTreeIdentityProvider, TreeElement } from './scmHistoryTree.js';
import { isSCMHistoryItemChangeNode, isSCMHistoryItemViewModelTreeElement } from './util.js';

/** Lazy model-side tree over the upstream history data source. Collapsed commits never fetch changes. */
export class SCMHistoryTreeModel extends Disposable {
	readonly identity = new SCMHistoryTreeIdentityProvider();
	readonly tree = new CompressibleObjectTreeModel<TreeElement>('SCM History', { identityProvider: this.identity });
	readonly rendered: ITreeNode<TreeElement | null, void>[] = [];
	private readonly source: SCMHistoryTreeDataSource;
	private readonly compression = new SCMHistoryTreeCompressionDelegate();
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly errors = this._register(new Emitter<unknown>());
	readonly onError = this.errors.event;
	private readonly branches = new Map<string, Promise<TreeElement[]>>();
	private readonly expanded = new Set<string>();
	private readonly collapsedFolders = new Set<string>();
	private roots: TreeElement[] = [];
	private repository = this.viewModel.repository.get();
	private version = 0;
	private pending = Promise.resolve();
	selectedId: string | undefined;
	loading = false;
	constructor(readonly viewModel: SCMHistoryViewModel) {
		super();
		this.source = this._register(new SCMHistoryTreeDataSource(() => viewModel.viewMode.get()));
		this._register(this.tree.onDidSpliceRenderedNodes(e => this.rendered.splice(e.start, e.deleteCount, ...e.elements)));
	}
	get(id: string): TreeElement | undefined { return this.tree.getNodeByIdentity(id)?.element ?? undefined; }
	private valid(version: number): boolean { return !this._store.isDisposed && version === this.version; }
	private queue(work: () => Promise<void>): Promise<void> {
		this.pending = this.pending.then(work).catch(error => { if (!this._store.isDisposed) { this.errors.fire(error); } });
		return this.pending;
	}
	refresh(clear = true, cursor?: string): Promise<void> {
		const version = ++this.version;
		if (clear) {
			this.viewModel.clearRepositoryState(); this.branches.clear();
			if (this.repository !== this.viewModel.repository.get()) { this.expanded.clear(); this.collapsedFolders.clear(); this.selectedId = undefined; }
			this.repository = this.viewModel.repository.get(); this.roots = []; this.tree.setChildren(null, []);
		}
		this.loading = true; this.changed.fire();
		return this.queue(async () => {
			if (!this.valid(version)) { return; }
			try {
				if (!clear) { this.viewModel.loadMore(cursor); }
				const roots = Array.from(await this.source.getChildren(this.viewModel));
				if (!this.valid(version)) { return; }
				this.roots = roots;
				await this.rebuild(version);
			} finally { if (this.valid(version)) { this.loading = false; this.changed.fire(); } }
		});
	}
	setCompression(enabled: boolean): void { this.tree.setCompressionEnabled(enabled); this.changed.fire(); }
	setViewMode(): Promise<void> {
		return this.queue(async () => { this.branches.clear(); await this.rebuild(this.version); });
	}
	toggle(id: string, expanded?: boolean): Promise<void> {
		const element = this.get(id);
		if (!element || !this.source.hasChildren(element)) { return Promise.resolve(); }
		this.selectedId = id;
		if (expanded ?? (isSCMHistoryItemChangeNode(element) ? this.collapsedFolders.has(id) : !this.expanded.has(id))) { this.expanded.add(id); } else { this.expanded.delete(id); }
		if (isSCMHistoryItemChangeNode(element)) {
			if (this.expanded.has(id)) { this.collapsedFolders.delete(id); } else { this.collapsedFolders.add(id); }
		}
		const version = this.version;
		return this.queue(() => this.rebuild(version));
	}
	private async rebuild(version: number): Promise<void> {
		if (!this.valid(version)) { return; }
		const visit = async (element: TreeElement): Promise<ICompressedTreeElement<TreeElement>> => {
			const id = this.identity.getId(element);
			// ResourceTree folders are already in memory; only commit boundaries perform I/O.
			const open = isSCMHistoryItemChangeNode(element) ? !this.collapsedFolders.has(id) : this.expanded.has(id);
			let children: TreeElement[] = [];
			if (this.source.hasChildren(element) && (open || this.branches.has(id))) {
				let branch = this.branches.get(id);
				if (!branch) {
					branch = this.source.getChildren(element).then(children => Array.from(children));
					this.branches.set(id, branch);
					void branch.catch(() => { if (this.branches.get(id) === branch) { this.branches.delete(id); } });
				}
				children = await branch;
			}
			return { element, collapsible: this.source.hasChildren(element), collapsed: !open,
				incompressible: this.compression.isIncompressible(element), children: await Promise.all(children.map(visit)) };
		};
		const children = await Promise.all(this.roots.map(visit));
		if (!this.valid(version)) { return; }
		// A collapse received during a change request must win over that request's earlier state.
		const current = (node: ICompressedTreeElement<TreeElement>): ICompressedTreeElement<TreeElement> => ({ ...node,
			collapsed: isSCMHistoryItemViewModelTreeElement(node.element) ? !this.expanded.has(this.identity.getId(node.element))
				: isSCMHistoryItemChangeNode(node.element) ? this.collapsedFolders.has(this.identity.getId(node.element)) : node.collapsed,
			children: Array.from(node.children ?? [], current) });
		this.tree.setChildren(null, children.map(current));
		this.changed.fire();
	}
	override dispose(): void { this.version++; this.branches.clear(); this.roots = []; super.dispose(); }
}
