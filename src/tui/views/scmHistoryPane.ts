/*---------------------------------------------------------------------------------------------
 *  The source control graph, in a terminal.
 *
 *  Nothing here decides what is in the graph. `TauriGitHistoryProvider` answers the history items —
 *  `git.contribution.ts` constructs one per repository and `SCMService` counts them into
 *  `scm.historyProviderCount`, which is the key `views.ts` gates this region on. `SCMHistoryViewModel`
 *  picks the repository, resolves the reference filter, reads the page size and calls
 *  `toISCMHistoryItemViewModelArray`, which assigns the swimlanes and their colours; and
 *  `scmHistoryText.ts` turns one row's swimlanes into cells. This file is the rows and the reload
 *  triggers, and it computes no column, no colour and no ordering.
 *
 *  `SCMHistoryViewModel` is the vendored view model — `scmHistoryViewPane.ts` cut to it, exactly as
 *  T06 cut `scmViewPane.ts` to its data source — so the repository choice, the `auto` filter and the
 *  incoming/outgoing nodes are upstream's answers rather than a second set.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout, Throttler } from '../../vs/base/common/async.js';
import { KeyCode } from '../../vs/base/common/keyCodes.js';
import { autorun, derived, runOnChange, waitForState } from '../../vs/base/common/observable.js';
import { localize } from '../../vs/nls.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { descriptionForeground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { SCMHistoryViewModel } from '../../vs/workbench/contrib/scm/browser/scmHistoryViewPane.js';
import { RepositoryPicker } from '../../vs/workbench/contrib/scm/browser/scmViewService.js';
import { SCMHistoryItemViewModelTreeElement } from '../../vs/workbench/contrib/scm/common/history.js';
import { HISTORY_VIEW_PANE_ID, ISCMViewService } from '../../vs/workbench/contrib/scm/common/scm.js';
import { renderSCMHistoryItemGraphText } from '../../vs/workbench/contrib/scm/tauri/scmHistoryText.js';
import { registerPaneCommand } from '../workbench/commands.js';
import { Pane } from '../workbench/pane.js';
import { ILine, ISpan } from '../terminal/screen.js';
import type { IDomRenderRecords } from '../terminal/dom/renderRecords.js';
import { FlatListControllerEvent, FlatListProjectionGateway, flatListProjectionIdentity, flatListSnapshot } from '../../workbench/flatListProjection.js';
import { lineRenderRecords } from '../../render/domRecords.js';

/**
 * How long `open()` will wait for the first repository's references. It is a bound rather than a
 * duration: the read behind it is one `gix` call that has already been started, and what the bound is
 * for is the case where it never answers.
 */
const REFS_TIMEOUT = 2000;

export function scmHistoryProjectionIdentity(historyItemId: string | undefined): { readonly id: string; readonly actionId: string } {
	return flatListProjectionIdentity('scm-history', historyItemId ?? 'status');
}

export class SCMHistoryPane extends Pane {

	readonly viewId = HISTORY_VIEW_PANE_ID;
	readonly title = localize('scmGraphPane', "Graph");

	private readonly viewModel: SCMHistoryViewModel;

	/** One reload at a time, and bursts collapsed — `SCMHistoryViewPane._refreshThrottler`. */
	private readonly throttler = new Throttler();

	private rows: readonly SCMHistoryItemViewModelTreeElement[] = [];
	private status: string | undefined = localize('scmGraph.loading', "Loading…");
	private flatGeneration = 1;
	readonly flatListProjection: FlatListProjectionGateway<IDomRenderRecords>;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IThemeService themeService: IThemeService,
		@ILogService private readonly logService: ILogService
	) {
		super(themeService);
		this.flatListProjection = this._register(new FlatListProjectionGateway(
			flatListSnapshot(1, []), event => this.handleFlatInput(event)));
		this._register(this.onDidChange(() => this.publishFlatProjection()));

		this.viewModel = this._register(instantiationService.createInstance(SCMHistoryViewModel));

		this._register(registerPaneCommand(this.viewId, {
			id: 'tscode.scmGraph.refresh',
			title: localize('tscode.scmGraph.refresh', "Refresh"),
			primary: KeyCode.KeyR,
			handler: () => this.track(this.refresh())
		}));

		// `SCMHistoryViewPane.pickRepository`, at upstream's own command id. Upstream reaches it
		// from a `MenuId.SCMHistoryTitle` toolbar item, which is a click on a view title; a terminal
		// has no title bar to click, so it is a key. The picker is `scmViewService.ts`'s
		// `RepositoryPicker` rather than the copy `scmHistoryViewPane.ts` keeps of it — one class,
		// with the graph's own two strings passed in.
		this._register(registerPaneCommand(this.viewId, {
			id: 'workbench.scm.action.graph.pickRepository',
			title: localize('repositoryPicker', "Repository Picker"),
			primary: KeyCode.KeyP,
			handler: () => this.track(this.pickRepository())
		}));

		this.registerTriggers();
		this.publishFlatProjection();
	}

	private flatIdentity(index: number): { readonly id: string; readonly actionId: string } {
		return scmHistoryProjectionIdentity(this.status !== undefined ? undefined : this.rows[index].historyItemViewModel.historyItem.id);
	}

	private publishFlatProjection(): void {
		const records = Array.from({ length: this.rowCount }, (_, index) => {
			const identity = this.flatIdentity(index);
			const line = this.renderRow(index, false);
			const render = lineRenderRecords(line);
			return {
				...identity, order: index, accessibleLabel: render.accessibleLabel,
				render,
				selected: index === this.focus, focused: index === this.focus
			};
		});
		const actions = new Set(records.map(record => record.actionId));
		this.flatListProjection.publish(flatListSnapshot(++this.flatGeneration, records, actions));
	}

	private handleFlatInput(event: FlatListControllerEvent): void {
		const actionIds = event.kind === 'select' ? event.actionIds : event.actionId ? [event.actionId] : [];
		const actionId = actionIds[0];
		if (!actionId) { return; }
		const index = Array.from({ length: this.rowCount }, (_, at) => at)
			.find(at => this.flatIdentity(at).actionId === actionId);
		if (index === undefined) { return; }
		this.focusTo(index);
		if (event.kind === 'open') { this.handleKey({ name: 'enter', sequence: '\r' }); }
	}

	get rowCount(): number {
		return this.status !== undefined ? 1 : this.rows.length;
	}

	/**
	 * **Upstream's own wait, and it is load-bearing.** `SCMHistoryViewPane` awaits
	 * `waitForState(firstRepositoryInitialized)` before its first render, because the `auto` reference
	 * filter is the history item's own ref and `updateRefs` is a read `git.contribution.ts` starts and
	 * does not await — so a fetch issued before it lands asks for zero refs and gets zero commits.
	 * Measured: without this the graph read "No source control history items." and filled in a moment
	 * later, and a keystroke replayed into that moment moved nothing.
	 *
	 * The wait is bounded and only entered when a provider exists, because `open()` is awaited at boot:
	 * a workspace with no repository never reaches that state, and a refs read that fails leaves it
	 * unreached for ever.
	 */
	override async open(): Promise<void> {
		const initialized = derived(this, reader => {
			const repository = this.viewModel.repository.read(reader);
			const historyProvider = repository?.provider.historyProvider.read(reader);

			return historyProvider?.historyItemRef.read(reader) !== undefined ? true : undefined;
		});

		if (this.viewModel.repository.get()?.provider.historyProvider.get()) {
			await raceTimeout(waitForState(initialized), REFS_TIMEOUT);
		}

		await this.refresh();
	}

	/** `SCMHistoryViewPane.pickRepository`, body unchanged. */
	private async pickRepository(): Promise<void> {
		const picker = this.instantiationService.createInstance(RepositoryPicker,
			localize('scmGraphRepository', "Select the repository to view, type to filter all repositories"),
			localize('activeRepository', "Show the source control graph for the active repository"));

		const result = await picker.pickRepository();
		if (result) {
			this.viewModel.setRepository(result.repository);
		}
	}

	/**
	 * `SCMHistoryViewPane.onDidChangeBodyVisibility`'s reload triggers, minus the ones that need a
	 * widget: the "Outdated" badge a silent ref change raises has no terminal counterpart, so a
	 * background fetch reloads instead of marking the view stale, and the view-mode and file-icon-theme
	 * arms belong to a tree this pane does not have.
	 */
	private registerTriggers(): void {
		this._register(runOnChange(this.scmViewService.graphShowIncomingChangesConfig, () => this.track(this.refresh())));
		this._register(runOnChange(this.scmViewService.graphShowOutgoingChangesConfig, () => this.track(this.refresh())));

		// Repository change
		let isFirstRun = true;
		this._register(autorun(reader => {
			const repository = this.viewModel.repository.read(reader);
			const historyProvider = repository?.provider.historyProvider.read(reader);
			if (!repository || !historyProvider) {
				return;
			}

			// HistoryItemId changed (checkout)
			const historyItemRefId = derived(reader => historyProvider.historyItemRef.read(reader)?.id);
			reader.store.add(runOnChange(historyItemRefId, () => this.track(this.refresh())));

			// HistoryItemRefs changed
			reader.store.add(runOnChange(historyProvider.historyItemRefChanges, () => this.track(this.refresh())));

			// HistoryItemRefs filter changed
			reader.store.add(runOnChange(this.viewModel.onDidChangeHistoryItemsFilter, () => this.track(this.refresh())));

			// We skip refreshing the graph on the first execution of the autorun
			// since the graph for the first repository is rendered when the tree
			// input is set.
			if (!isFirstRun) {
				this.track(this.refresh());
			}
			isFirstRun = false;
		}));
	}

	/** `SCMHistoryViewPane._refresh`: the repository's page state dropped, then read again. */
	private refresh(): Promise<void> {
		return this.throttler.queue(async () => {
			this.viewModel.clearRepositoryState();

			try {
				this.rows = await this.viewModel.getHistoryItems();
			} catch (error) {
				this.logService.error('[tui] cannot read the source control graph', error);
				this.setStatus(localize('scmGraph.failed', "Reading the graph failed. See the log for details."));

				return;
			}

			this.setStatus(this.rows.length === 0 ? localize('scmGraph.empty', "No source control history items.") : undefined);
		});
	}

	private setStatus(status: string | undefined): void {
		this.status = status;
		this.didChangeRows();
	}

	/**
	 * The repository selector is a title action upstream. Frontends without a view-title toolbar
	 * project the same action as one header line; its command remains the pane-owned P binding above.
	 * Keeping the label in the pane snapshot gives native layout and accessibility one immutable
	 * source instead of inventing a Mac-only title model.
	 */
	protected override header(): ILine[] {
		return [[{ text: localize('repositoryPicker', "Repository Picker") }]];
	}

	/**
	 * The graph, then what `HistoryItemRenderer` puts beside it: the subject, the references, and the
	 * author as the label's description.
	 *
	 * A reference is a name here rather than a badge. Upstream's badge is a coloured pill carrying the
	 * ref's codicon and, for the first coloured one, its name — so without an icon font the name is
	 * what is left, in the colour `toISCMHistoryItemViewModelArray` gave that ref.
	 */
	protected renderRow(index: number, focused: boolean): ILine {
		const theme = this.themeService.getColorTheme();

		if (this.status !== undefined) {
			return [{ text: ` ${this.status}`, fg: theme.getColor(descriptionForeground) }];
		}

		const { historyItemViewModel } = this.rows[index];
		const historyItem = historyItemViewModel.historyItem;
		const { fg, bg } = this.rowStyle(index, focused);
		const description = focused ? fg : theme.getColor(descriptionForeground);

		const spans: ISpan[] = renderSCMHistoryItemGraphText(historyItemViewModel)
			.map(cell => ({ text: cell.text, fg: cell.color ? theme.getColor(cell.color) : fg, bg }));

		spans.push({ text: ` ${historyItem.subject}`, fg, bg });

		for (const reference of historyItem.references ?? []) {
			spans.push({ text: `  ${reference.name}`, fg: reference.color ? theme.getColor(reference.color) : description, bg });
		}

		if (historyItem.author) {
			spans.push({ text: `  ${historyItem.author}`, fg: description, bg });
		}

		return spans;
	}
}
