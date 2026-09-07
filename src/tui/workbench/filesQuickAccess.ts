/*---------------------------------------------------------------------------------------------
 *  `Ctrl+P`: the workspace's files, by name.
 *
 *  This is the *default* quick access provider — the one a value with no prefix reaches, which is
 *  what `workbench.action.quickOpen` opens — and it is a stated partial of upstream's
 *  `AnythingQuickAccessProvider`. What it keeps is that provider's file half, member for member:
 *  `getFileQueryOptions`' options object including `_reason` and `extraFileResources`,
 *  `getFileSearchResults`' rule for a query with several values (search for the first and let the
 *  scorer drop the rest), and `getAdditionalPicks`' scoring pass — `top` over
 *  `compareItemsByFuzzyScore`, then `scoreItemFuzzy` per pick for the highlights, both through
 *  upstream's own `quickPickItemScorerAccessor`. So nothing about which files match, in what order,
 *  or where the match is drawn is derived here.
 *
 *  **What it does not keep, and why it is a partial rather than a cut.** `AnythingQuickAccessProvider`
 *  is 1,122 lines and costs 24 files / 9,236 lines of closure, and four of the things it is made of
 *  have nothing to bind to in this fork: the editor-history picks need `IHistoryService`, the label
 *  needs `ICustomEditorLabelService`, `PickerEditorState` and `openAnything` need an `IEditorService`
 *  that can open and restore an editor, which this one cannot — and the symbol picks are
 *  `SymbolsQuickAccessProvider` and `GotoSymbolQuickAccessProvider` over an
 *  `ILanguageFeaturesService` no extension host contributes to. Cutting those out in place would
 *  have left a rewritten `openAnything` in a vendored file, which is exactly what §1.1's invariant
 *  forbids. So the file half is here and the vendored file is untouched.
 *
 *  Also absent, and each is a arm rather than a mechanism: the absolute-path result, the
 *  relative-path result, the file-query cache warmed on open, and the second search a limit-hit
 *  multi-value query triggers.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/search/browser/anythingQuickAccess.ts
 *--------------------------------------------------------------------------------------------*/

import { top } from '../../vs/base/common/arrays.js';
import { CancellationToken } from '../../vs/base/common/cancellation.js';
import { compareItemsByFuzzyScore, FuzzyScorerCache, IPreparedQuery, prepareQuery, scoreItemFuzzy } from '../../vs/base/common/fuzzyScorer.js';
import { basenameOrAuthority, dirname } from '../../vs/base/common/resources.js';
import { URI } from '../../vs/base/common/uri.js';
import { localize } from '../../vs/nls.js';
import { ICommandService } from '../../vs/platform/commands/common/commands.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../vs/platform/label/common/label.js';
import { IPickerQuickAccessItem, PickerQuickAccessProvider, Picks } from '../../vs/platform/quickinput/browser/pickerQuickAccess.js';
import { IQuickInputService, IQuickPickItemWithResource, quickPickItemScorerAccessor } from '../../vs/platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { getOutOfWorkspaceEditorResources } from '../../vs/workbench/contrib/search/common/search.js';
import { IFileQueryBuilderOptions, QueryBuilder } from '../../vs/workbench/services/search/common/queryBuilder.js';
import { ISearchService } from '../../vs/workbench/services/search/common/search.js';
import type { TerminalQuickInputService } from './quickInput.js';

interface IFileQuickPickItem extends IPickerQuickAccessItem, IQuickPickItemWithResource { }

export class FilesQuickAccessProvider extends PickerQuickAccessProvider<IFileQuickPickItem> {

	/** The default provider: a value with no prefix is a file name. */
	static readonly PREFIX = '';

	private static readonly MAX_RESULTS = 512;

	private readonly fileQueryBuilder: QueryBuilder;

	private scorerCache: FuzzyScorerCache = Object.create(null);

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
		super(FilesQuickAccessProvider.PREFIX, {
			noResultsPick: { label: localize('noAnythingResults', "No matching results") }
		});

		this.fileQueryBuilder = instantiationService.createInstance(QueryBuilder);
	}

	protected _getPicks(filter: string, _disposables: unknown, token: CancellationToken): Promise<Picks<IFileQuickPickItem>> | Picks<IFileQuickPickItem> {
		const query = prepareQuery(filter);
		if (!query.normalized) {
			return [];
		}

		return this.getFilePicks(query, token);
	}

	/**
	 * `AnythingQuickAccessProvider.getAdditionalPicks`' second half over its `getFilePicks`: the
	 * search's results scored and cut to the same 512, then scored again per pick so the run the
	 * query matched is the run that is drawn.
	 */
	private async getFilePicks(query: IPreparedQuery, token: CancellationToken): Promise<Picks<IFileQuickPickItem>> {
		const resources = await this.getFileSearchResults(query, token);
		if (token.isCancellationRequested) {
			return [];
		}

		const sorted = top(
			resources.map(resource => this.createPick(resource)),
			(pickA, pickB) => compareItemsByFuzzyScore(pickA, pickB, query, true, quickPickItemScorerAccessor, this.scorerCache),
			FilesQuickAccessProvider.MAX_RESULTS
		);

		const picks: IFileQuickPickItem[] = [];
		for (const pick of sorted) {
			const { score, labelMatch, descriptionMatch } = scoreItemFuzzy(pick, query, true, quickPickItemScorerAccessor, this.scorerCache);
			if (!score) {
				continue;
			}

			pick.highlights = { label: labelMatch, description: descriptionMatch };
			picks.push(pick);
		}

		return picks;
	}

	/**
	 * `getFileSearchResults`' filePattern rule, which is the one thing about this that is not
	 * obvious: a query of several words searches for the *first* and lets the scorer above drop what
	 * the rest do not match, so "someFile someFolder" returns what "someFile" does rather than
	 * nothing.
	 */
	private async getFileSearchResults(query: IPreparedQuery, token: CancellationToken): Promise<URI[]> {
		const filePattern = query.values && query.values.length > 1 ? query.values[0].original : query.original;

		const results = await this.searchService.fileSearch(
			this.fileQueryBuilder.file(
				this.contextService.getWorkspace().folders,
				this.getFileQueryOptions({ filePattern, maxResults: FilesQuickAccessProvider.MAX_RESULTS })
			), token);

		return results.results.map(result => result.resource);
	}

	private getFileQueryOptions(input: { filePattern?: string; maxResults?: number }): IFileQueryBuilderOptions {
		return {
			_reason: 'openFileHandler', // used for telemetry - do not change
			extraFileResources: this.instantiationService.invokeFunction(getOutOfWorkspaceEditorResources),
			filePattern: input.filePattern || '',
			maxResults: input.maxResults || 0,
			sortByScore: true
		};
	}

	/**
	 * The name, the folder it is in, and what opening it does. `vscode.open` is the command every
	 * other row in this fork opens a file with (`tui/editor/editorCommands.ts`); the open is tracked
	 * because `PickerQuickAccessProvider` drops what `accept` returns, and a driven run would then
	 * read the screen in front of the editor it asked for.
	 */
	private createPick(resource: URI): IFileQuickPickItem {
		return {
			resource,
			label: basenameOrAuthority(resource),
			description: this.labelService.getUriLabel(dirname(resource), { relative: true }),
			accept: () => (this.quickInputService as TerminalQuickInputService)
				.track(this.commandService.executeCommand('vscode.open', resource))
		};
	}
}
