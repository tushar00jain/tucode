/*---------------------------------------------------------------------------------------------
 * SearchView owns queries, results, refresh and selection; this adapter paints terminal cells
 * and transports input to its ordinary FindInput/ReplaceInput and tree widgets.
 * Upstream counterpart: src/vs/workbench/contrib/search/browser/searchView.ts
 *--------------------------------------------------------------------------------------------*/
import '../../vs/workbench/contrib/search/browser/media/searchview.css';
import './media/search.css';
import { KeyCode, KeyMod } from '../../vs/base/common/keyCodes.js';
import { localize } from '../../vs/nls.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { inputActiveOptionBackground, inputActiveOptionForeground, inputBackground, inputForeground, inputPlaceholderForeground } from '../../vs/platform/theme/common/colors/inputColors.js';
import { searchResultsInfoForeground } from '../../vs/platform/theme/common/colors/searchColors.js';
import { SearchView } from '../../vs/workbench/contrib/search/browser/searchView.js';
import { SearchDelegate } from '../../vs/workbench/contrib/search/browser/searchResultsView.js';
import { ISearchResult, RenderableMatch } from '../../vs/workbench/contrib/search/browser/searchTreeModel/searchTreeCommon.js';
import { SearchCommandIds, SearchContext } from '../../vs/workbench/contrib/search/common/constants.js';
import { VIEW_ID } from '../../vs/workbench/services/search/common/search.js';
import { TerminalElement } from '../terminal/dom/document.js';
import { IKey } from '../terminal/input.js';
import { ILine, ISpan } from '../terminal/screen.js';
import { TreePane } from '../workbench/treePane.js';
import { registerPaneCommand } from '../workbench/commands.js';
import { inputSpans, INPUT_EDITING_HINT } from '../workbench/inputBox.js';
import { TREE_NAVIGATION_HINT } from '../workbench/pane.js';
import { filterHeader } from './viewRoot.js';

export class SearchPane extends TreePane<ISearchResult, RenderableMatch, void> {
	readonly viewId = VIEW_ID;
	protected readonly view: SearchView;
	protected readonly tree;
	protected readonly container: TerminalElement;
	private viewportRows = 1;
	constructor(@IInstantiationService instantiation: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@IThemeService theme: IThemeService) {
		super(theme);
		this.view = this._register(instantiation.createInstance(SearchView, {
			id: VIEW_ID, title: localize('searchPane', "Search"), expanded: true, explicitResultOpening: true, showReplace: false
		}));
		this.view.headerVisible = false;
		this.view.render();
		this.tree = this.view.getControl();
		this.container = this.view.element as unknown as TerminalElement;
		this.container.classList.add('terminal-search');
		this.bindTree(configuration, ['search-view', 'show-file-icons', 'file-icon-themable-tree']);
		this._register(this.tree.onDidOpen(() => this.trackSearch()));
		this.view.setVisible(true);
		this._register(this.view.model.onSearchResultChanged(() => this.repaint()));
		this.registerCommands();
	}
	protected get rootController() { return this.view.rootController; }
	protected get treeHeight(): number { return (this.viewportRows + 2) * SearchDelegate.ITEM_HEIGHT + this.rootController.height; }
	override layout(height: number, width?: number): ILine[] {
		this.viewportRows = Math.max(1, height - this.header().length);
		return super.layout(height, width);
	}
	protected override renderRow(index: number, focused: boolean): ILine {
		// The browser tree virtualizes its DOM rows; its viewport follows the terminal's cells.
		this.tree.scrollTop = this.scrollTop * SearchDelegate.ITEM_HEIGHT;
		return super.renderRow(index, focused);
	}
	override get canEdit(): boolean { return true; }
	override async open(): Promise<void> { await this.view.whenSettled(); }
	override get hint(): string {
		return this.filtering ? `type to filter · Enter pick · ${INPUT_EDITING_HINT}`
			: this.editing ? `type to search · Enter search · ${INPUT_EDITING_HINT}`
				: this.rowCount ? TREE_NAVIGATION_HINT : 'I search';
	}
	override setEditing(editing: boolean): boolean {
		if (this.filtering) { return super.setEditing(editing); }
		if (editing === this.editing) { return false; }
		if (editing) { this.view.searchAndReplaceWidget.focus(); } else { this.tree.domFocus(); }
		this.repaint(); return true;
	}
	override setTextInputValue(value: string): boolean {
		const changed = super.setTextInputValue(value);
		if (changed && !this.filtering) { this.trackSearch(); }
		return changed;
	}
	override handleKey(key: IKey): boolean {
		const handled = super.handleKey(key);
		if (handled) { this.trackSearch(); }
		return handled;
	}
	private trackSearch(): void { this.track(this.view.whenSettled()); this.repaint(); }
	private registerCommands(): void {
		const run = (action: () => void) => () => { action(); this.trackSearch(); };
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.ToggleCaseSensitiveCommandId, title: 'Toggle Case Sensitive', primary: KeyCode.KeyC, handler: run(() => this.view.toggleCaseSensitive()) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.ToggleWholeWordCommandId, title: 'Toggle Whole Word', primary: KeyCode.KeyW, handler: run(() => this.view.toggleWholeWords()) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.ToggleRegexCommandId, title: 'Toggle Regex', primary: KeyCode.KeyR, handler: run(() => this.view.toggleRegex()) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.ToggleQueryDetailsActionId, title: 'Toggle Query Details', primary: KeyCode.KeyD, handler: run(() => this.view.toggleQueryDetails(false)) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.FocusNextInputActionId, title: 'Focus Next Input', primary: KeyMod.CtrlCmd | KeyCode.DownArrow, whileEditing: true, handler: run(() => { if (!this.filtering) { this.view.focusNextInputBox(); } }) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.FocusPreviousInputActionId, title: 'Focus Previous Input', primary: KeyMod.CtrlCmd | KeyCode.UpArrow, whileEditing: true, handler: run(() => { if (!this.filtering) { this.view.focusPreviousInputBox(); } }) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.ReplaceInFilesActionId, title: 'Replace in Files', primary: KeyCode.KeyH, handler: run(() => { this.view.searchAndReplaceWidget.toggleReplace(true); this.view.searchAndReplaceWidget.focus(true, true); }) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.CloseReplaceWidgetActionId, title: 'Close Replace Widget', primary: KeyMod.Shift | KeyCode.KeyH, when: SearchContext.ReplaceActiveKey, handler: run(() => { this.view.searchAndReplaceWidget.toggleReplace(false); this.view.searchAndReplaceWidget.focus(); }) }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.TogglePreserveCaseId, title: 'Toggle Preserve Case', primary: KeyCode.KeyP, when: SearchContext.ReplaceActiveKey, handler: run(() => this.view.togglePreserveCase()) }));
		this._register(registerPaneCommand(VIEW_ID, { id: 'tscode.search.filter', title: 'Filter', primary: KeyCode.Slash, handler: () => { this.rootController.open(); this.trackRoot(); } }));
		this._register(registerPaneCommand(VIEW_ID, { id: SearchCommandIds.ReplaceActionId, title: 'Replace', primary: KeyMod.Shift | KeyCode.KeyR, when: SearchContext.ReplaceActiveKey, handler: () => this.track(this.view.model.searchResult.batchReplace(this.tree.getFocus()).then(() => this.view.whenSettled())) }));
	}
	protected override activateHeaderSegment(actionId: string): boolean {
		const target = this.inputs.find(input => `search-box:${input.id}` === actionId);
		if (!target) { return actionId === 'view-root-filter'; }
		target.focus(); this.repaint(); return true;
	}
	private get inputs() {
		const widget = this.view.searchAndReplaceWidget;
		return [{ id: 'pattern', value: widget.searchInput?.getValue() ?? '', placeholder: '', focused: widget.searchInputHasFocus(), focus: () => widget.focus() },
			...(widget.isReplaceShown() ? [{ id: 'replace', value: widget.getReplaceValue(), placeholder: 'Replace', focused: widget.replaceInputHasFocus(), focus: () => widget.focus(true, true) }] : []),
			...(this.view.queryDetailsVisible ? [
				{ id: 'includePattern', value: this.view.searchIncludePattern.getValue(), placeholder: 'files to include', focused: this.view.searchIncludePattern.inputHasFocus(), focus: () => this.view.searchIncludePattern.focus() },
				{ id: 'excludePattern', value: this.view.searchExcludePattern.getValue(), placeholder: 'files to exclude', focused: this.view.searchExcludePattern.inputHasFocus(), focus: () => this.view.searchExcludePattern.focus() }
			] : [])];
	}
	override header(): ILine[] {
		const theme = this.themeService.getColorTheme();
		const widget = this.view.searchAndReplaceWidget;
		return [...this.inputs.map(input => {
			const bg = theme.getColor(inputBackground);
			const actionId = `search-box:${input.id}`;
			return [{ text: ' ', bg, actionId }, ...inputSpans(input.value, input.placeholder, input.focused, {
				fg: theme.getColor(inputForeground) ?? theme.getColor(foreground), placeholderFg: theme.getColor(inputPlaceholderForeground), bg, actionId
			}), ...this.toggleSpans(input.id === 'pattern' ? [
				{ label: 'Aa', on: !!widget.searchInput?.getCaseSensitive() }, { label: 'ab', on: !!widget.searchInput?.getWholeWords() }, { label: '.*', on: !!widget.searchInput?.getRegex() }
			] : input.id === 'replace' ? [{ label: 'AB', on: this.view.model.preserveCase }] : [])];
		}), [{ text: ` ${this.view.resultMessage}`, fg: theme.getColor(searchResultsInfoForeground) }],
		...filterHeader(theme, undefined, this.rootController.query, 'filter results')];
	}
	private toggleSpans(toggles: readonly { label: string; on: boolean }[]): ISpan[] {
		const theme = this.themeService.getColorTheme();
		return toggles.flatMap(({ label, on }) => [{ text: ' ', bg: theme.getColor(inputBackground) }, {
			text: label, fg: theme.getColor(on ? inputActiveOptionForeground : inputPlaceholderForeground) ?? theme.getColor(foreground),
			bg: theme.getColor(on ? inputActiveOptionBackground : inputBackground)
		}]).concat(toggles.length ? [{ text: ' ', bg: theme.getColor(inputBackground) }] : []);
	}
}
