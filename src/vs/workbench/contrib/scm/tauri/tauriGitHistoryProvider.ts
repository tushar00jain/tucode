/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { fromNow } from '../../../../base/common/date.js';
import { IMarkdownString, MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemRef, ISCMHistoryItemRefsChangeEvent, ISCMHistoryItemStatistics, ISCMHistoryOptions, ISCMHistoryProvider } from '../common/history.js';
import { toGitUri } from './gitUri.js';
import { GitRefKind, GitStatus, IGitChange, IGitCommit, IGitHead, IGitLogOptions, IGitRef, ScmChannelClient } from './scmIpc.js';

/** Port of `truncate` in `extensions/git/src/util.ts`. */
function truncate(value: string, maxLength = 20, ellipsis = true): string {
	return value.length <= maxLength ? value : `${value.substring(0, maxLength)}${ellipsis ? '…' : ''}`;
}

/** Port of `subject` in `extensions/git/src/util.ts`. */
function subject(value: string): string {
	const index = value.indexOf('\n');
	return index === -1 ? value : truncate(value, index, false);
}

/**
 * Port of `compareSourceControlHistoryItemRef` in `extensions/git/src/historyProvider.ts`:
 * branches, then remote branches, then tags, each group alphabetically.
 */
function compareSourceControlHistoryItemRef(ref1: ISCMHistoryItemRef, ref2: ISCMHistoryItemRef): number {
	const getOrder = (ref: ISCMHistoryItemRef): number => {
		if (ref.id.startsWith('refs/heads/')) {
			return 1;
		} else if (ref.id.startsWith('refs/remotes/')) {
			return 2;
		} else if (ref.id.startsWith('refs/tags/')) {
			return 3;
		}

		return 99;
	};

	const ref1Order = getOrder(ref1);
	const ref2Order = getOrder(ref2);

	if (ref1Order !== ref2Order) {
		return ref1Order - ref2Order;
	}

	return ref1.name.localeCompare(ref2.name);
}

/**
 * Port of `deltaHistoryItemRefs` in `extensions/git/src/util.ts` — a merge over two
 * id-sorted lists, where an id in both whose revision moved is a modification.
 */
function deltaHistoryItemRefs(before: readonly ISCMHistoryItemRef[], after: readonly ISCMHistoryItemRef[]): { added: ISCMHistoryItemRef[]; modified: ISCMHistoryItemRef[]; removed: ISCMHistoryItemRef[] } {
	if (before.length === 0) {
		return { added: [...after], modified: [], removed: [] };
	}

	const added: ISCMHistoryItemRef[] = [];
	const modified: ISCMHistoryItemRef[] = [];
	const removed: ISCMHistoryItemRef[] = [];

	let beforeIdx = 0;
	let afterIdx = 0;

	while (true) {
		if (beforeIdx === before.length) {
			added.push(...after.slice(afterIdx));
			break;
		}
		if (afterIdx === after.length) {
			removed.push(...before.slice(beforeIdx));
			break;
		}

		const beforeElement = before[beforeIdx];
		const afterElement = after[afterIdx];

		const result = beforeElement.id.localeCompare(afterElement.id);

		if (result === 0) {
			if (beforeElement.revision !== afterElement.revision) {
				modified.push(afterElement);
			}

			beforeIdx += 1;
			afterIdx += 1;
		} else if (result < 0) {
			removed.push(beforeElement);
			beforeIdx += 1;
		} else {
			added.push(afterElement);
			afterIdx += 1;
		}
	}

	return { added, modified, removed };
}

/**
 * Port of `toMultiFileDiffEditorUris` in `extensions/git/src/uri.ts`. Upstream's `git diff
 * --raw` spells an addition `INDEX_ADDED` but a deletion `DELETED`; `tscode_git` reports a
 * tree-to-tree comparison through one table, so both arrive in the `Index*` spelling.
 */
function toMultiFileDiffEditorUris(change: IGitChange, originalRef: string, modifiedRef: string): { originalUri: URI | undefined; modifiedUri: URI | undefined } {
	const uri = URI.revive(change.resource);
	const originalUri = change.originalResource ? URI.revive(change.originalResource) : uri;

	switch (change.status) {
		case GitStatus.IndexAdded:
			return { originalUri: undefined, modifiedUri: toGitUri(uri, modifiedRef) };
		case GitStatus.IndexDeleted:
			return { originalUri: toGitUri(uri, originalRef), modifiedUri: undefined };
		case GitStatus.IndexRenamed:
		case GitStatus.IndexCopied:
			return { originalUri: toGitUri(originalUri, originalRef), modifiedUri: toGitUri(uri, modifiedRef) };
		default:
			return { originalUri: toGitUri(uri, originalRef), modifiedUri: toGitUri(uri, modifiedRef) };
	}
}

/** Where a history item's per-change file decorations are registered — see the contribution. */
export interface IHistoryItemDecorationSink {
	addHistoryItemChanges(changes: readonly { uri: URI; status: GitStatus; letter: string }[]): void;
}

/**
 * One repository's commit history. A port of `GitHistoryProvider` in
 * `extensions/git/src/historyProvider.ts` — the graph view itself is workbench code and is
 * vendored unchanged, but its data source lives in the git extension, which this port has no
 * host for.
 *
 * Three things upstream does are not ported, because each needs the `extensions/github`
 * `SourceControlHistoryItemDetailsProvider` and an authenticated GitHub session: avatars,
 * emoji shortcode expansion, and the message links and hover commands. The tooltip is
 * therefore built here rather than by the extension's `hover.ts`.
 */
export class TauriGitHistoryProvider extends Disposable implements ISCMHistoryProvider {

	private readonly _historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	get historyItemRef(): IObservable<ISCMHistoryItemRef | undefined> { return this._historyItemRef; }

	private readonly _historyItemRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	get historyItemRemoteRef(): IObservable<ISCMHistoryItemRef | undefined> { return this._historyItemRemoteRef; }

	private readonly _historyItemBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	get historyItemBaseRef(): IObservable<ISCMHistoryItemRef | undefined> { return this._historyItemBaseRef; }

	private readonly _historyItemRefChanges = observableValue<ISCMHistoryItemRefsChangeEvent>(this, { added: [], modified: [], removed: [], silent: false });
	get historyItemRefChanges(): IObservable<ISCMHistoryItemRefsChangeEvent> { return this._historyItemRefChanges; }

	private _historyItemRefs: ISCMHistoryItemRef[] = [];
	private _head: IGitHead | undefined;

	/**
	 * `--shortstat` for the commits this provider has already returned. A commit hash is
	 * content-addressed, so an entry can never become wrong — the map has no invalidation
	 * because it has no way to go stale, and it dies with the repository.
	 */
	private readonly _statistics = new Map<string, ISCMHistoryItemStatistics>();

	constructor(
		private readonly client: ScmChannelClient,
		private readonly root: string,
		private readonly decorations: IHistoryItemDecorationSink,
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService
	) {
		super();
	}

	private get commitShortHashLength(): number {
		return this.configurationService.getValue<number>('git.commitShortHashLength') ?? 7;
	}

	//#region Refs

	/**
	 * Port of `onDidRunWriteOperation`. Upstream is driven by the repository's operation
	 * events; here the driver is the contribution's own refresh, which is the one place that
	 * learns a repository changed.
	 */
	async updateRefs(head: IGitHead | undefined): Promise<void> {
		if (!head) {
			this._historyItemRef.set(undefined, undefined);
			this._historyItemRemoteRef.set(undefined, undefined);
			this._historyItemBaseRef.set(undefined, undefined);
			return;
		}

		let refs: IGitRef[];
		try {
			refs = await this.client.refs(this.root);
		} catch (error) {
			this.logService.error(`[git] reading refs of ${this.root} failed`, error);
			return;
		}

		// Refs (alphabetically)
		const historyItemRefs = refs
			.map(ref => this.toSourceControlHistoryItemRef(ref))
			.sort((a, b) => a.id.localeCompare(b.id));

		const delta = deltaHistoryItemRefs(this._historyItemRefs, historyItemRefs);
		this._historyItemRefs = historyItemRefs;

		let historyItemRefId = '';
		let historyItemRefName = '';

		// Upstream switches on `HEAD.type`, which its `getHEAD` sets to `Tag` when
		// `git describe --tags --exact-match` answers. `IGitHead` carries no ref type, so the
		// same question is asked of the refs: a tag standing exactly on the detached commit.
		const tag = head.detached
			? refs.find(ref => ref.kind === GitRefKind.Tag && ref.commit === head.commit)
			: undefined;

		if (tag) {
			historyItemRefId = `refs/tags/${tag.name}`;
			historyItemRefName = tag.name;

			this._historyItemRemoteRef.set(undefined, undefined);
			this._historyItemBaseRef.set(undefined, undefined);
		} else if (head.name !== undefined) {
			// Branch
			historyItemRefId = `refs/heads/${head.name}`;
			historyItemRefName = head.name;

			this._historyItemRemoteRef.set(this.toRemoteRef(head, refs), undefined);
			this._historyItemBaseRef.set(this.resolveBaseRef(head, delta.modified), undefined);
		} else {
			// Detached commit
			historyItemRefId = head.commit ?? '';
			historyItemRefName = head.commit ?? '';

			this._historyItemRemoteRef.set(undefined, undefined);
			this._historyItemBaseRef.set(undefined, undefined);
		}

		this._head = head;
		this._historyItemRef.set({
			id: historyItemRefId,
			name: historyItemRefName,
			revision: head.commit,
			icon: ThemeIcon.fromId('target')
		}, undefined);

		// Upstream's `silent` marks a background auto-fetch. This port has no fetch, so every
		// change is one the user asked for.
		this._historyItemRefChanges.set({ ...delta, silent: false }, undefined);
	}

	/**
	 * Port of the upstream branch's `Remote` arm. `IGitHead.upstream` is the full tracking
	 * ref name, so the local-branch case upstream spells `remote === '.'` is the one recorded
	 * under `refs/heads/`.
	 */
	private toRemoteRef(head: IGitHead, refs: readonly IGitRef[]): ISCMHistoryItemRef | undefined {
		if (!head.upstream) {
			return undefined;
		}

		const revision = refs.find(ref => this.toFullName(ref) === head.upstream)?.commit;

		if (head.upstream.startsWith('refs/heads/')) {
			return {
				id: head.upstream,
				name: head.upstream.substring('refs/heads/'.length),
				revision,
				icon: ThemeIcon.fromId('git-branch')
			};
		}

		return {
			id: head.upstream,
			name: head.upstream.substring('refs/remotes/'.length),
			revision,
			icon: ThemeIcon.fromId('cloud')
		};
	}

	/**
	 * Upstream computes the base from `getBranchBase`, which reads and writes the
	 * `branch.<name>.vscode-merge-base` config key, walks the reflog and falls back to the
	 * remote's default branch. None of the three has a command in this port's `scm` channel,
	 * so the base stays unset — and only its revision-tracking arm is live.
	 */
	private resolveBaseRef(head: IGitHead, modified: readonly ISCMHistoryItemRef[]): ISCMHistoryItemRef | undefined {
		const current = this._historyItemBaseRef.get();
		if (this._head?.name !== head.name || !current) {
			return undefined;
		}

		// Update base revision if it has changed
		const mergeBaseModified = modified.find(ref => ref.id === current.id);
		return mergeBaseModified ? { ...current, revision: mergeBaseModified.revision } : current;
	}

	/** Port of `toSourceControlHistoryItemRef`. */
	private toSourceControlHistoryItemRef(ref: IGitRef): ISCMHistoryItemRef {
		const shortCommit = ref.commit ? truncate(ref.commit, this.commitShortHashLength, false) : undefined;

		switch (ref.kind) {
			case GitRefKind.RemoteHead:
				return {
					id: `refs/remotes/${ref.name}`,
					name: ref.name,
					description: shortCommit ? localize('git.remoteBranchAt', "Remote branch at {0}", shortCommit) : undefined,
					revision: ref.commit,
					icon: ThemeIcon.fromId('cloud'),
					category: localize('git.remoteBranches', "remote branches")
				};
			case GitRefKind.Tag:
				return {
					id: `refs/tags/${ref.name}`,
					name: ref.name,
					description: shortCommit ? localize('git.tagAt', "Tag at {0}", shortCommit) : undefined,
					revision: ref.commit,
					icon: ThemeIcon.fromId('tag'),
					category: localize('git.tags', "tags")
				};
			default:
				return {
					id: `refs/heads/${ref.name}`,
					name: ref.name,
					description: shortCommit,
					revision: ref.commit,
					icon: ThemeIcon.fromId('git-branch'),
					category: localize('git.branches', "branches")
				};
		}
	}

	private toFullName(ref: IGitRef): string {
		switch (ref.kind) {
			case GitRefKind.RemoteHead: return `refs/remotes/${ref.name}`;
			case GitRefKind.Tag: return `refs/tags/${ref.name}`;
			default: return `refs/heads/${ref.name}`;
		}
	}

	//#endregion

	//#region Provider

	/** Port of `provideHistoryItemRefs`: branches, then remote branches, then tags. */
	async provideHistoryItemRefs(historyItemsRefs?: string[]): Promise<ISCMHistoryItemRef[] | undefined> {
		const refs = await this.client.refs(this.root, historyItemsRefs);

		const branches: ISCMHistoryItemRef[] = [];
		const remoteBranches: ISCMHistoryItemRef[] = [];
		const tags: ISCMHistoryItemRef[] = [];

		for (const ref of refs) {
			switch (ref.kind) {
				case GitRefKind.RemoteHead:
					remoteBranches.push(this.toSourceControlHistoryItemRef(ref));
					break;
				case GitRefKind.Tag:
					tags.push(this.toSourceControlHistoryItemRef(ref));
					break;
				default:
					branches.push(this.toSourceControlHistoryItemRef(ref));
					break;
			}
		}

		return [...branches, ...remoteBranches, ...tags];
	}

	/** Port of `provideHistoryItems`. */
	async provideHistoryItems(options: ISCMHistoryOptions, token?: CancellationToken): Promise<ISCMHistoryItem[] | undefined> {
		if (!this._historyItemRef.get() || !options.historyItemRefs) {
			return [];
		}

		// Deduplicate refNames
		const refNames = Array.from(new Set<string>(options.historyItemRefs));

		let logOptions: IGitLogOptions = { refNames };

		try {
			if (options.limit === undefined || typeof options.limit === 'number') {
				logOptions = { ...logOptions, maxEntries: options.limit ?? 50 };
			} else if (typeof options.limit.id === 'string') {
				// Get the common ancestor commit, and commits
				const commit = await this.client.getCommit(this.root, options.limit.id);
				const commitParentId = commit.parents.length > 0 ? commit.parents[0] : await this.client.emptyTree(this.root);

				logOptions = { ...logOptions, range: `${commitParentId}..` };
			}

			if (typeof options.skip === 'number') {
				logOptions = { ...logOptions, skip: options.skip };
			}

			const commits = typeof options.filterText === 'string' && options.filterText !== ''
				? await this._searchHistoryItems(options.filterText.trim(), logOptions)
				: await this.client.log(this.root, logOptions);

			if (token?.isCancellationRequested) {
				return [];
			}

			// The page paints from what is already here; `--shortstat` costs a tree diff per
			// commit, so it lands afterwards through the getters below.
			this._loadStatistics(commits.map(commit => commit.hash));

			return commits.map(commit => this.toHistoryItem(commit));
		} catch (error) {
			this.logService.error(`[git] history items for ${this.root} with options '${JSON.stringify(options)}' failed`, error);
			return [];
		}
	}

	/** Port of `provideHistoryItemChanges`, decorations included. */
	async provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined): Promise<ISCMHistoryItemChange[] | undefined> {
		historyItemParentId = historyItemParentId ?? await this.client.emptyTree(this.root);

		const changes = await this.client.diffBetween(this.root, historyItemParentId, historyItemId);

		const historyItemChanges: ISCMHistoryItemChange[] = [];
		const decorations: { uri: URI; status: GitStatus; letter: string }[] = [];

		for (const change of changes) {
			const historyItemUri = URI.revive(change.resource).with({ query: `ref=${historyItemId}` });

			historyItemChanges.push({
				uri: historyItemUri,
				...toMultiFileDiffEditorUris(change, historyItemParentId, historyItemId)
			});
			decorations.push({ uri: historyItemUri, status: change.status, letter: change.letter });
		}

		this.decorations.addHistoryItemChanges(decorations);
		return historyItemChanges;
	}

	/** Port of `resolveHistoryItemRefsCommonAncestor`. */
	async resolveHistoryItemRefsCommonAncestor(historyItemRefs: string[]): Promise<string | undefined> {
		try {
			const historyItemRef = this._historyItemRef.get();
			const remoteRef = this._historyItemRemoteRef.get();
			const baseRef = this._historyItemBaseRef.get();

			if (historyItemRefs.length === 0) {
				return undefined;
			} else if (historyItemRefs.length === 1 && historyItemRefs[0] === historyItemRef?.id) {
				// Remote
				if (remoteRef) {
					return await this.client.mergeBase(this.root, [historyItemRefs[0], remoteRef.id]) ?? undefined;
				}

				// Base
				if (baseRef) {
					return await this.client.mergeBase(this.root, [historyItemRefs[0], baseRef.id]) ?? undefined;
				}

				// First commit
				const commits = await this.client.log(this.root, { maxParents: 0, refNames: ['HEAD'] });
				if (commits.length > 0) {
					return commits[0].hash;
				}
			} else if (historyItemRefs.length > 1) {
				return await this.client.mergeBase(this.root, historyItemRefs) ?? undefined;
			}
		} catch (error) {
			this.logService.error(`[git] common ancestor of ${historyItemRefs.join(',')} in ${this.root} failed`, error);
		}

		return undefined;
	}

	/**
	 * The three chat entry points. `contrib/chat` is cut from this port, and
	 * `resolveHistoryItem` is only ever called from it, so all three answer `undefined`.
	 */
	async resolveHistoryItem(): Promise<ISCMHistoryItem | undefined> {
		return undefined;
	}

	async resolveHistoryItemChatContext(): Promise<string | undefined> {
		return undefined;
	}

	async resolveHistoryItemChangeRangeChatContext(): Promise<string | undefined> {
		return undefined;
	}

	//#endregion

	//#region History items

	/**
	 * `statistics` and `tooltip` are getters over the statistics map, because
	 * `toHistoryItemHoverContent` reads `tooltip` at hover time rather than at render time.
	 * That is what lets a page paint before its `--shortstat` has been computed: a hover in
	 * the first moment after the paint omits the statistics line, and the next one has it.
	 */
	private toHistoryItem(commit: IGitCommit): ISCMHistoryItem {
		const references = this._resolveHistoryItemRefs(commit);
		const statistics = this._statistics;

		return {
			id: commit.hash,
			parentIds: commit.parents,
			subject: subject(commit.message),
			message: commit.message,
			author: commit.authorName,
			authorEmail: commit.authorEmail,
			authorIcon: ThemeIcon.fromId('account'),
			displayId: truncate(commit.hash, this.commitShortHashLength, false),
			timestamp: commit.authorDate * 1000,
			references: references.length !== 0 ? references : undefined,
			get statistics(): ISCMHistoryItemStatistics | undefined {
				return statistics.get(commit.hash);
			},
			get tooltip(): IMarkdownString[] {
				return buildTooltip(commit, statistics.get(commit.hash));
			}
		};
	}

	/** Port of `_resolveHistoryItemRefs`, over `%D`'s four spellings. */
	private _resolveHistoryItemRefs(commit: IGitCommit): ISCMHistoryItemRef[] {
		const references: ISCMHistoryItemRef[] = [];

		for (const ref of commit.refNames) {
			if (ref === 'refs/remotes/origin/HEAD') {
				continue;
			}

			switch (true) {
				case ref.startsWith('HEAD -> refs/heads/'):
					references.push({
						id: ref.substring('HEAD -> '.length),
						name: ref.substring('HEAD -> refs/heads/'.length),
						revision: commit.hash,
						category: localize('git.branches', "branches"),
						icon: ThemeIcon.fromId('target')
					});
					break;
				case ref.startsWith('refs/heads/'):
					references.push({
						id: ref,
						name: ref.substring('refs/heads/'.length),
						revision: commit.hash,
						category: localize('git.branches', "branches"),
						icon: ThemeIcon.fromId('git-branch')
					});
					break;
				case ref.startsWith('refs/remotes/'):
					references.push({
						id: ref,
						name: ref.substring('refs/remotes/'.length),
						revision: commit.hash,
						category: localize('git.remoteBranches', "remote branches"),
						icon: ThemeIcon.fromId('cloud')
					});
					break;
				case ref.startsWith('tag: refs/tags/'):
					references.push({
						id: ref.substring('tag: '.length),
						name: ref.substring('tag: refs/tags/'.length),
						revision: commit.hash,
						category: localize('git.tags', "tags"),
						icon: ThemeIcon.fromId('tag')
					});
					break;
			}
		}

		return references.sort(compareSourceControlHistoryItemRef);
	}

	/** Port of `_searchHistoryItems`: an author search and a grep search, merged by hash. */
	private async _searchHistoryItems(filterText: string, options: IGitLogOptions): Promise<IGitCommit[]> {
		const commits = new Map<string, IGitCommit>();

		const [authorResults, grepResults] = await Promise.all([
			this.client.log(this.root, { ...options, refNames: undefined, author: filterText }),
			this.client.log(this.root, { ...options, refNames: undefined, grep: filterText })
		]);

		for (const commit of [...authorResults, ...grepResults]) {
			if (!commits.has(commit.hash)) {
				commits.set(commit.hash, commit);
			}
		}

		return Array.from(commits.values()).slice(0, options.maxEntries ?? 50);
	}

	/** One `commitStats` call for a whole page, for the hashes the map does not have yet. */
	private _loadStatistics(hashes: readonly string[]): void {
		const missing = hashes.filter(hash => !this._statistics.has(hash));
		if (missing.length === 0) {
			return;
		}

		this.client.commitStats(this.root, missing).then(stats => {
			for (const [hash, statistics] of Object.entries(stats)) {
				this._statistics.set(hash, statistics);
			}
		}, error => {
			this.logService.error(`[git] commit statistics for ${this.root} failed`, error);
		});
	}

	//#endregion

	override dispose(): void {
		this._statistics.clear();
		super.dispose();
	}
}

/**
 * A port of `getHistoryItemHover` in `extensions/git/src/hover.ts`, reduced to what this port
 * can supply: no avatar, no emoji expansion, no co-authors, and no commands section.
 *
 * The sectioning is upstream's and load-bearing in two ways. `supportHtml` is set on the
 * statistics string alone, so the commit message — repo-controlled text — cannot style its own
 * hover the way `scmHistory.ts` styles its reference chips. And `toHistoryItemHoverContent`
 * returns early for a lone markdown string, so only the array form reaches the code that
 * splices the graph-coloured branch and tag chips in before the last section.
 */
function buildTooltip(commit: IGitCommit, statistics: ISCMHistoryItemStatistics | undefined): IMarkdownString[] {
	const hoverContent: IMarkdownString[] = [];

	// Author, Date, Message (escape image syntax)
	const authorMarkdownString = new MarkdownString('', { supportThemeIcons: true });
	appendContent(authorMarkdownString, commit);
	hoverContent.push(authorMarkdownString);

	// Short stats
	if (statistics) {
		const shortStatsMarkdownString = new MarkdownString('', { supportThemeIcons: true, supportHtml: true });
		appendShortStats(shortStatsMarkdownString, statistics);
		hoverContent.push(shortStatsMarkdownString);
	}

	return hoverContent;
}

/** Port of `appendContent`, minus the avatar and the co-authors. */
function appendContent(markdownString: MarkdownString, commit: IGitCommit): void {
	// Author
	markdownString.appendMarkdown('$(account)');
	if (commit.authorEmail) {
		markdownString.appendMarkdown(' [**');
		markdownString.appendText(commit.authorName);
		markdownString.appendMarkdown('**](mailto:');
		markdownString.appendText(commit.authorEmail);
		markdownString.appendMarkdown(')');
	} else {
		markdownString.appendMarkdown(' **');
		markdownString.appendText(commit.authorName);
		markdownString.appendMarkdown('**');
	}

	// Date
	const authorDate = commit.authorDate * 1000;
	if (authorDate && !isNaN(new Date(authorDate).getTime())) {
		const dateString = new Date(authorDate).toLocaleString(undefined, {
			year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric'
		});

		markdownString.appendMarkdown(', $(history)');
		markdownString.appendText(` ${fromNow(authorDate, true, true)} (${dateString})`);
	}
	markdownString.appendMarkdown('\n\n');

	// Message (escape image syntax)
	markdownString.appendMarkdown(commit.message.replace(/!\[/g, '&#33;&#91;').replace(/\r\n|\r|\n/g, '\n\n'));
	markdownString.appendMarkdown('\n\n---\n\n');
}

/** Port of `appendShortStats`. */
function appendShortStats(markdownString: MarkdownString, statistics: ISCMHistoryItemStatistics): void {
	markdownString.appendMarkdown(`<span>${statistics.files === 1
		? localize('git.fileChanged', "{0} file changed", statistics.files)
		: localize('git.filesChanged', "{0} files changed", statistics.files)}</span>`);

	if (statistics.insertions) {
		markdownString.appendMarkdown(`,&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground);">${statistics.insertions === 1
			? localize('git.insertion', "{0} insertion{1}", statistics.insertions, '(+)')
			: localize('git.insertions', "{0} insertions{1}", statistics.insertions, '(+)')}</span>`);
	}

	if (statistics.deletions) {
		markdownString.appendMarkdown(`,&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground);">${statistics.deletions === 1
			? localize('git.deletion', "{0} deletion{1}", statistics.deletions, '(-)')
			: localize('git.deletions', "{0} deletions{1}", statistics.deletions, '(-)')}</span>`);
	}

	markdownString.appendMarkdown('\n\n---\n\n');
}
