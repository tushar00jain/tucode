import { Action, IAction } from '../vs/base/common/actions.js';
import { DisposableStore } from '../vs/base/common/lifecycle.js';
import { dirname, relativePath } from '../vs/base/common/resources.js';
import { URI } from '../vs/base/common/uri.js';
import { TreeVisibility } from '../vs/base/browser/ui/tree/tree.js';
import { FileKind } from '../vs/platform/files/common/files.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../vs/platform/contextview/browser/contextView.js';
import { INotificationService } from '../vs/platform/notification/common/notification.js';
import { BreadcrumbsService } from '../vs/workbench/browser/parts/editor/breadcrumbs.js';
import { IExplorerService } from '../vs/workbench/contrib/files/browser/files.js';
import { FilesFilter, FileSorter } from '../vs/workbench/contrib/files/browser/views/explorerViewer.js';
import { ExplorerItem } from '../vs/workbench/contrib/files/common/explorerModel.js';
import { IEditorService } from '../vs/workbench/services/editor/common/editorService.js';
import { NativeSubmenuAction } from './nativeContextMenu.js';

/** Resolve existing Explorer items without selecting or expanding the sidebar. */
export async function resolveBreadcrumbFolder(explorer: IExplorerService, resource: URI): Promise<ExplorerItem | undefined> {
	let item = explorer.findClosestRoot(resource) ?? undefined;
	if (!item) { return undefined; }
	const path = relativePath(item.resource, resource);
	if (path === undefined) { return undefined; }
	for (const segment of path.split('/').filter(Boolean)) {
		await item.fetchChildren(explorer.sortOrderConfiguration.sortOrder);
		item = item.getChild(segment);
		if (!item) { return undefined; }
	}
	return item;
}

/** The existing breadcrumb bar, with workspace file choices presented as native menus. */
export class NativeBreadcrumbsService extends BreadcrumbsService {
	private readonly pending = new DisposableStore();
	constructor(
		@IExplorerService private readonly explorer: IExplorerService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	pickFile(resource: URI, kind: FileKind, anchor: HTMLElement, group: number, onHide: () => void): boolean {
		const directory = kind === FileKind.FILE ? dirname(resource) : resource;
		// Non-workspace resources retain the stock picker; there is no Explorer model for them.
		if (!this.explorer.findClosestRoot(directory)) { return false; }
		this.pending.clear();
		const lifetime = this.pending.add(new DisposableStore());
		const filter = lifetime.add(this.instantiation.createInstance(FilesFilter));
		const sorter = this.instantiation.createInstance(FileSorter);
		lifetime.add({ dispose: onHide });
		lifetime.add(this.editors.onDidActiveEditorChange(() => lifetime.dispose()));
		const actionsFor = async (folder: ExplorerItem): Promise<IAction[]> => {
			await folder.fetchChildren(this.explorer.sortOrderConfiguration.sortOrder);
			if (lifetime.isDisposed) { return []; }
			// Menus list actual directory entries, including files nested by the sidebar painter.
			return [...folder.children.values()].filter(item => filter.filter(item, TreeVisibility.Visible))
				.sort((a, b) => sorter.compare(a, b)).map(item => item.isDirectory
					? new NativeSubmenuAction(item.getId(), item.name, () => actionsFor(item), item.resource.fsPath)
					: Object.assign(new Action(item.getId(), item.name, undefined, true, () =>
						this.editors.openEditor({ resource: item.resource }, group)), { iconResource: item.resource.fsPath }));
		};
		void resolveBreadcrumbFolder(this.explorer, directory).then(async folder => {
			if (!folder) { throw new Error('Breadcrumb folder is no longer available'); }
			const actions = await actionsFor(folder);
			if (lifetime.isDisposed || !anchor.isConnected) { lifetime.dispose(); return; }
			this.menus.showContextMenu({ getAnchor: () => {
				const rect = anchor.getBoundingClientRect();
				return { x: rect.left, y: rect.bottom + 4 };
			}, getActions: () => actions.length ? actions :
				[new Action('empty', '(Empty)', undefined, false)], onHide: () => lifetime.dispose(), skipTelemetry: true });
		}).catch(error => {
			if (!lifetime.isDisposed) { lifetime.dispose(); this.notifications.error(error); }
		});
		return true;
	}

	dispose(): void { this.pending.dispose(); }
}
