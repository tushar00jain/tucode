/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { ResourceTree } from '../../../../base/common/resourceTree.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { Command } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISCMActionButtonDescriptor, ISCMProvider, ISCMResource, ISCMResourceDecorations, ISCMResourceGroup } from '../common/scm.js';
import { ISCMArtifactProvider } from '../common/artifact.js';
import { ISCMHistoryProvider } from '../common/history.js';
import { toGitUri } from './gitUri.js';
import { getStatusIcon, getStatusText, isStrikeThrough } from './gitStatus.js';
import { GitResourceGroupType, GitStatus, IGitChange, IGitRepositoryStatus } from './scmIpc.js';

/**
 * A resource's four related URIs, as `ResourceCommandResolver.getResources` computes them
 * in `extensions/git/src/repository.ts`. `left`/`right` are the two sides of the diff the
 * default command opens; `original`/`modified` are what the multi-diff editor takes.
 */
interface IResourceUris {
	readonly left: URI | undefined;
	readonly right: URI | undefined;
	readonly original: URI | undefined;
	readonly modified: URI | undefined;
}

interface IModifiedOrOriginal {
	readonly original?: URI;
	readonly modified?: URI;
}

/**
 * One changed path. A port of `Resource` in `extensions/git/src/repository.ts`, reading the
 * status off the wire rather than off a `git status` parse: the `Status` value, its group
 * and its letter all arrive already decided by `tscode_git`.
 */
export class TauriGitResource implements ISCMResource {

	readonly decorations: ISCMResourceDecorations;
	readonly contextValue: string | undefined = undefined;
	/** The default command — `git.openDiffOnClick` picks which of the two below it is. */
	readonly command: Command;
	readonly changeCommand: Command;
	readonly fileCommand: Command;
	readonly multiDiffEditorOriginalUri: URI | undefined;
	readonly multiDiffEditorModifiedUri: URI | undefined;

	/** Upstream's `resourceUri` — the path as it exists now. */
	readonly sourceUri: URI;
	/** Upstream's `original` — the rename or copy source, or `sourceUri` when there is none. */
	readonly originalUri: URI;

	get status(): GitStatus { return this.change.status; }
	get letter(): string { return this.change.letter; }

	private readonly uris: IResourceUris;

	constructor(
		readonly resourceGroup: ISCMResourceGroup,
		private readonly change: IGitChange,
		/**
		 * The index group's rename targets by source URI. Upstream reads these off the live
		 * index group to point a working-tree resource at the staged rename.
		 */
		indexRenames: ReadonlyMap<string, URI>,
		openDiffOnClick: boolean,
		private readonly runCommand: (command: Command) => Promise<void>
	) {
		this.sourceUri = URI.revive(change.resource);
		this.originalUri = change.originalResource ? URI.revive(change.originalResource) : this.sourceUri;

		this.uris = TauriGitResource.getResources(this.sourceUri, this.originalUri, change.status, indexRenames);
		this.multiDiffEditorOriginalUri = this.uris.original;
		this.multiDiffEditorModifiedUri = this.uris.modified;
		this.decorations = {
			icon: getStatusIcon(change.status),
			tooltip: getStatusText(change.status),
			strikeThrough: isStrikeThrough(change.status),
			faded: false
		};

		this.changeCommand = this.resolveChangeCommand();
		this.fileCommand = {
			id: 'vscode.open',
			title: localize('git.open', "Open"),
			arguments: [this.sourceUri]
		};
		// Port of `ResourceCommandResolver.resolveDefaultCommand`.
		this.command = openDiffOnClick ? this.changeCommand : this.fileCommand;
	}

	get leftUri(): URI | undefined { return this.uris.left; }
	get rightUri(): URI | undefined { return this.uris.right; }

	/** The HEAD version, which `git.openHEADFile` opens on its own. */
	get headUri(): URI { return toGitUri(this.sourceUri, 'HEAD'); }

	open(_preserveFocus: boolean): Promise<void> {
		return this.runCommand(this.command);
	}

	/** Port of `ResourceCommandResolver.resolveChangeCommand`. */
	private resolveChangeCommand(): Command {
		const title = this.getTitle();

		if (!this.uris.left) {
			const bothModified = this.change.status === GitStatus.BothModified;
			return {
				id: 'vscode.open',
				title: localize('git.open', "Open"),
				arguments: [this.uris.right, { override: bothModified ? false : undefined }, title]
			};
		}

		return {
			id: 'vscode.diff',
			title: localize('git.open', "Open"),
			arguments: [this.uris.left, this.uris.right, title]
		};
	}

	/** Port of `ResourceCommandResolver.getTitle`. */
	private getTitle(): string {
		const name = basename(this.sourceUri);

		switch (this.change.status) {
			case GitStatus.IndexModified:
			case GitStatus.IndexRenamed:
			case GitStatus.IndexAdded:
				return localize('git.title.index', "{0} (Index)", name);
			case GitStatus.Modified:
			case GitStatus.BothAdded:
			case GitStatus.BothModified:
				return localize('git.title.workingTree', "{0} (Working Tree)", name);
			case GitStatus.IndexDeleted:
			case GitStatus.Deleted:
				return localize('git.title.deleted', "{0} (Deleted)", name);
			case GitStatus.DeletedByUs:
				return localize('git.title.theirs', "{0} (Theirs)", name);
			case GitStatus.DeletedByThem:
				return localize('git.title.ours', "{0} (Ours)", name);
			case GitStatus.Untracked:
				return localize('git.title.untracked', "{0} (Untracked)", name);
			case GitStatus.IntentToAdd:
			case GitStatus.IntentToRename:
				return localize('git.title.intentToAdd', "{0} (Intent to add)", name);
			case GitStatus.TypeChanged:
				return localize('git.title.typeChanged', "{0} (Type changed)", name);
			default:
				return '';
		}
	}

	/** Port of `ResourceCommandResolver.getResources`, minus the submodule branch. */
	private static getResources(sourceUri: URI, originalUri: URI, status: GitStatus, indexRenames: ReadonlyMap<string, URI>): IResourceUris {
		const left = TauriGitResource.getLeftResource(sourceUri, originalUri, status);
		const right = TauriGitResource.getRightResource(sourceUri, status, indexRenames);

		return {
			left: left.original ?? left.modified,
			right: right.original ?? right.modified,
			original: left.original ?? right.original,
			modified: left.modified ?? right.modified
		};
	}

	private static getLeftResource(sourceUri: URI, originalUri: URI, status: GitStatus): IModifiedOrOriginal {
		switch (status) {
			case GitStatus.IndexModified:
			case GitStatus.IndexRenamed:
			case GitStatus.IntentToRename:
			case GitStatus.TypeChanged:
				return { original: toGitUri(originalUri, 'HEAD') };

			case GitStatus.Modified:
				return { original: toGitUri(sourceUri, '~') };

			case GitStatus.DeletedByUs:
			case GitStatus.DeletedByThem:
				return { original: toGitUri(sourceUri, '~1') };
		}

		return {};
	}

	private static getRightResource(sourceUri: URI, status: GitStatus, indexRenames: ReadonlyMap<string, URI>): IModifiedOrOriginal {
		switch (status) {
			case GitStatus.IndexModified:
			case GitStatus.IndexAdded:
			case GitStatus.IndexCopied:
			case GitStatus.IndexRenamed:
				return { modified: toGitUri(sourceUri, '') };

			case GitStatus.IndexDeleted:
			case GitStatus.Deleted:
				return { original: toGitUri(sourceUri, 'HEAD') };

			case GitStatus.DeletedByUs:
				return { original: toGitUri(sourceUri, '~3') };

			case GitStatus.DeletedByThem:
				return { original: toGitUri(sourceUri, '~2') };

			case GitStatus.Modified:
			case GitStatus.Untracked:
			case GitStatus.Ignored:
			case GitStatus.IntentToAdd:
			case GitStatus.IntentToRename:
			case GitStatus.TypeChanged:
				return { modified: indexRenames.get(sourceUri.toString()) ?? sourceUri };

			case GitStatus.BothAdded:
			case GitStatus.BothModified:
				return { modified: sourceUri };
		}

		return {};
	}
}

/**
 * A port of `MainThreadSCMResourceGroup` in `vs/workbench/api/browser/mainThreadSCM.ts` —
 * the lazily-rebuilt `ResourceTree` and the splice are the parts of that file worth having
 * without an extension host.
 */
export class TauriGitResourceGroup implements ISCMResourceGroup {

	readonly resources: ISCMResource[] = [];

	private _resourceTree: ResourceTree<ISCMResource, ISCMResourceGroup> | undefined;
	get resourceTree(): ResourceTree<ISCMResource, ISCMResourceGroup> {
		if (!this._resourceTree) {
			const rootUri = this.provider.rootUri ?? URI.file('/');
			this._resourceTree = new ResourceTree<ISCMResource, ISCMResourceGroup>(this, rootUri, this.uriIdentityService.extUri);
			for (const resource of this.resources) {
				this._resourceTree.add(resource.sourceUri, resource);
			}
		}

		return this._resourceTree;
	}

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	/** Left undefined, as the git extension leaves it: the menus key off `id`. */
	contextValue: string | undefined = undefined;

	constructor(
		readonly id: GitResourceGroupType,
		readonly label: string,
		readonly provider: ISCMProvider,
		readonly hideWhenEmpty: boolean,
		readonly multiDiffEditorEnableViewChanges: boolean,
		private readonly uriIdentityService: IUriIdentityService
	) { }

	splice(start: number, deleteCount: number, toInsert: ISCMResource[]): void {
		this.resources.splice(start, deleteCount, ...toInsert);
		this._resourceTree = undefined;

		this._onDidChangeResources.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._onDidChangeResources.dispose();
	}
}

/**
 * One repository. Registered with `ISCMService` per repository, which is what puts several
 * repositories in the Source Control view at once.
 */
export class TauriGitSCMProvider extends Disposable implements ISCMProvider {

	readonly id: string;
	readonly providerId = 'git';
	readonly label = localize('git.label', "Git");
	readonly name: string;
	readonly iconPath = ThemeIcon.fromId('repo');

	readonly acceptInputCommand: Command;

	private readonly _contextValue = observableValue<string | undefined>(this, 'repository');
	get contextValue(): IObservable<string | undefined> { return this._contextValue; }

	private readonly _count = observableValue<number | undefined>(this, undefined);
	get count(): IObservable<number | undefined> { return this._count; }

	private readonly _commitTemplate = observableValue<string>(this, '');
	get commitTemplate(): IObservable<string> { return this._commitTemplate; }

	private readonly _actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
	get actionButton(): IObservable<ISCMActionButtonDescriptor | undefined> { return this._actionButton; }

	private readonly _statusBarCommands = observableValue<readonly Command[] | undefined>(this, undefined);
	get statusBarCommands(): IObservable<readonly Command[] | undefined> { return this._statusBarCommands; }

	/** This port ships neither, so both stay empty — the view reads them as observables. */
	private readonly _artifactProvider = observableValue<ISCMArtifactProvider | undefined>(this, undefined);
	get artifactProvider(): IObservable<ISCMArtifactProvider | undefined> { return this._artifactProvider; }

	private readonly _historyProvider = observableValue<ISCMHistoryProvider | undefined>(this, undefined);
	get historyProvider(): IObservable<ISCMHistoryProvider | undefined> { return this._historyProvider; }

	/**
	 * The Graph view is registered with `when: scm.historyProviderCount != 0`, and
	 * `SCMService` keeps that context key from this observable — so setting it is what makes
	 * the view exist at all.
	 */
	setHistoryProvider(historyProvider: ISCMHistoryProvider): void {
		this._historyProvider.set(historyProvider, undefined);
	}

	private readonly _onDidChangeResourceGroups = this._register(new Emitter<void>());
	readonly onDidChangeResourceGroups: Event<void> = this._onDidChangeResourceGroups.event;

	private readonly _onDidChangeResources = this._register(new Emitter<void>());
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	readonly groups: readonly TauriGitResourceGroup[];
	private readonly groupsById: ReadonlyMap<GitResourceGroupType, TauriGitResourceGroup>;

	/**
	 * Every resource currently in a group, by URI. `getOriginalResource` and the decoration
	 * provider both need "is this path one of ours, and in which state", and rescanning four
	 * arrays per query would make explorer decoration O(n) per file.
	 */
	private resourcesByUri = new Map<string, TauriGitResource>();

	constructor(
		readonly rootUri: URI,
		readonly inputBoxTextModel: ITextModel,
		private readonly runCommand: (command: Command) => Promise<void>,
		uriIdentityService: IUriIdentityService,
		workspaceContextService: IWorkspaceContextService
	) {
		super();

		this.id = `git:${rootUri.toString()}`;
		this.acceptInputCommand = { id: 'git.commit', title: localize('git.commit', "Commit"), arguments: [this] };

		// Upstream's `MainThreadSCMProvider` naming: a repository that *is* a workspace
		// folder takes the folder's name, otherwise the directory's own.
		const folder = workspaceContextService.getWorkspaceFolder(rootUri);
		this.name = folder?.uri.toString() === rootUri.toString() ? folder.name : basename(rootUri);

		const groups = [
			new TauriGitResourceGroup(GitResourceGroupType.Merge, localize('git.group.merge', "Merge Changes"), this, true, false, uriIdentityService),
			new TauriGitResourceGroup(GitResourceGroupType.Index, localize('git.group.index', "Staged Changes"), this, true, true, uriIdentityService),
			new TauriGitResourceGroup(GitResourceGroupType.WorkingTree, localize('git.group.workingTree', "Changes"), this, false, true, uriIdentityService),
			new TauriGitResourceGroup(GitResourceGroupType.Untracked, localize('git.group.untracked', "Untracked Changes"), this, true, true, uriIdentityService)
		];

		this.groups = groups;
		this.groupsById = new Map(groups.map(group => [group.id, group]));
		this._register({ dispose: () => groups.forEach(group => group.dispose()) });
	}

	/** The repository's changed paths, for the decoration provider. */
	get resources(): Iterable<TauriGitResource> {
		return this.resourcesByUri.values();
	}

	/**
	 * Replace every group's contents from one status snapshot. The status API hands back
	 * whole snapshots rather than deltas, so this is a single splice per group — which is
	 * also what drops each group's cached `ResourceTree` exactly once.
	 */
	updateStatus(status: IGitRepositoryStatus, openDiffOnClick: boolean): void {
		// Upstream points a working-tree resource at the staged rename when the same path
		// was renamed in the index, so the right-hand side is the file under its new name.
		const indexRenames = new Map<string, URI>();
		for (const change of status.index) {
			if (change.originalResource) {
				indexRenames.set(URI.revive(change.originalResource).toString(), URI.revive(change.resource));
			}
		}

		const byUri = new Map<string, TauriGitResource>();
		let count = 0;

		for (const group of this.groups) {
			const changes = this.changesForGroup(status, group.id);
			const resources = changes.map(change => {
				const resource = new TauriGitResource(group, change, indexRenames, openDiffOnClick, this.runCommand);
				byUri.set(resource.sourceUri.toString(), resource);
				return resource;
			});

			group.splice(0, group.resources.length, resources);
			count += resources.length;
		}

		this.resourcesByUri = byUri;
		this._count.set(count, undefined);
		this._statusBarCommands.set(this.buildStatusBarCommands(status, count), undefined);
		this._actionButton.set({
			command: { id: 'git.commit', title: localize('git.commitButton', "$(check) Commit"), arguments: [this] },
			enabled: true
		}, undefined);

		this._onDidChangeResources.fire();
	}

	/** A repository that could not be read keeps its place in the view, emptied. */
	reportFailure(message: string): void {
		for (const group of this.groups) {
			group.splice(0, group.resources.length, []);
		}

		this.resourcesByUri = new Map();
		this._count.set(undefined, undefined);
		this._actionButton.set(undefined, undefined);
		this._statusBarCommands.set([{
			id: 'git.refresh',
			title: localize('git.unreadable', "$(error) Unreadable"),
			tooltip: message
		}], undefined);

		this._onDidChangeResources.fire();
	}

	/**
	 * The quick diff and diff-editor baseline: the file as the index has it. A port of
	 * `GitQuickDiffProvider.provideOriginalResource`, minus the symbolic-link and
	 * `check-ignore` probes — a resource this port has no status entry for is one it
	 * declines to provide a baseline for anyway.
	 */
	async getOriginalResource(uri: URI): Promise<URI | null> {
		if (uri.scheme !== 'file') {
			return null;
		}

		const resource = this.resourcesByUri.get(uri.toString());
		if (!resource) {
			return null;
		}

		// Merge conflicts and untracked files have no meaningful index baseline.
		if (resource.resourceGroup.id === GitResourceGroupType.Merge || resource.resourceGroup.id === GitResourceGroupType.Untracked) {
			return null;
		}

		if (resource.status === GitStatus.Untracked || resource.status === GitStatus.Ignored) {
			return null;
		}

		return toGitUri(uri, '', { replaceFileExtension: true });
	}

	private changesForGroup(status: IGitRepositoryStatus, group: GitResourceGroupType): readonly IGitChange[] {
		switch (group) {
			case GitResourceGroupType.Merge: return status.merge;
			case GitResourceGroupType.Index: return status.index;
			case GitResourceGroupType.WorkingTree: return status.workingTree;
			case GitResourceGroupType.Untracked: return status.untracked;
		}
	}

	private buildStatusBarCommands(status: IGitRepositoryStatus, count: number): Command[] {
		const { name, detached, commit, ahead, behind } = status.head;
		const branch = name ?? (detached ? commit?.substring(0, 8) : undefined) ?? localize('git.noBranch', "no branch");

		const commands: Command[] = [{
			id: 'git.refresh',
			title: `$(git-branch) ${branch}${count > 0 ? '*' : ''}`,
			tooltip: localize('git.branchTooltip', "Branch: {0}", branch)
		}];

		if (ahead !== undefined || behind !== undefined) {
			commands.push({
				id: 'git.refresh',
				title: `${behind ?? 0}$(arrow-down) ${ahead ?? 0}$(arrow-up)`,
				tooltip: localize('git.syncTooltip', "{0} commits behind, {1} ahead", behind ?? 0, ahead ?? 0)
			});
		}

		return commands;
	}

	getGroup(id: GitResourceGroupType): TauriGitResourceGroup | undefined {
		return this.groupsById.get(id);
	}

	getResource(uri: URI): TauriGitResource | undefined {
		return this.resourcesByUri.get(uri.toString());
	}
}

/** Resolves the repository whose working tree contains a `file:` URI. */
export type IGitProviderLookup = (uri: URI) => TauriGitSCMProvider | undefined;
