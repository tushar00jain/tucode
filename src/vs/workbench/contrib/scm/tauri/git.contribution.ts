/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Command } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IQuickDiffService } from '../common/quickDiff.js';
import { ISCMRepository, ISCMService } from '../common/scm.js';
import { CoalescingRefresh } from './coalescingRefresh.js';
import { GIT_SCHEME } from './gitUri.js';
import { GitResourceGroupType, GitUntrackedChanges, IGitRepositoryStatusResult, IGitStatusOptions, SCM_CHANNEL_NAME, ScmChannelClient } from './scmIpc.js';
import { TauriGitDecorationProvider } from './tauriGitDecorationProvider.js';
import { TauriGitFileSystemProvider } from './tauriGitFileSystemProvider.js';
import { TauriGitHistoryProvider } from './tauriGitHistoryProvider.js';
import { TauriGitResource, TauriGitResourceGroup, TauriGitSCMProvider } from './tauriGitProvider.js';
import { watcherExcludes } from './watcherExcludes.js';

//#region Configuration

/**
 * The four `git.*` settings this port's own code reads. Upstream contributes them from the
 * git extension's `package.json`; without them `config.git.untrackedChanges` is undefined and
 * the resource-group menus below would offer the "Tracked" variants for a group that in fact
 * holds untracked files too. Ids, types and defaults are upstream's.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'git',
	order: 10,
	title: localize('gitConfigurationTitle', "Git"),
	type: 'object',
	properties: {
		'git.untrackedChanges': {
			type: 'string',
			enum: ['mixed', 'separate', 'hidden'],
			enumDescriptions: [
				localize('git.untrackedChanges.mixed', "All changes, tracked and untracked, appear together and behave equally."),
				localize('git.untrackedChanges.separate', "Untracked changes appear separately in the Source Control view. They are also excluded from several actions."),
				localize('git.untrackedChanges.hidden', "Untracked changes are hidden and excluded from several actions.")
			],
			default: 'mixed',
			description: localize('git.untrackedChanges', "Controls how untracked changes behave."),
			scope: ConfigurationScope.RESOURCE
		},
		'git.openDiffOnClick': {
			type: 'boolean',
			default: true,
			description: localize('git.openDiffOnClick', "Controls whether the diff editor should be opened when clicking a change. Otherwise the regular editor will be opened."),
			scope: ConfigurationScope.RESOURCE
		},
		'git.showInlineOpenFileAction': {
			type: 'boolean',
			default: true,
			description: localize('git.showInlineOpenFileAction', "Controls whether to show an inline Open File action in the Git changes view.")
		},
		'git.commitShortHashLength': {
			type: 'number',
			default: 7,
			minimum: 7,
			maximum: 40,
			description: localize('git.commitShortHashLength', "Controls the length of the commit short hash."),
			scope: ConfigurationScope.RESOURCE
		}
	}
});

//#endregion

/**
 * Port of `SCMInputBoxContentProvider` in `vs/workbench/api/browser/mainThreadSCM.ts`, so
 * that a commit input box model resolved by URI — rather than taken off the provider — is
 * created on demand.
 */
class SCMInputBoxContentProvider extends Disposable implements ITextModelContentProvider {

	constructor(
		textModelService: ITextModelService,
		private readonly modelService: IModelService,
		private readonly languageService: ILanguageService
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(Schemas.vscodeSourceControl, this));
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		return this.modelService.getModel(resource)
			?? this.modelService.createModel('', this.languageService.createById('scminput'), resource);
	}
}

interface IGitRepository {
	readonly root: string;
	readonly rootUri: URI;
	readonly provider: TauriGitSCMProvider;
	readonly repository: ISCMRepository;
	readonly decorations: TauriGitDecorationProvider;
	readonly history: TauriGitHistoryProvider;
	readonly disposables: DisposableStore;
}

export class TauriGitContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriGit';

	private readonly client: ScmChannelClient;
	private readonly fileSystemProvider: TauriGitFileSystemProvider;

	/** Open repositories by canonical root path, which is the key Rust answers with. */
	private readonly repositories = new Map<string, IGitRepository>();

	private readonly refresher = this._register(new CoalescingRefresh(() => this.doRefresh()));

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ISCMService private readonly scmService: ISCMService,
		@IQuickDiffService private readonly quickDiffService: IQuickDiffService,
		@IDecorationsService private readonly decorationsService: IDecorationsService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITextModelService textModelService: ITextModelService
	) {
		super();

		this.client = new ScmChannelClient(mainProcessService.getChannel(SCM_CHANNEL_NAME));

		this._register(new SCMInputBoxContentProvider(textModelService, this.modelService, this.languageService));

		this.fileSystemProvider = this._register(new TauriGitFileSystemProvider(this.client, uri => this.providerFor(uri)));
		this._register(this.fileService.registerProvider(GIT_SCHEME, this.fileSystemProvider));

		this.registerCommands();

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.discover()));
		this._register(this.fileService.onDidFilesChange(event => {
			for (const repository of this.repositories.values()) {
				if (event.affects(repository.rootUri)) {
					this.refresher.schedule();
					return;
				}
			}
		}));

		this.discover();
	}

	//#region Repository lifecycle

	/**
	 * Reconcile the open repositories with what the workspace folders contain. Running the
	 * whole reconciliation on every folder change rather than diffing the event keeps adding
	 * a folder, removing one and the initial load on a single path.
	 */
	private async discover(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const found = new Map<string, URI>();

		for (const folder of folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}

			try {
				for (const info of await this.client.discover(folder.uri.fsPath)) {
					found.set(info.root, URI.file(info.root));
				}
			} catch (error) {
				this.logService.error(`[git] repository discovery failed for ${folder.uri.fsPath}`, error);
			}
		}

		for (const [root, repository] of [...this.repositories]) {
			if (!found.has(root)) {
				this.repositories.delete(root);
				repository.disposables.dispose();
				this.fileSystemProvider.forgetRepository(repository.rootUri.fsPath);

				try {
					await this.client.close(root);
				} catch (error) {
					this.logService.error(`[git] closing ${root} failed`, error);
				}
			}
		}

		for (const [root, rootUri] of found) {
			if (!this.repositories.has(root)) {
				this.repositories.set(root, this.createRepository(root, rootUri));
			}
		}

		await this.refresh();
	}

	private createRepository(root: string, rootUri: URI): IGitRepository {
		const disposables = new DisposableStore();

		const inputBoxTextModel = this.modelService.createModel(
			'',
			this.languageService.createById('scminput'),
			URI.from({ scheme: Schemas.vscodeSourceControl, path: `/git:${root}/input` })
		);
		disposables.add(inputBoxTextModel);

		const provider = disposables.add(new TauriGitSCMProvider(
			rootUri,
			inputBoxTextModel,
			command => this.runCommand(command),
			this.uriIdentityService,
			this.workspaceContextService
		));

		const repository = this.scmService.registerSCMProvider(provider);
		disposables.add(repository);

		repository.input.placeholder = localize('git.commitPlaceholder', "Message (Ctrl+Enter to commit on \"{0}\")", provider.name);

		// The explorer badges, and the gutter indicators the quick diff service drives off
		// the same index baseline the diff editor's left-hand side uses.
		const decorations = new TauriGitDecorationProvider(provider);
		disposables.add(decorations);
		disposables.add(this.decorationsService.registerDecorationsProvider(decorations));

		// The Graph view exists only while some provider has a history provider, so this is
		// also what turns it on. Its refs are updated from `apply` below, which is the one
		// place that learns a repository changed.
		const history = disposables.add(new TauriGitHistoryProvider(
			this.client,
			root,
			decorations,
			this.configurationService,
			this.logService
		));
		provider.setHistoryProvider(history);

		disposables.add(this.quickDiffService.addQuickDiffProvider({
			id: 'git.quickDiffProvider',
			label: localize('git.quickDiff', "Git Local Changes (Working Tree)"),
			rootUri,
			kind: 'primary',
			getOriginalResource: uri => provider.getOriginalResource(uri)
		}));

		// A repository's own working tree is what makes its status stale.
		disposables.add(this.fileService.watch(rootUri, { recursive: true, excludes: watcherExcludes(this.configurationService, rootUri) }));

		return { root, rootUri, provider, repository, decorations, history, disposables };
	}

	//#endregion

	//#region Refresh

	private statusOptions(): IGitStatusOptions {
		return {
			untrackedChanges: this.configurationService.getValue<GitUntrackedChanges>('git.untrackedChanges'),
			detectRenames: true
		};
	}

	refresh(): Promise<void> {
		return this.refresher.refresh();
	}

	/** One poll. Answers whether a mutation landed while it ran, which is `refresher`'s cue. */
	private async doRefresh(): Promise<boolean> {
		let results: IGitRepositoryStatusResult[];
		try {
			results = await this.client.statusAll(this.statusOptions());
		} catch (error) {
			this.logService.error('[git] status failed', error);
			return false;
		}

		return this.apply(results);
	}

	/** Returns whether any snapshot was computed before a mutation landed. */
	private apply(results: readonly IGitRepositoryStatusResult[]): boolean {
		const openDiffOnClick = this.configurationService.getValue<boolean>('git.openDiffOnClick') !== false;
		let stale = false;

		for (const result of results) {
			const repository = this.repositories.get(result.root);
			if (!repository) {
				// Discovery owns the repository set; a root Rust still holds open but the
				// workspace no longer names is closed on the next reconciliation.
				continue;
			}

			if (result.kind === 'failed') {
				this.logService.warn(`[git] ${result.root}: ${result.message}`);
				repository.provider.reportFailure(result.message);
				repository.history.updateRefs(undefined);
			} else {
				stale = stale || result.stale;
				repository.provider.updateStatus(result, openDiffOnClick);
				// Upstream drives this off the repository's write operations; here the poll is
				// the only thing that learns HEAD or a ref moved. It is not awaited: the graph
				// reloads off its own ref observables, and the status view must not wait on it.
				repository.history.updateRefs(result.head);
			}

			repository.decorations.update();
			// Keyed off `rootUri`, which is what the provider serves `git:` reads under.
			this.fileSystemProvider.notifyRepositoryChanged(repository.rootUri.fsPath);
		}

		return stale;
	}

	/**
	 * Every mutation and its refresh, as one call. Keeping the pair fused is what stops a
	 * command from mutating and leaving the view showing the state from before it; the
	 * refresh runs even when the mutation throws, because a failed `git` invocation may still
	 * have applied part of its work — which is also why Rust bumps the epoch on failure.
	 */
	private async mutate(operation: () => Promise<void>): Promise<void> {
		try {
			await operation();
		} catch (error) {
			this.logService.error('[git] operation failed', error);
		} finally {
			await this.refresh();
		}
	}

	//#endregion

	//#region Lookup

	private providerFor(uri: URI): TauriGitSCMProvider | undefined {
		let best: TauriGitSCMProvider | undefined;

		for (const repository of this.repositories.values()) {
			if (this.uriIdentityService.extUri.isEqualOrParent(uri, repository.rootUri)) {
				// Nested repositories: the deepest root owns the path.
				if (!best || repository.rootUri.path.length > best.rootUri.path.length) {
					best = repository.provider;
				}
			}
		}

		return best;
	}

	/**
	 * By identity rather than by root: the map is keyed by the canonical path Rust answers
	 * with, and `URI.file(root).fsPath` is not guaranteed to reproduce it byte for byte.
	 */
	private repositoryFor(provider: TauriGitSCMProvider): IGitRepository | undefined {
		for (const repository of this.repositories.values()) {
			if (repository.provider === provider) {
				return repository;
			}
		}

		return undefined;
	}

	/**
	 * The repository a command should act on when the menu handed it no context — the SCM
	 * view's title toolbar passes no provider while more than one repository is visible.
	 */
	private resolveProvider(args: readonly unknown[]): TauriGitSCMProvider | undefined {
		for (const arg of args) {
			if (arg instanceof TauriGitSCMProvider) {
				return arg;
			}
			if (arg instanceof TauriGitResource) {
				return this.providerFor(arg.sourceUri);
			}
			if (arg instanceof TauriGitResourceGroup && arg.provider instanceof TauriGitSCMProvider) {
				return arg.provider;
			}
		}

		return this.repositories.size === 1 ? [...this.repositories.values()][0].provider : undefined;
	}

	private runCommand(command: Command): Promise<void> {
		return this.commandService.executeCommand(command.id, ...(command.arguments ?? []));
	}

	//#endregion

	//#region Commands

	/** Paths a mutation takes, grouped by the repository that owns them. */
	private pathsByRepository(resources: readonly TauriGitResource[]): Map<TauriGitSCMProvider, string[]> {
		const byProvider = new Map<TauriGitSCMProvider, string[]>();

		for (const resource of resources) {
			const provider = this.providerFor(resource.sourceUri);
			if (!provider) {
				continue;
			}

			const paths = byProvider.get(provider) ?? [];
			paths.push(resource.sourceUri.fsPath);
			byProvider.set(provider, paths);
		}

		return byProvider;
	}

	private static resourcesOf(args: readonly unknown[]): TauriGitResource[] {
		const resources: TauriGitResource[] = [];

		for (const arg of args) {
			if (arg instanceof TauriGitResource) {
				resources.push(arg);
			} else if (arg instanceof TauriGitResourceGroup) {
				for (const resource of arg.resources) {
					if (resource instanceof TauriGitResource) {
						resources.push(resource);
					}
				}
			}
		}

		return resources;
	}

	private registerCommands(): void {
		const register = (id: string, handler: (...args: unknown[]) => Promise<void>) => {
			this._register(CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...args)));
		};

		register('git.refresh', () => this.refresh());

		register('git.commit', async (...args) => {
			const provider = this.resolveProvider(args);
			if (!provider) {
				return;
			}

			const repository = this.repositoryFor(provider);
			const message = repository?.repository.input.value.trim();
			if (!repository || !message) {
				return;
			}

			await this.mutate(async () => {
				await this.client.commit(provider.rootUri.fsPath, message);
				repository.repository.input.setValue('', false);
			});
		});

		const mutateResources = (id: string, run: (root: string, paths: string[]) => Promise<void>) => {
			register(id, async (...args) => {
				const byProvider = this.pathsByRepository(TauriGitContribution.resourcesOf(args));

				await this.mutate(async () => {
					for (const [provider, paths] of byProvider) {
						await run(provider.rootUri.fsPath, paths);
					}
				});
			});
		};

		// Stage, unstage and discard all take the same shape: a set of resources — a row, a
		// multi-selection, an expanded folder, or a whole group — turned into file paths.
		for (const id of ['git.stage', 'git.stageAll', 'git.stageAllTracked', 'git.stageAllUntracked', 'git.stageAllMerge']) {
			mutateResources(id, (root, paths) => this.client.stage(root, paths));
		}

		for (const id of ['git.unstage', 'git.unstageAll']) {
			mutateResources(id, (root, paths) => this.client.unstage(root, paths));
		}

		for (const id of ['git.clean', 'git.cleanAll', 'git.cleanAllTracked', 'git.cleanAllUntracked']) {
			mutateResources(id, (root, paths) => this.client.discard(root, paths));
		}

		register('git.openChange', async (...args) => {
			for (const resource of TauriGitContribution.resourcesOf(args)) {
				await this.runCommand(resource.changeCommand);
			}
		});

		const openFile = async (...args: unknown[]) => {
			for (const resource of TauriGitContribution.resourcesOf(args)) {
				await this.runCommand(resource.fileCommand);
			}
		};
		register('git.openFile', openFile);
		register('git.openFile2', openFile);

		register('git.openHEADFile', async (...args) => {
			for (const resource of TauriGitContribution.resourcesOf(args)) {
				await this.commandService.executeCommand('vscode.open', resource.headUri);
			}
		});
	}

	//#endregion

	override dispose(): void {
		for (const repository of this.repositories.values()) {
			repository.disposables.dispose();
		}
		this.repositories.clear();

		super.dispose();
	}
}

//#region Menus

/**
 * The `scm/title`, `scm/resourceGroup/context`, `scm/resourceState/context` and
 * `scm/resourceFolder/context` contributions of the git extension's `package.json`, for the
 * commands this port implements. Groups, orders and `when` clauses are upstream's — the SCM
 * view builds the same context keys (`scmProvider`, `scmResourceGroup`) whether the items
 * come from an extension manifest or from here.
 *
 * The manifest's `"inline@2"` spelling is split into `group` and `order`, because the `@order`
 * suffix is parsed by the `menus` extension point, not by `MenuRegistry`: `getActionBarActions`
 * compares the group by equality, so a group named `inline@2` is never inlined.
 */

const isGit = ContextKeyExpr.equals('scmProvider', 'git');
const untrackedMixed = ContextKeyExpr.equals('config.git.untrackedChanges', 'mixed');
const untrackedSeparate = ContextKeyExpr.notEquals('config.git.untrackedChanges', 'mixed');
const showInlineOpenFile = ContextKeyExpr.has('config.git.showInlineOpenFileAction');
const openDiffOnClick = ContextKeyExpr.has('config.git.openDiffOnClick');

function inGroup(group: GitResourceGroupType, ...rest: (ContextKeyExpression | undefined)[]): ContextKeyExpression {
	return ContextKeyExpr.and(isGit, ContextKeyExpr.equals('scmResourceGroup', group), ...rest)!;
}

const commit = { id: 'git.commit', title: localize('git.command.commit', "Commit"), category: localize('git.category', "Git"), icon: Codicon.check };
const refresh = { id: 'git.refresh', title: localize('git.command.refresh', "Refresh"), category: localize('git.category', "Git"), icon: Codicon.refresh };
const stage = { id: 'git.stage', title: localize('git.command.stage', "Stage Changes"), category: localize('git.category', "Git"), icon: Codicon.add };
const stageAll = { id: 'git.stageAll', title: localize('git.command.stageAll', "Stage All Changes"), category: localize('git.category', "Git"), icon: Codicon.add };
const stageAllTracked = { id: 'git.stageAllTracked', title: localize('git.command.stageAllTracked', "Stage All Tracked Changes"), category: localize('git.category', "Git"), icon: Codicon.add };
const stageAllUntracked = { id: 'git.stageAllUntracked', title: localize('git.command.stageAllUntracked', "Stage All Untracked Changes"), category: localize('git.category', "Git"), icon: Codicon.add };
const stageAllMerge = { id: 'git.stageAllMerge', title: localize('git.command.stageAllMerge', "Stage All Merge Changes"), category: localize('git.category', "Git"), icon: Codicon.add };
const unstage = { id: 'git.unstage', title: localize('git.command.unstage', "Unstage Changes"), category: localize('git.category', "Git"), icon: Codicon.remove };
const unstageAll = { id: 'git.unstageAll', title: localize('git.command.unstageAll', "Unstage All Changes"), category: localize('git.category', "Git"), icon: Codicon.remove };
const clean = { id: 'git.clean', title: localize('git.command.clean', "Discard Changes"), category: localize('git.category', "Git"), icon: Codicon.discard };
const cleanAll = { id: 'git.cleanAll', title: localize('git.command.cleanAll', "Discard All Changes"), category: localize('git.category', "Git"), icon: Codicon.discard };
const cleanAllTracked = { id: 'git.cleanAllTracked', title: localize('git.command.cleanAllTracked', "Discard All Tracked Changes"), category: localize('git.category', "Git"), icon: Codicon.discard };
const cleanAllUntracked = { id: 'git.cleanAllUntracked', title: localize('git.command.cleanAllUntracked', "Discard All Untracked Changes"), category: localize('git.category', "Git"), icon: Codicon.discard };
const openChange = { id: 'git.openChange', title: localize('git.command.openChange', "Open Changes"), category: localize('git.category', "Git"), icon: Codicon.compareChanges };
const openFile = { id: 'git.openFile', title: localize('git.command.openFile', "Open File"), category: localize('git.category', "Git"), icon: Codicon.goToFile };
const openFile2 = { id: 'git.openFile2', title: localize('git.command.openFile', "Open File"), category: localize('git.category', "Git"), icon: Codicon.goToFile };
const openHEADFile = { id: 'git.openHEADFile', title: localize('git.command.openHEADFile', "Open File (HEAD)"), category: localize('git.category', "Git") };

MenuRegistry.appendMenuItem(MenuId.SCMTitle, { command: commit, group: 'navigation', when: isGit });
MenuRegistry.appendMenuItem(MenuId.SCMTitle, { command: refresh, group: 'navigation', when: isGit });

for (const menu of [MenuId.SCMResourceContext, MenuId.SCMResourceFolderContext]) {
	MenuRegistry.appendMenuItem(menu, { command: stage, when: inGroup(GitResourceGroupType.Merge), group: '1_modification' });
	MenuRegistry.appendMenuItem(menu, { command: stage, when: inGroup(GitResourceGroupType.Merge), group: 'inline', order: 2 });

	MenuRegistry.appendMenuItem(menu, { command: unstage, when: inGroup(GitResourceGroupType.Index), group: '1_modification' });
	MenuRegistry.appendMenuItem(menu, { command: unstage, when: inGroup(GitResourceGroupType.Index), group: 'inline', order: 2 });

	MenuRegistry.appendMenuItem(menu, { command: stage, when: inGroup(GitResourceGroupType.WorkingTree), group: '1_modification' });
	MenuRegistry.appendMenuItem(menu, { command: clean, when: inGroup(GitResourceGroupType.WorkingTree), group: '1_modification' });
	MenuRegistry.appendMenuItem(menu, { command: clean, when: inGroup(GitResourceGroupType.WorkingTree), group: 'inline', order: 2 });
	MenuRegistry.appendMenuItem(menu, { command: stage, when: inGroup(GitResourceGroupType.WorkingTree), group: 'inline', order: 2 });

	MenuRegistry.appendMenuItem(menu, { command: stage, when: inGroup(GitResourceGroupType.Untracked), group: '1_modification' });
	MenuRegistry.appendMenuItem(menu, { command: clean, when: inGroup(GitResourceGroupType.Untracked), group: '1_modification' });
	MenuRegistry.appendMenuItem(menu, { command: clean, when: inGroup(GitResourceGroupType.Untracked), group: 'inline', order: 2 });
	MenuRegistry.appendMenuItem(menu, { command: stage, when: inGroup(GitResourceGroupType.Untracked), group: 'inline', order: 2 });
}

for (const group of [GitResourceGroupType.Merge, GitResourceGroupType.Index, GitResourceGroupType.WorkingTree, GitResourceGroupType.Untracked]) {
	if (group !== GitResourceGroupType.Merge) {
		MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, { command: openChange, when: inGroup(group), group: 'navigation' });
		MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, { command: openHEADFile, when: inGroup(group), group: 'navigation' });
	}

	MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, { command: openFile, when: inGroup(group), group: 'navigation' });
	MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, { command: openFile2, when: inGroup(group, showInlineOpenFile, openDiffOnClick), group: 'inline', order: 1 });
	MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, { command: openChange, when: inGroup(group, showInlineOpenFile, openDiffOnClick.negate()), group: 'inline', order: 1 });
}

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAllMerge, when: inGroup(GitResourceGroupType.Merge), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAllMerge, when: inGroup(GitResourceGroupType.Merge), group: 'inline', order: 2 });

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: unstageAll, when: inGroup(GitResourceGroupType.Index), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: unstageAll, when: inGroup(GitResourceGroupType.Index), group: 'inline', order: 2 });

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: cleanAll, when: inGroup(GitResourceGroupType.WorkingTree, untrackedMixed), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAll, when: inGroup(GitResourceGroupType.WorkingTree, untrackedMixed), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: cleanAll, when: inGroup(GitResourceGroupType.WorkingTree, untrackedMixed), group: 'inline', order: 2 });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAll, when: inGroup(GitResourceGroupType.WorkingTree, untrackedMixed), group: 'inline', order: 2 });

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: cleanAllTracked, when: inGroup(GitResourceGroupType.WorkingTree, untrackedSeparate), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAllTracked, when: inGroup(GitResourceGroupType.WorkingTree, untrackedSeparate), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: cleanAllTracked, when: inGroup(GitResourceGroupType.WorkingTree, untrackedSeparate), group: 'inline', order: 2 });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAllTracked, when: inGroup(GitResourceGroupType.WorkingTree, untrackedSeparate), group: 'inline', order: 2 });

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: cleanAllUntracked, when: inGroup(GitResourceGroupType.Untracked), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAllUntracked, when: inGroup(GitResourceGroupType.Untracked), group: '1_modification' });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: cleanAllUntracked, when: inGroup(GitResourceGroupType.Untracked), group: 'inline', order: 2 });
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, { command: stageAllUntracked, when: inGroup(GitResourceGroupType.Untracked), group: 'inline', order: 2 });

//#endregion

registerWorkbenchContribution2(TauriGitContribution.ID, TauriGitContribution, WorkbenchPhase.AfterRestored);
