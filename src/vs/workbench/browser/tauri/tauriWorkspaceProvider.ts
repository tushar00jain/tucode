/*---------------------------------------------------------------------------------------------
 *  The workspace provider for tscode.
 *
 *  A port of `vs/code/browser/workbench/workbench.ts`'s `WorkspaceProvider`, which is the
 *  reference implementation the workbench's browser host service is written against. It
 *  differs in where the workspace is carried across the reload: upstream puts it in the
 *  page URL, which a Tauri window neither shows nor lets anyone share, so tscode keeps it
 *  in `localStorage` — where it also survives a restart, the way a desktop window reopens
 *  its last folder. Opening always reuses the one window; tscode has no second one.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { mainWindow } from '../../../base/browser/window.js';
import { isFolderToOpen, isWorkspaceToOpen } from '../../../platform/window/common/window.js';
import { IWorkspace, IWorkspaceProvider } from '../web.api.js';

/**
 * The shape `localStorage` holds. A stored folder or workspace is its URI as a string;
 * an empty window is an empty object, which is what distinguishes "opened empty" from
 * "never opened".
 */
interface IStoredWorkspace {
	readonly folderUri?: string;
	readonly workspaceUri?: string;
}

export class TauriWorkspaceProvider implements IWorkspaceProvider {

	private static readonly STORAGE_KEY = 'tscode.workspace';

	static create(): TauriWorkspaceProvider {
		return new TauriWorkspaceProvider(TauriWorkspaceProvider.restore());
	}

	private static restore(): IWorkspace {
		const raw = mainWindow.localStorage.getItem(TauriWorkspaceProvider.STORAGE_KEY);
		if (!raw) {
			return undefined;
		}

		const stored: IStoredWorkspace = JSON.parse(raw);
		if (stored.folderUri) {
			return { folderUri: URI.parse(stored.folderUri) };
		}

		if (stored.workspaceUri) {
			return { workspaceUri: URI.parse(stored.workspaceUri) };
		}

		return undefined;
	}

	private static persist(workspace: IWorkspace): void {
		let stored: IStoredWorkspace;
		if (!workspace) {
			stored = {};
		} else if (isFolderToOpen(workspace)) {
			stored = { folderUri: workspace.folderUri.toString() };
		} else {
			stored = { workspaceUri: workspace.workspaceUri.toString() };
		}

		mainWindow.localStorage.setItem(TauriWorkspaceProvider.STORAGE_KEY, JSON.stringify(stored));
	}

	readonly trusted = true;

	get workspace(): IWorkspace { return this._workspace; }

	private constructor(private _workspace: IWorkspace) { }

	/**
	 * Forgets the stored workspace, so the next boot opens an empty window. Boot calls this
	 * when the stored folder can no longer be opened — and this window is then an empty one,
	 * so the restored workspace has to go too or reopening that same folder would look like
	 * a no-op change.
	 */
	forget(): void {
		this._workspace = undefined;
		mainWindow.localStorage.removeItem(TauriWorkspaceProvider.STORAGE_KEY);
	}

	async open(workspace: IWorkspace, options?: { reuse?: boolean }): Promise<boolean> {
		if (options?.reuse && this.isSame(this.workspace, workspace)) {
			return true; // return early if the workspace is not changing and we are reusing the window
		}

		TauriWorkspaceProvider.persist(workspace);
		mainWindow.location.reload();

		return true;
	}

	private isSame(workspaceA: IWorkspace, workspaceB: IWorkspace): boolean {
		if (!workspaceA || !workspaceB) {
			return workspaceA === workspaceB; // both empty
		}

		if (isFolderToOpen(workspaceA) && isFolderToOpen(workspaceB)) {
			return isEqual(workspaceA.folderUri, workspaceB.folderUri); // same workspace
		}

		if (isWorkspaceToOpen(workspaceA) && isWorkspaceToOpen(workspaceB)) {
			return isEqual(workspaceA.workspaceUri, workspaceB.workspaceUri); // same workspace
		}

		return false;
	}
}
