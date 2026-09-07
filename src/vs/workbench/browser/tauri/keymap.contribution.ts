/*---------------------------------------------------------------------------------------------
 *  The registration half of the keymap: one expander over `keymap.ts`'s rows, the handful of
 *  commands a row names that this tree does not already have, and the two context keys those rows
 *  are guarded on.
 *
 *  **Nothing here decides a key.** The rows are the declaration; this file turns each one into a
 *  `KeybindingsRegistry` rule and nothing else, so a key that moves moves in one file. A row whose
 *  command does not exist yet is registered anyway — the resolver
 *  resolves it and the dispatch finds nothing to run — which is what lets the phases that write
 *  those commands land in any order.
 *
 *  The commands below are small on purpose: each is the smallest thing that reaches a gesture the
 *  mouse already has here — a click on the activity bar, on a pane header, on a view's `…` menu.
 *  Where an id already exists in this tree the row binds *that*, and no second implementation of
 *  it is written.
 *
 *  Upstream counterpart: none — see `keymap.ts`.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, findParentWithClass, getActiveElement, isActiveElement, isEditableElement, isHTMLInputElement, isHTMLTextAreaElement, onDidRegisterWindow } from '../../../base/browser/dom.js';
import { List } from '../../../base/browser/ui/list/listWidget.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { localize } from '../../../nls.js';
import { CommandsRegistry, ICommandHandler, ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IListService, WorkbenchListWidget } from '../../../platform/list/browser/listService.js';
import { FocusedViewContext } from '../../common/contextkeys.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../common/contributions.js';
import { IView, IViewPaneContainer, ViewContainerLocation } from '../../common/views.js';
import { ViewSortKey } from '../../contrib/scm/browser/scmViewPane.js';
import { ViewMode } from '../../contrib/scm/common/scm.js';
import { registerTakeoverKeepCommand } from '../../services/keybinding/tauri/keyboardTakeover.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';
import { lineStartBefore, wordStartBefore } from './inputEditing.js';
import { CanEditInputContext, CanScrollHorizontallyContext, guiRuleId, guiRuleWhen, keysFor, MultipleViewsContext, rowsFor } from './keymap.js';

//#region --- the commands this frontend lacks
//
// Each is the command a row names, at the id the row names it by, so the row is one row.
// The three `git.*` wrappers are here for a reason worth stating: `git.stage`, `git.unstage` and
// `git.openChange` all resolve the resources they act on *out of their arguments*, which a menu
// item carries and a keystroke does not — so binding those ids bare would be a key that does
// nothing. The wrapper supplies the focused rows, which is what the context menu supplies.

/**
 * The keys of `scmViewSortKey`, in the order `S` walks them. The order is
 * this file's; **the keys themselves are `scmViewPane.ts`'s**, which is where the context key, the
 * three `workbench.scm.action.setSortKey.*` ids and the settings enum all read them from.
 */
const SORT_KEYS = [ViewSortKey.Path, ViewSortKey.Name, ViewSortKey.Status];

const editorArea = 'workbench.action.focusActiveEditorGroup';

function focusedViewId(accessor: ServicesAccessor): string | undefined {
	return accessor.get(IContextKeyService).getContextKeyValue<string>(FocusedViewContext.key) || undefined;
}

/** The side bar's shown container, which is the one whose views the keys move between. */
function shownContainer(accessor: ServicesAccessor): IViewPaneContainer | undefined {
	return accessor.get(IPaneCompositePartService).getActivePaneComposite(ViewContainerLocation.Sidebar)?.getViewPaneContainer();
}

function shownViews(container: IViewPaneContainer): IView[] {
	return container.views.filter(view => view.isVisible());
}

/** The pane the keyboard is in, as `paneview.ts` builds one: the box and the list are both inside it. */
function focusedPane(): HTMLElement | undefined {
	const active = getActiveElement();
	return active ? findParentWithClass(active as HTMLElement, 'pane') ?? undefined : undefined;
}

/** The pane's own box — the first text input it draws that is on screen. */
function boxIn(pane: HTMLElement): HTMLElement | undefined {
	for (const candidate of pane.querySelectorAll<HTMLElement>('input, textarea')) {
		if (candidate.getClientRects().length > 0) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * The list the keyboard is in. `lastFocusedList` outlives the focus it names — it is what the
 * *last* focused list was — so the widget's own element has to say it still has it.
 */
function focusedList(listService: IListService): WorkbenchListWidget | undefined {
	const list = listService.lastFocusedList;
	const element = list?.getHTMLElement();

	return list && element && isActiveElement(element) ? list : undefined;
}

/**
 * The rows the focused list has, which is where a key finds what the context menu would have been
 * given. `files.ts`'s own `getFocus` makes the same split: a list answers with elements and a tree
 * answers with them from `getFocus`.
 */
function focusedRows(accessor: ServicesAccessor): unknown[] {
	const list = focusedList(accessor.get(IListService));
	if (!list) {
		return [];
	}

	return list instanceof List ? list.getFocusedElements() : list.getFocus();
}

/**
 * Whether `list` draws rows wider than the box it draws them in. `contentWidth` is `ListView`'s own
 * measure and stays `0` while the widget is not horizontally scrollable, so a list that cannot
 * scroll sideways answers no and `Ctrl+Left` keeps whatever meaning it had.
 */
function overflowsHorizontally(list: WorkbenchListWidget | undefined): boolean {
	return !!list && 'contentWidth' in list && list.contentWidth > list.getHTMLElement().clientWidth;
}

/** `id` runs `forwards` with the focused rows, which is the argument its menu item carries. */
function forwardRows(forwards: string): ICommandHandler {
	return accessor => accessor.get(ICommandService).executeCommand(forwards, ...focusedRows(accessor));
}

/**
 * One of the two editing keys, on whatever has the keyboard — the two arms
 * `EditorOrNativeTextInputCommand` (`coreCommands.ts:305`) gives every core editing command that a
 * Monaco box and a plain `<input>` both have to answer: the focused code editor first, then
 * whatever else takes text. That class is private to a vendored file, so the dispatch is written
 * out here; what each arm *runs* is not ours either way — `editorCommand` in the editor, and
 * `inputEditing.ts`'s offset over a plain box.
 *
 * The editor arm is what carries the source control commit box, which is a `CodeEditorWidget` in
 * the side bar rather than an `<input>` anywhere.
 *
 * The deletion itself is the browser's own editing command, as it is for every other DOM arm of a
 * core editing command (`coreCommands.ts`'s `selectAll`, `undo`, `redo`): assigning `value` fires
 * no `input` event, so the widget around the element — `InputBox`, `FindInput`, the quick input's
 * filter — would go on filtering by text the box no longer holds.
 */
function editingKey(editorCommand: string, startOf: (value: string, caret: number) => number): ICommandHandler {
	return accessor => {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
		if (editor?.hasTextFocus()) {
			return accessor.get(ICommandService).executeCommand(editorCommand);
		}

		const input = getActiveElement();
		if (!isHTMLInputElement(input) && !isHTMLTextAreaElement(input)) {
			return undefined;
		}

		const { selectionStart, selectionEnd } = input;
		if (selectionStart === null || selectionEnd === null) {
			return undefined; // an input type with no selection to read has no caret to delete from
		}

		const start = selectionStart === selectionEnd ? startOf(input.value, selectionStart) : selectionStart;
		if (start < selectionEnd) {
			input.setSelectionRange(start, selectionEnd);
			input.ownerDocument.execCommand('delete');
		}

		return undefined;
	};
}

const COMMANDS: { id: string; title: string; handler: ICommandHandler }[] = [
	{
		id: 'tscode.showViewContainer',
		title: localize('tscode.showViewContainer', "Show View Container"),
		// `getVisiblePaneCompositeIds` is the activity bar's own order, which is what the digits
		// count along — the same source `workbench.action.nextSideBarView` steps through.
		handler: (accessor, index) => {
			const service = accessor.get(IPaneCompositePartService);
			const id = service.getVisiblePaneCompositeIds(ViewContainerLocation.Sidebar)[Number(index)];

			return id === undefined ? undefined : service.openPaneComposite(id, ViewContainerLocation.Sidebar, true);
		}
	},
	{
		id: 'tscode.focusNextView',
		title: localize('tscode.focusNextView', "Next View"),
		handler: accessor => focusViewBy(accessor, 1)
	},
	{
		id: 'tscode.focusPreviousView',
		title: localize('tscode.focusPreviousView', "Previous View"),
		handler: accessor => focusViewBy(accessor, -1)
	},
	{
		id: 'tscode.collapseView',
		title: localize('tscode.collapseView', "Collapse View"),
		handler: accessor => setFocusedViewExpanded(accessor, false)
	},
	{
		id: 'tscode.expandView',
		title: localize('tscode.expandView', "Expand View"),
		handler: accessor => setFocusedViewExpanded(accessor, true)
	},
	{
		id: 'tscode.editInput',
		title: localize('tscode.editInput', "Edit"),
		handler: () => {
			const pane = focusedPane();
			const box = pane && boxIn(pane);
			box?.focus();
		}
	},
	{
		id: 'tscode.stopEditingInput',
		title: localize('tscode.stopEditingInput', "Stop Editing"),
		// Leaving the box gives the keyboard back to the rows the box filters, and to the editor
		// area when the box was not a pane's at all.
		handler: accessor => {
			const list = focusedPane()?.querySelector<HTMLElement>('.monaco-list');
			if (list) {
				list.focus();

				return undefined;
			}

			return accessor.get(ICommandService).executeCommand(editorArea);
		}
	},
	{
		id: 'tscode.scm.toggleViewMode',
		title: localize('tscode.scm.toggleViewMode', "List/Tree"),
		handler: accessor => {
			const mode = accessor.get(IContextKeyService).getContextKeyValue<ViewMode>('scmViewMode');

			return accessor.get(ICommandService).executeCommand(mode === ViewMode.List
				? 'workbench.scm.action.setTreeViewMode'
				: 'workbench.scm.action.setListViewMode');
		}
	},
	{
		id: 'tscode.scm.cycleSortKey',
		title: localize('tscode.scm.cycleSortKey', "Sort By"),
		handler: accessor => {
			const sortKey = accessor.get(IContextKeyService).getContextKeyValue<ViewSortKey>('scmViewSortKey');
			const next = SORT_KEYS[(SORT_KEYS.indexOf(sortKey ?? SORT_KEYS[0]) + 1) % SORT_KEYS.length];

			return accessor.get(ICommandService).executeCommand(`workbench.scm.action.setSortKey.${next}`);
		}
	},
	{
		id: 'tscode.deleteWordLeft',
		title: localize('tscode.deleteWordLeft', "Delete Word Left"),
		handler: editingKey('deleteWordLeft', wordStartBefore)
	},
	{
		id: 'tscode.deleteAllLeft',
		title: localize('tscode.deleteAllLeft', "Delete All Left"),
		handler: editingKey('deleteAllLeft', lineStartBefore)
	},
	{ id: 'tscode.scm.stage', title: localize('tscode.scm.stage', "Stage Changes"), handler: forwardRows('git.stage') },
	{ id: 'tscode.scm.unstage', title: localize('tscode.scm.unstage', "Unstage Changes"), handler: forwardRows('git.unstage') },
	{ id: 'tscode.scm.openChange', title: localize('tscode.scm.openChange', "Open Changes"), handler: forwardRows('git.openChange') }
];

/**
 * The keyboard, in the next view round. **Expanded first, and that pairing is upstream's own**:
 * `ViewPaneContainer.openView` (`viewPaneContainer.ts:772`) is the method whose whole job is "put
 * the keyboard in this view", and its two lines are `setExpanded(true)` and then `focus()`. The
 * order is not a nicety — `paneview.ts:327` renders a pane's body only if it is expanded when it is
 * rendered, so a collapsed pane has never run `renderBody` and every field its `focus()` override
 * reads is still undefined. `SCMRepositoriesViewPane.focus()` is `super.focus(); this.tree.domFocus();`
 * over exactly such a field, which is where `Cannot read properties of undefined (reading 'domFocus')`
 * came from: a view cycled *into* while collapsed. It is `hideByDefault`, which is why no fixture
 * has reproduced it — the reading above is the evidence, not a run.
 */
function focusViewBy(accessor: ServicesAccessor, delta: number): void {
	const container = shownContainer(accessor);
	const views = container ? shownViews(container) : [];
	const index = views.findIndex(view => view.id === focusedViewId(accessor));
	if (index < 0 || views.length < 2) {
		return;
	}

	const view = views[(index + delta + views.length) % views.length];
	view.setExpanded(true);
	view.focus();
}

function setFocusedViewExpanded(accessor: ServicesAccessor, expanded: boolean): void {
	const viewId = focusedViewId(accessor);
	if (viewId !== undefined) {
		shownContainer(accessor)?.getView(viewId)?.setExpanded(expanded);
	}
}

//#endregion


//#region --- the three context keys the rows need and nothing else publishes

/**
 * `tscodeCanEditInput`, `tscodeCanScrollHorizontally` and `tscodeMultipleViews`, which say whether
 * `I`, `Ctrl+Left`/`Ctrl+Right` and the view keys mean anything. All three are answers about the
 * focused pane, so all three are recomputed where the focus moves: the first two on `focusin`,
 * which is where `ContextKeyService` recomputes `inputFocus` too, and the view one on the
 * container's own membership events.
 */
class TauriKeymapContextKeys extends Disposable {

	static readonly ID = 'workbench.contrib.tauriKeymapContextKeys';

	private readonly containerViews = this._register(new MutableDisposable<DisposableStore>());
	private readonly listScroll = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService private readonly listService: IListService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService
	) {
		super();

		const canEditInput = CanEditInputContext.bindTo(contextKeyService);
		const canScrollHorizontally = CanScrollHorizontallyContext.bindTo(contextKeyService);
		// A list's overflow changes when it is laid out or its rows are rendered, and `onDidScroll`
		// is what `listService.ts`'s own boundary observer watches for exactly that — a scroll event
		// carries the dimensions, so it fires when they change and not only when the position does.
		const trackScroll = () => {
			const list = focusedList(this.listService);
			this.listScroll.value = list && 'onDidScroll' in list
				? list.onDidScroll(() => canScrollHorizontally.set(overflowsHorizontally(focusedList(this.listService))))
				: undefined;
			canScrollHorizontally.set(overflowsHorizontally(list));
		};

		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(addDisposableListener(window, EventType.FOCUS_IN, () => {
				const active = getActiveElement();
				const pane = focusedPane();
				canEditInput.set(!!pane && !!active && !isEditableElement(active) && !!boxIn(pane));
			}, true));
			// Bubble, unlike the capture listener above: `IListService` learns which list has the
			// keyboard from the widget's own capture handler, which is deeper than the window and so
			// runs after it. Reading `lastFocusedList` in the capture phase would read the old one.
			disposables.add(addDisposableListener(window, EventType.FOCUS_IN, () => trackScroll()));
		}, { window: mainWindow, disposables: this._store }));

		const multipleViews = MultipleViewsContext.bindTo(contextKeyService);
		const update = (container: IViewPaneContainer | undefined) => multipleViews.set(!!container && shownViews(container).length > 1);
		const track = () => {
			const container = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getViewPaneContainer();
			const disposables = this.containerViews.value = new DisposableStore();
			if (container) {
				for (const event of [container.onDidAddViews, container.onDidRemoveViews, container.onDidChangeViewVisibility]) {
					disposables.add(event(() => update(container)));
				}
			}

			update(container);
		};

		this._register(this.paneCompositeService.onDidPaneCompositeOpen(() => track()));
		this._register(this.paneCompositeService.onDidPaneCompositeClose(() => track()));
		track();
	}
}

//#endregion


//#region --- registration

for (const command of COMMANDS) {
	CommandsRegistry.registerCommand({
		id: command.id,
		handler: command.handler,
		metadata: { description: command.title, args: [] }
	});
}

/** The rows whose fork wrapper this frontend implements above, so their rule binds the row's id. */
export const IMPLEMENTED_COMMAND_IDS: ReadonlySet<string> = new Set(COMMANDS.map(command => command.id));

/**
 * One above the workbench's own, because **at equal weight the winner is decided by the command
 * id's spelling.** `keybindingsRegistry.ts`'s `sorter` (line 261) falls through `weight1` to a
 * string comparison of the two commands, and `KeybindingResolver._findCommand` (line 381) takes
 * the last match — so of two rules a keypress both fits, the one whose id sorts later wins, and
 * registration order never enters into it.
 *
 * That is not a tie-break a keymap can be built on. Where this frontend claims a chord the
 * takeover deliberately leaves stock holding — `Ctrl+W` against `workbench.action.closeActiveEditor`,
 * which upstream registers at this same weight with no `when` at all — the claim has to be the
 * answer wherever it applies, and `tscode.deleteWordLeft` losing to it on `t < w` is the same key
 * silently doing the wrong thing that the stock row's dead guard already was.
 *
 * A user's own `keybindings.json` is unaffected: `_getResolver` resolves user rules after every
 * default whatever its weight, which is what `filterForTakeover` leaves untouched.
 */
const KEYMAP_WEIGHT = KeybindingWeight.WorkbenchContrib + 1;

for (const row of rowsFor('gui')) {
	// A stock row is one this frontend does not claim, so there is nothing to register and nothing
	// to guard: upstream's own rule answers the chord, under upstream's own `when`. What keeps it
	// through the takeover is `keyboardTakeover.ts`'s `sharedChordCommands`.
	if (row.stock) {
		continue;
	}

	const id = guiRuleId(row, IMPLEMENTED_COMMAND_IDS);
	const [primary, ...secondary] = keysFor(row, 'gui');

	KeybindingsRegistry.registerKeybindingRule({
		id,
		weight: KEYMAP_WEIGHT,
		when: guiRuleWhen(row),
		primary,
		secondary: secondary.length ? secondary : undefined,
		args: row.args
	});

	// The takeover filter drops every stock default that is not in its keep-set, and a rule
	// registered here is a stock default like any other — nothing on a resolved item says which
	// registration produced it. So the two calls travel together: naming the command is what makes
	// the rule above survive, and a row added without one is a key that silently does nothing.
	registerTakeoverKeepCommand(id);
}

registerWorkbenchContribution2(TauriKeymapContextKeys.ID, TauriKeymapContextKeys, WorkbenchPhase.BlockRestore);

//#endregion
