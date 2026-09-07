/*---------------------------------------------------------------------------------------------
 *  The workbench: the parts, where each of them is, and which of them has the keyboard.
 *
 *  This is tscode's arrangement, drawn in cells instead of pixels — an activity bar, a side bar
 *  showing **one view container at a time**, a divider, and an editor area with **its own tabs, one
 *  per open editor**, over a status bar. Not a shape of ours: which containers exist and in what
 *  order is `IViewContainersRegistry` at `ViewContainerLocation.Sidebar`; which views are inside one
 *  and how tall each is comes off the view descriptors (`views.ts`); whether a container with one
 *  view hides that view's header is `mergeViewWithContainerWhenSingleView`, which upstream passes as
 *  the container's own `ctorDescriptor` argument and this fork declares in the same place. The
 *  editor tabs are `EditorGroupModel`'s (`editorArea.ts`).
 *
 *  What a terminal cannot take from upstream is the pixel: the side bar's width is
 *  `Math.min(300, width / 4)` there (`layout.ts`, `SIDEBAR_SIZE.defaultValue`), and a *ratio* is
 *  what survives the change of unit — a quarter of the frame is the same quarter of the frame's
 *  characters. That one statement also fixes the *scale*, because it says the same width twice: a
 *  quarter of the frame is 300 pixels, so the frame is 1,200 of them and every other pixel the
 *  layout states crosses at that rate. `SidebarPart.minimumWidth` and `RESIZE_INCREMENT` are the two
 *  that do, which is what makes the side bar resizable without a sash: upstream's own
 *  `increaseViewSize`/`decreaseViewSize` resize the *focused part* through `layout.ts`'s
 *  `resizePart`, and both are keyboard commands there rather than the drag.
 *
 *  The status bar is `statusbarPart.ts` — upstream's `StatusbarViewModel` deciding what is on it and
 *  in what order, with the keys this frontend answers between the two groups — and above every part
 *  is `overlay.ts`'s floating layer, which is where a quick input, a context menu and a
 *  confirmation are drawn and where the keyboard is while one of them is up.
 *
 *  A keystroke goes to the keybinding service first, exactly as it does in tscode: the resolver
 *  matches it against every rule in `KeybindingsRegistry` whose `when` clause holds, and only a key
 *  that matched nothing is offered to the focused pane. So this file dispatches keys and publishes
 *  the context the rules are evaluated against — `sideBarFocus`, `editorAreaFocus`, `sideBarVisible`,
 *  `activeViewlet`, `focusedView` and `editorIsOpen`, all of them upstream's own keys — and which
 *  keys mean what is declared in `commands.ts` and in the panes, never here.
 *
 *  Upstream counterpart: src/vs/workbench/browser/workbench.ts, src/vs/workbench/browser/layout.ts
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { onUnexpectedError } from '../../vs/base/common/errors.js';
import { KeyCode, KeyMod } from '../../vs/base/common/keyCodes.js';
import { DisposableStore } from '../../vs/base/common/lifecycle.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, IContextKeyServiceTarget } from '../../vs/platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../vs/platform/contextkey/common/contextkeys.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../vs/platform/keybinding/common/keybindingResolver.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { descriptionForeground, foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import {
	EditorAreaFocusContext, EditorsVisibleContext, ResourceContextKey, SideBarVisibleContext
} from '../../vs/workbench/common/contextkeys.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../vs/workbench/common/editor.js';
import {
	ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_FOREGROUND, ACTIVITY_BAR_INACTIVE_FOREGROUND,
	EDITOR_GROUP_BORDER, SIDE_BAR_BACKGROUND, SIDE_BAR_BORDER, SIDE_BAR_SECTION_HEADER_BACKGROUND,
	SIDE_BAR_SECTION_HEADER_BORDER, SIDE_BAR_SECTION_HEADER_FOREGROUND, SIDE_BAR_TITLE_BACKGROUND, SIDE_BAR_TITLE_FOREGROUND,
	STATUS_BAR_BACKGROUND, STATUS_BAR_FOREGROUND
} from '../../vs/workbench/common/theme.js';
import { ViewContainer } from '../../vs/workbench/common/views.js';
import { IContextMenuService } from '../../vs/platform/contextview/browser/contextView.js';
import { ITuiWorkbench, IWorkbenchKeys, keyEntries, keyLabel, registerWorkbenchCommands, SHOW_KEYS_ID } from './commands.js';
import { EditorArea, TAB_STRIP_ROWS } from '../editor/editorArea.js';
import { IKey, IMouse, Input } from '../terminal/input.js';
import { toKeyboardEvent } from './keyboard.js';
import { KeysOverlay } from './keysOverlay.js';
import { Overlays } from './overlay.js';
import { NAVIGATION_HINT, Pane } from './pane.js';
import { descriptorOf, IPaneContainer, PaneContainers } from '../../workbench/paneContainers.js';
import { TWISTIE } from '../terminal/dom/paint.js';
import { TerminalStatusbarPart } from './statusbarPart.js';
import { blend, columns, IColumn, ILine, Screen, spanWidth } from '../terminal/screen.js';
import { dispatchWorkbenchKey } from '../../input/workbenchKeyDispatch.js';

/** The status bar, one row; every other part shares the rows above it. */
const STATUS_ROWS = 1;

/** The side bar's title area and the editor group's tab strip, which are the same row. */
const TITLE_ROWS = 1;

/** The activity bar: one entry per side bar container, at the width a number needs. */
const ACTIVITY_BAR_COLUMNS = 3;

/** `layout.ts`'s `SIDEBAR_SIZE.defaultValue`, with the pixel divided out — see the header. */
const SIDE_BAR_SHARE = 1 / 4;

/**
 * `SIDEBAR_SIZE.defaultValue` again, this time as the pixel it is stated in — and with it, the
 * width of the frame those pixels are measured against.
 *
 * `Math.min(300, width / 4)` says both things at once: the fork took the `width / 4` arm as
 * `SIDE_BAR_SHARE`, and upstream states that same arm as **300px**, so the two agree at exactly one
 * window — 1,200px wide. That is the conversion, and it is upstream's rather than a scale of ours:
 * a column is `LAYOUT_PIXELS / cols` pixels, which is what lets the *other* two numbers the layout
 * states in pixels cross into a terminal. `columnsOf(SIDE_BAR_PIXELS)` is `cols * SIDE_BAR_SHARE`,
 * which is the check that it is the same conversion and not a second one.
 *
 * It is deliberately **not** `paint.ts`'s `PIXELS_PER_COLUMN`: that is the tree's own indent scale
 * (8px is two columns), and at 4px a column `SidebarPart.minimumWidth` would be 43 columns — wider
 * than the side bar's own default. Two pixel scales, because upstream has two: a glyph's box and a
 * part's width are not measured against the same thing.
 */
const SIDE_BAR_PIXELS = 300;
const LAYOUT_PIXELS = SIDE_BAR_PIXELS / SIDE_BAR_SHARE;

/** `SidebarPart.minimumWidth` — the floor a sash cannot be dragged past, in the same pixels. */
const SIDE_BAR_MINIMUM_PIXELS = 170;

/** `BaseResizeViewAction.RESIZE_INCREMENT` (`layoutActions.ts:1141`), in the same pixels. */
const RESIZE_INCREMENT_PIXELS = 60;

/** The rule `sideBar.border` paints in a GUI, as the one column a terminal can spare for it. */
const DIVIDER = '│';
const DIVIDER_COLUMNS = 1;

/**
 * `Pane.updateStyles` puts `1px solid sideBarSectionHeader.border` on the top of every visible view
 * header (`paneview.ts:396`), and in this theme that rule is the only thing between two stacked
 * views — `sideBarSectionHeader.background` is the side bar's own colour. A row is the smallest a
 * terminal can spend on it, the same trade `DIVIDER` makes on the other axis.
 */
const HEADER_RULE = '─';

/** What a view weighs when its descriptor says nothing — an even split with its siblings. */
const DEFAULT_WEIGHT = 50;

/** Which part has the keyboard. */
const enum Focus { SideBar, EditorArea }

/** A view of the shown container: its pane, the rows it was given, and the row it starts at. */
interface IView {
	readonly pane: Pane;
	readonly rows: number;
	/** The screen row the view's first line is on — its header, when the container shows headers. */
	readonly top: number;
	/** How many rows sit above the view's body: its rule and its header, or none when merged. */
	readonly header: number;
}

/**
 * Whether a container with a single view hides that view's header and takes its name into the
 * title. It is `ViewPaneContainer`'s `mergeViewWithContainerWhenSingleView`, which upstream passes
 * as the second static argument of the container's `ctorDescriptor` — `true` for the explorer,
 * search and source control, `false` for Sapling — and `views.ts` declares it in the same place.
 */
function mergesSingleView(container: ViewContainer): boolean {
	const options = container.ctorDescriptor?.staticArguments[1] as { mergeViewWithContainerWhenSingleView?: boolean } | undefined;

	return !!options?.mergeViewWithContainerWhenSingleView;
}

/**
 * What a dispatch scopes its context to. Upstream passes the focused DOM element, so a widget can
 * carry context keys of its own; a terminal's focus is a pane, and every key here lives on the one
 * context service. `findContextAttr` answers `0` — the root context — for exactly this, so the cast
 * is naming what the parameter has no type for rather than working around it.
 *
 * Kept as the single documented cast used by the terminal dispatch path.
 */
export const NO_TARGET = null as unknown as IContextKeyServiceTarget;

/** What separates one hint from the next, as the status bar separates one entry group from another. */
const HINT_SEPARATOR = ' · ';

/**
 * The two workbench keys a terminal decides for itself — `IWorkbenchKeys` is where the reasons are.
 *
 * `Ctrl+C` is quit because that is what stops a program reading a pty, and it is a plain
 * `CtrlCmd | KeyC` rather than a chord of ours because that is what upstream spells `Ctrl` as. The
 * side bar takes the bare `0` alone because upstream's `Ctrl+0` has no form on the wire at all
 * (`§6`), so there is no second rule for the status line to choose between.
 */
const TERMINAL_KEYS: IWorkbenchKeys = {
	quit: KeyMod.CtrlCmd | KeyCode.KeyC,
	sourceControl: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyG,
	cycleForward: KeyCode.Tab,
	cycleBackward: KeyMod.Shift | KeyCode.Tab,
	focusSideBar: [{
		primary: KeyCode.Digit0,
		when: ContextKeyExpr.and(InputFocusedContext.negate(), EditorAreaFocusContext)
	}]
};

export class Workbench extends PaneContainers<Pane> implements ITuiWorkbench {

	readonly keys = TERMINAL_KEYS;

	private readonly paneListeners = this._register(new DisposableStore());
	private focus = Focus.SideBar;
	private sideBarShown = true;
	private painting = false;
	private paintQueued = false;

	/**
	 * The side bar's width in columns once something has resized it — `LayoutStateKeys.SIDEBAR_SIZE`
	 * as a runtime value. Undefined is that key's *default*, which is a share of the frame and
	 * therefore follows a terminal that changes size; a size a user chose does not.
	 */
	private sideBarSize: number | undefined;

	/** The `SYNC` answers still owed, in the order they were asked for. */
	private syncing = Promise.resolve();

	private readonly sideBarVisible: IContextKey<boolean>;
	private readonly editorAreaFocus: IContextKey<boolean>;
	private readonly editorsVisible: IContextKey<boolean>;

	/**
	 * The active editor's resource, as the six keys upstream derives from one —
	 * `resourceLangId`, `resourceScheme`, `resourceExtname` and the rest. It is upstream's own
	 * class over upstream's own accessor, so a `when` clause written against any of them evaluates
	 * here for the same reason it evaluates there; `markdown.showPreview`'s precondition is the
	 * first that needed it.
	 */
	private readonly resource: ResourceContextKey;

	constructor(
		private readonly screen: Screen,
		private readonly input: Input,
		private readonly editors: EditorArea,
		private readonly overlays: Overlays,
		private readonly statusbar: TerminalStatusbarPart,
		private readonly quitRun: () => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService
	) {
		super(contextKeyService);

		this.sideBarVisible = SideBarVisibleContext.bindTo(contextKeyService);
		this.editorAreaFocus = EditorAreaFocusContext.bindTo(contextKeyService);
		this.editorsVisible = EditorsVisibleContext.bindTo(contextKeyService);
		this.resource = this._register(instantiationService.createInstance(ResourceContextKey));

		this._register(registerWorkbenchCommands(this));

		this._register(this.screen.onDidResize(() => this.paint()));
		this._register(this.editors.onDidChange(() => this.paint()));
		this._register(this.editors.onDidRequestPaint(() => this.paint()));
		this._register(this.overlays.onDidChange(() => this.paint()));
		this._register(this.statusbar.onDidChange(() => this.paint()));
		this._register(this.input.onKey(key => this.handleKey(key)));
		this._register(this.input.onPaste(text => this.handlePaste(text)));
		// The other half of the handshake: the keys before it have been dispatched, so what is left
		// is the work they started. Requests are one per batch and answered in order, which is what
		// the chain is for — a driver that asked twice must not be told once.
		this._register(this.input.onDidRequestSync(() => {
			this.syncing = this.syncing.then(async () => {
				// **Work that failed is work that is over.** A rejection kept in the chain is a chain
				// that never answers again — every later request is a `then` on a rejected promise —
				// so the driver hears silence where the app could have said "finished, and something
				// went wrong". The error goes where every unexpected one goes.
				try {
					await this.whenSettled();
				} catch (error) {
					onUnexpectedError(error);
				}
				this.screen.reportSettled();
			});
		}));
		this._register(this.input.onMouse(mouse => {
			if (this.handleMouse(mouse)) {
				this.paint();
			}
		}));
	}

	/** Every pane of every container — what the side bar owns rather than what is on screen. */
	private get allPanes(): Pane[] {
		return this.containers.flatMap(entry => entry.panes);
	}

	/** The focused pane, which is what every key and every context key is about. */
	private get pane(): Pane | undefined {
		if (this.focus === Focus.EditorArea) {
			return this.editors.pane;
		}

		const container = this.container;

		return container && this.shown(container)[container.view];
	}

	/** Adds panes to the side bar and paints; where each one lands is `PaneContainers`' answer. */
	async add(...panes: Pane[]): Promise<void> {
		await this.addPanes(panes);
	}

	/** Every pane the side bar owns is listened to, because any of them changing is a repaint. */
	protected override watch(pane: Pane): void {
		this.paneListeners.add(pane.onDidChange(() => this.paint()));
	}

	/** What `PaneContainers` restates the view through, which here is a frame. */
	protected changed(): void {
		this.paint();
	}

	protected get sideBarFocused(): boolean {
		return this.focus === Focus.SideBar;
	}

	/**
	 * An overlay has the keyboard while it is up, which is what takes it off the pane. *Which*
	 * overlay it is, is `inQuickOpen`, and `TerminalQuickInputService` sets that.
	 */
	protected override get inputTaken(): boolean {
		return !!this.overlays.top;
	}

	/** Every holder of work a keystroke can start: the panes, the open editors and the overlays. */
	private get parts(): readonly { readonly idle: boolean; whenSettled(): Promise<void> }[] {
		return [...this.allPanes, this.editors, this.overlays];
	}

	/**
	 * Resolves once nothing any pane, any open editor or any overlay started is still outstanding —
	 * or once an overlay is up, because work waiting on a pick is waiting on a keystroke, and there
	 * is nothing further for the workbench to finish until one arrives.
	 *
	 * **Watched rather than asked once, because one part's work starts another's.** A pick's
	 * `sl log` fills the smartlog, which moves the selection, which is what sends the commit-info
	 * pane after the commit's files — and that pane answered "idle" before a single pass reached
	 * it. Re-reading after every part that finishes is what makes the whole workbench the unit.
	 */
	async whenSettled(): Promise<void> {
		for (;;) {
			const busy = this.parts.filter(part => !part.idle);
			// A picker still filling itself is work a keystroke started, so it is waited for even
			// though it is an overlay: the command palette asks the menu registry and the file
			// picker asks the search service, and both answer after the key that opened them.
			if (!this.overlays.busy && (this.overlays.top || busy.length === 0)) {
				return;
			}

			// The overlay is raced rather than polled, and the subscription is undone whichever way
			// the race goes — a listener kept per turn of this loop would outlive the wait it is for.
			const listening = new DisposableStore();
			try {
				const changed = new Promise<void>(resolve => listening.add(this.overlays.onDidChange(() => resolve())));

				await Promise.race([...busy.map(part => part.whenSettled()), changed]);
			} finally {
				listening.dispose();
			}
		}
	}

	//#region --- ITuiWorkbench: what the workbench's own commands do

	quit(): void {
		this.quitRun();
	}

	/** Shows the container at `index` in the side bar, and puts the keyboard in it. */
	showViewContainer(index: number): void {
		if (index >= this.containers.length) {
			return;
		}

		this.active = index;
		this.focus = Focus.SideBar;
		this.sideBarShown = true;
		this.paint();
	}

	showViewContainerById(id: string): boolean {
		const index = this.containers.findIndex(entry => entry.container.id === id);
		if (index < 0) { return false; }
		this.showViewContainer(index);
		return true;
	}

	focusEditorArea(): void {
		if (this.focus === Focus.EditorArea) { return; }
		this.focus = Focus.EditorArea;
		this.paint();
	}

	/**
	 * `workbench.action.focusSideBar`, which upstream also *shows* the part before focusing it —
	 * `FocusSideBarAction` calls `setPartHidden(false, SIDEBAR_PART)` first, because a user asking
	 * for the side bar while it is hidden means the same thing either way.
	 */
	focusSideBar(): void {
		this.sideBarShown = true;
		this.focus = Focus.SideBar;
		this.paint();
	}

	/** The keys that apply right now, on the floating layer — the rest of the status line. */
	showKeys(): void {
		const pane = this.pane;
		const overlay = this.instantiationService.createInstance(
			KeysOverlay, this.keybindingService, pane?.hint ?? NAVIGATION_HINT, (id: string) => !pane?.takesKey(() => id));

		this.overlays.show(overlay);
	}

	/** Moves focus to the next view of the shown container, wrapping — one view is a no-op. */
	focusViewBy(delta: number): void {
		const container = this.container;
		if (!container) {
			return;
		}

		const shown = this.shown(container).length;
		container.view = (container.view + delta + shown) % Math.max(1, shown);
		this.paint();
	}

	focusEditorBy(delta: number): void {
		this.editors.focusEditorBy(delta);
	}

	closeActiveEditor(): void {
		this.editors.closeActive();
	}

	/** `workbench.action.toggleSidebarVisibility`. The keyboard follows the part that is left. */
	toggleSideBar(): void {
		this.sideBarShown = !this.sideBarShown;
		this.focus = this.sideBarShown ? Focus.SideBar : Focus.EditorArea;
		this.paint();
	}

	/**
	 * `workbench.action.increaseViewSize` / `decreaseViewSize`, which are `layout.ts`'s `resizePart`
	 * on **whichever part has the keyboard** — the one thing upstream's grid does that a sash also
	 * does, and the half of it that was already a command rather than a gesture.
	 *
	 * A terminal's grid is two parts and one divider, so the side bar's width is the editor area's
	 * the other way round: growing the focused part is the same one number moving, and the sign is
	 * what says which way. The floor is `SidebarPart.minimumWidth`, which `§6.2` left out for want of
	 * a sash to be a floor on; the ceiling is the column the editor area needs to exist at all.
	 */
	resizePart(change: number): void {
		const room = this.screen.cols - ACTIVITY_BAR_COLUMNS - DIVIDER_COLUMNS;
		const delta = (this.focus === Focus.SideBar ? change : -change) * Math.max(1, this.columnsOf(RESIZE_INCREMENT_PIXELS));
		const minimum = Math.min(this.columnsOf(SIDE_BAR_MINIMUM_PIXELS), room - 1);

		this.sideBarSize = Math.max(minimum, Math.min(this.sideBarWidth + delta, room - 1));
		this.paint();
	}

	/**
	 * `Pane.setExpanded` through the header's own keys: `paneview.ts:307–309` binds `LeftArrow` to
	 * collapsing and `RightArrow` to expanding the pane whose header has focus, and both are
	 * idempotent there rather than a toggle. A terminal's focus is the view rather than its header,
	 * so the two arrive shifted — the bare pair belongs to the tree in the pane below.
	 */
	setViewExpanded(expanded: boolean): void {
		const container = this.container;
		const pane = container && this.shown(container)[container.view];
		if (pane?.setExpanded(expanded)) {
			this.paint();
		}
	}

	editInput(editing: boolean): void {
		if (this.pane?.setEditing(editing)) {
			this.paint();
		}
	}

	/** `Tab` in a `/` box, on whichever pane has one open — which is what `tscodeFiltering` says. */
	completeFilter(delta: number): void {
		this.pane?.completeFilter(delta);
	}

	/** `list.scrollLeft` / `list.scrollRight`, on whichever pane has the keyboard. */
	scrollPaneBy(direction: number): void {
		if (this.pane?.scrollHorizontallyBy(direction)) {
			this.paint();
		}
	}

	/**
	 * The focused row's actions, anchored where that row is drawn. The pane says what the menu
	 * holds and the frame says where it goes, which is the split `onListContextMenu` makes too —
	 * there the anchor comes out of the event, here out of the layout.
	 */
	showContextMenu(): void {
		const pane = this.pane;
		const delegate = pane?.contextMenu();
		if (!pane || !delegate) {
			return;
		}

		const anchor = this.rowAnchor(pane);
		this.contextMenuService.showContextMenu({ ...delegate, getAnchor: () => anchor });
	}

	/** Where the focused pane's cursor row sits in the frame, in cells. */
	private rowAnchor(pane: Pane): { x: number; y: number; width: number; height: number } {
		const sideBar = this.sideBarWidth;
		if (this.focus === Focus.EditorArea) {
			return { x: this.screen.cols - this.editors.cols, y: TAB_STRIP_ROWS, width: this.editors.cols, height: 1 };
		}

		const view = this.views(Math.max(0, this.screen.rows - STATUS_ROWS - TITLE_ROWS)).find(candidate => candidate.pane === pane);

		return {
			x: ACTIVITY_BAR_COLUMNS,
			y: (view?.top ?? TITLE_ROWS) + (view?.header ?? 0) + pane.focusOffset,
			width: sideBar,
			height: 1
		};
	}

	//#endregion

	//#region --- the side bar's views
	//
	// A container's rows are split between its views the way upstream's split view sizes them: by the
	// `weight` on each view descriptor, over the rows left after each header has taken one. A view
	// whose `when` clause does not hold is not on screen at all, which is the same answer
	// `IViewDescriptorService` gives it there.

	/** `ViewPaneContainer.isViewMergedWithContainer`: one view, and the container asked for it. */
	private merged(container: IPaneContainer<Pane>, shown: Pane[]): boolean {
		return shown.length === 1 && mergesSingleView(container.container);
	}

	/**
	 * Whether the container's views can be collapsed, which is `ViewPaneContainer.updateViewHeaders`:
	 * a merged single view is forced expanded and has no header to collapse from, and a lone unmerged
	 * one is `collapsible = false` — so a header carries a control rather than a state only where
	 * there is a second view to give the rows to.
	 */
	private collapsible(container: IPaneContainer<Pane>, shown: Pane[]): boolean {
		return shown.length > 1 && !this.merged(container, shown);
	}

	/** Whether a view is drawn with a body, which a view that cannot be collapsed always is. */
	private expanded(container: IPaneContainer<Pane>, shown: Pane[], pane: Pane): boolean {
		return !this.collapsible(container, shown) || pane.isExpanded();
	}

	/**
	 * Where each view of the shown container sits, for `height` rows. The first *expanded* view takes
	 * the rounding remainder, as the primary view does upstream — an expanded view is never given
	 * fewer than one row, so a container shorter than its views loses them off the bottom rather than
	 * painting headers with nothing under them, and a collapsed one is its header and no body at all.
	 */
	private views(height: number): IView[] {
		const container = this.container;
		const panes = container ? this.shown(container) : [];
		if (!container || panes.length === 0 || height <= 0) {
			return [];
		}

		const header = this.merged(container, panes) ? 0 : 1 + (this.headerRule() ? 1 : 0);
		const weights = panes.map(pane => this.expanded(container, panes, pane) ? descriptorOf(pane)?.weight ?? DEFAULT_WEIGHT : 0);
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		const body = height - header * panes.length;

		// Every view collapsed is what upstream's `collapsible = false` on the last expanded pane
		// prevents; here the headers simply stack and the rows below them are the container's empty
		// space, which is what a paneview with every pane at `headerSize` leaves too.
		const first = weights.findIndex(weight => weight > 0);
		const rows = panes.map((_, index) => index === first || total === 0 ? 0 : Math.max(weights[index] ? 1 : 0, Math.round(body * weights[index] / total)));
		if (first !== -1) {
			rows[first] = body - rows.reduce((sum, allotted) => sum + allotted, 0);

			// Too short to stack: the first expanded view takes the whole container, which is what a
			// container with no room for its second view shows.
			if (rows[first] < 1) {
				return [{ pane: panes[first], rows: height, top: TITLE_ROWS, header: 0 }];
			}
		}

		const views: IView[] = [];
		let top = TITLE_ROWS;
		for (const [index, pane] of panes.entries()) {
			views.push({ pane, rows: rows[index], top, header });
			top += rows[index] + header;
		}

		return views;
	}

	/**
	 * The container's title, as `ViewPaneContainer.getTitle` computes it: the container's own name,
	 * or — when its single view is merged into it — that view's name qualified by the container's.
	 * `paneviewlet.css` and `sidebarpart.css` both draw it uppercase, so it is drawn uppercase.
	 */
	private title(container: IPaneContainer<Pane>): string {
		const containerTitle = container.container.title.value;
		const panes = this.shown(container);
		if (!this.merged(container, panes)) {
			return containerTitle;
		}

		const descriptor = descriptorOf(panes[0]);
		const single = descriptor?.singleViewPaneContainerTitle;
		if (single) {
			return single;
		}

		const paneTitle = descriptor?.name.value ?? panes[0].title;

		return containerTitle === paneTitle ? paneTitle : `${containerTitle}: ${paneTitle}`;
	}

	//#endregion

	//#region --- the frame

	paint(): void {
		// Input events and upstream changes update their owners immediately. Paint once after
		// this input batch, instead of blocking each trackpad report on a whole-window paint.
		if (this.painting || this.paintQueued || this._store.isDisposed) {
			return;
		}
		this.paintQueued = true;
		queueMicrotask(() => {
			this.paintQueued = false;
			if (this._store.isDisposed) { return; }
			this.painting = true;
			try {
				this.publishContext();
				this.screen.paint(this.frame());
			} finally {
				this.painting = false;
			}
		});
	}

	/** What every `when` clause in this frontend is evaluated against. */
	private publishContext(): void {
		const container = this.container;

		this.editors.setFocused(this.focus === Focus.EditorArea);
		this.publishPaneContext(this.pane, !!container && this.shown(container).length > 1);
		this.sideBarVisible.set(this.sideBarShown);
		this.editorAreaFocus.set(this.focus === Focus.EditorArea);
		this.editorsVisible.set(this.editors.count > 0);
		// `getOriginalUri` with `SideBySideEditor.PRIMARY` is what upstream asks an active editor
		// for its resource with, and it is what answers for a diff — whose input has none of its own.
		this.resource.set(EditorResourceAccessor.getOriginalUri(this.editors.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY }) ?? null);
	}

	/** A width the layout states in pixels, as the columns it is in this frame. */
	private columnsOf(pixels: number): number {
		return Math.round(pixels * this.screen.cols / LAYOUT_PIXELS);
	}

	/** How many columns the side bar has, or zero while it is hidden. */
	private get sideBarWidth(): number {
		if (!this.sideBarShown || this.containers.length === 0) {
			return 0;
		}

		const room = this.screen.cols - ACTIVITY_BAR_COLUMNS - DIVIDER_COLUMNS;

		return Math.max(0, Math.min(this.sideBarSize ?? this.columnsOf(SIDE_BAR_PIXELS), room - 1));
	}

	private frame(): ILine[] {
		const body = Math.max(0, this.screen.rows - STATUS_ROWS);
		const sideBar = this.sideBarWidth;
		const divider = sideBar ? DIVIDER_COLUMNS : 0;
		const theme = this.themeService.getColorTheme();

		this.editors.cols = Math.max(0, this.screen.cols - ACTIVITY_BAR_COLUMNS - sideBar - divider);

		const strips: IColumn[] = [
			{ width: ACTIVITY_BAR_COLUMNS, lines: this.activityBar(), background: theme.getColor(ACTIVITY_BAR_BACKGROUND) }
		];

		if (sideBar) {
			strips.push({ width: sideBar, lines: this.sideBar(body, sideBar), background: theme.getColor(SIDE_BAR_BACKGROUND) });
			strips.push({ width: DIVIDER_COLUMNS, lines: this.divider(body), background: theme.getColor(SIDE_BAR_BACKGROUND) });
		}

		strips.push({
			width: this.editors.cols,
			lines: [this.editors.tabStrip(), ...this.editors.lines(Math.max(0, body - TAB_STRIP_ROWS))],
			background: this.editors.background
		});

		return this.overlays.compose([...columns(strips, body), this.status()], this.screen);
	}

	/**
	 * The activity bar: one entry per side bar container, in the registry's order, showing the digit
	 * that opens it. Upstream draws each container's `icon` here and this fork has no icon font, so
	 * the number the keybinding carries is what the entry says — which is also the only place those
	 * nine keys are visible.
	 */
	private activityBar(): ILine[] {
		const theme = this.themeService.getColorTheme();
		const background = theme.getColor(ACTIVITY_BAR_BACKGROUND);

		return this.containers.map((_, index) => [{
			text: ` ${index + 1} `,
			fg: theme.getColor(index === this.active ? ACTIVITY_BAR_FOREGROUND : ACTIVITY_BAR_INACTIVE_FOREGROUND),
			bg: background,
			bold: index === this.active
		}]);
	}

	/**
	 * The side bar: the container's title, then each of its views, padded to the rows it was given.
	 *
	 * `width` is what the strip will cut the lines to, and a pane is told it for the same reason
	 * `ListView.layout` takes one — a row wider than the part it is in is what horizontal scrolling
	 * is for, and a pane that is not told cannot know a row was cut.
	 */
	private sideBar(height: number, width: number): ILine[] {
		const container = this.container;
		if (!container) {
			return [];
		}

		const theme = this.themeService.getColorTheme();
		const lines: ILine[] = [[{
			text: ` ${this.title(container).toUpperCase()}`,
			fg: theme.getColor(SIDE_BAR_TITLE_FOREGROUND) ?? theme.getColor(foreground),
			bg: theme.getColor(SIDE_BAR_TITLE_BACKGROUND),
			bold: true
		}]];

		const shown = this.shown(container);
		for (const [index, view] of this.views(height - TITLE_ROWS).entries()) {
			if (view.header) {
				lines.push(...this.viewHeader(view.pane, index === container.view, this.expanded(container, shown, view.pane)));
			}

			const painted = view.pane.layout(view.rows, width);
			lines.push(...painted.slice(0, view.rows));
			for (let extra = painted.length; extra < view.rows; extra++) {
				lines.push([]);
			}
		}

		return lines;
	}

	/**
	 * `sideBarSectionHeader.border`, or nothing when the theme leaves it unset — which is
	 * `Pane.updateStyles`'s own condition on the border it draws above a header.
	 */
	private headerRule(): Color | undefined {
		return this.themeService.getColorTheme().getColor(SIDE_BAR_SECTION_HEADER_BORDER);
	}

	/**
	 * The rows above a view: the rule its header carries on top, then the name its descriptor
	 * carries, drawn as `paneviewlet.css` draws it.
	 */
	private viewHeader(pane: Pane, focused: boolean, expanded: boolean): ILine[] {
		const theme = this.themeService.getColorTheme();
		const name = descriptorOf(pane)?.name.value ?? pane.title;
		const background = blend(theme.getColor(SIDE_BAR_SECTION_HEADER_BACKGROUND), theme.getColor(SIDE_BAR_BACKGROUND));
		const rule = this.headerRule();

		const lines: ILine[] = rule ? [[{ text: HEADER_RULE.repeat(this.sideBarWidth), fg: rule, bg: background }]] : [];
		lines.push([{
			text: ` ${expanded ? TWISTIE.expanded : TWISTIE.collapsed}${name.toUpperCase()}`,
			fg: focused
				? theme.getColor(SIDE_BAR_TITLE_FOREGROUND) ?? theme.getColor(foreground)
				: theme.getColor(SIDE_BAR_SECTION_HEADER_FOREGROUND) ?? theme.getColor(descriptionForeground),
			bg: background,
			bold: focused
		}]);

		return lines;
	}

	/**
	 * The column between the side bar and the editor area. `sideBar.border` is undefined in every
	 * theme but the high-contrast ones — a GUI separates the two by their backgrounds — so the
	 * nearest registered separator stands in where the theme says nothing.
	 */
	private divider(height: number): ILine[] {
		const theme = this.themeService.getColorTheme();
		const line: ILine = [{
			text: DIVIDER,
			fg: theme.getColor(SIDE_BAR_BORDER) ?? theme.getColor(EDITOR_GROUP_BORDER),
			bg: theme.getColor(SIDE_BAR_BACKGROUND)
		}];

		return Array.from({ length: height }, () => line);
	}

	/**
	 * The status bar: its entries, in `StatusbarViewModel`'s order, and between the two groups the
	 * keys the room is left for. An overlay has the keyboard while it is up, so it says what its own
	 * keys are.
	 */
	private status(): ILine {
		const theme = this.themeService.getColorTheme();

		return this.statusbar.line(this.screen.cols, room => [{
			text: ` ${this.hints(room - 1)}`,
			fg: theme.getColor(STATUS_BAR_FOREGROUND),
			bg: theme.getColor(STATUS_BAR_BACKGROUND)
		}]);
	}

	/**
	 * The keys, in `room` columns: the navigation the focused pane answers itself, then every command
	 * whose keybinding currently applies, read out of the registry so a key cannot be bound and
	 * undeclared.
	 *
	 * **What does not fit is not silently cut off.** The row outgrew itself — the search pane's keys
	 * alone are about 190 columns — and a truncated row loses whichever key happens to be last, which
	 * is how `R Refresh` disappeared. So `? Keys` goes on last and the rest fill what is left of the
	 * room in front of it: the row always fits, and what it could not say is one keystroke away.
	 */
	private hints(room: number): string {
		if (this.overlays.hint) {
			return this.overlays.hint;
		}

		// A pane that hands keystrokes to a child process names only the keys that still reach the
		// workbench — the status line would otherwise offer `Escape` and `Ctrl+C` while both go to
		// the child, which is worse than saying nothing.
		const pane = this.pane;
		const entries = keyEntries(this.keybindingService, id => !pane?.takesKey(() => id));
		const keys = entries.find(entry => entry.id === SHOW_KEYS_ID);
		const last = keys ? keyLabel(keys) : '';

		let line = pane?.hint ?? NAVIGATION_HINT;
		for (const entry of entries) {
			// The `tabs` scope is drawn where it applies — the activity bar shows each container's
			// digit — so the row does not repeat it; the overlay is where those keys are named.
			if (entry === keys || entry.scope === 'tabs') {
				continue;
			}

			const candidate = `${line}${HINT_SEPARATOR}${keyLabel(entry)}`;
			if (spanWidth(candidate) + (last ? HINT_SEPARATOR.length + last.length : 0) > room) {
				break;
			}
			line = candidate;
		}

		return last ? `${line}${HINT_SEPARATOR}${last}` : line;
	}

	//#endregion

	//#region --- input

	/**
	 * The keybinding service resolves first and the pane is offered what it did not take, which is
	 * the order a DOM widget sees keys in too — `dispatchEvent` reports whether a command ran, and
	 * upstream calls that `shouldPreventDefault`.
	 *
	 * The context has to be current before the resolve, not after: the rules that decide whether a
	 * letter is a command or a character are evaluated against it.
	 */
	private handleKey(key: IKey): void {
		const keybindingTarget = () => this.pane?.keybindingTarget?.() ?? NO_TARGET;
		dispatchWorkbenchKey(key, {
			publishContext: () => this.publishContext(),
			handleOverlayKey: routed => this.overlays.handleKey(routed),
			target: () => this.pane,
			keyboardEvent: toKeyboardEvent,
			resolvedCommand: event => {
				const resolved = this.keybindingService.softDispatch(event, keybindingTarget());
				return resolved.kind === ResultKind.KbFound ? resolved.commandId ?? undefined : undefined;
			},
			dispatchKeybinding: event => this.keybindingService.dispatchEvent(event, keybindingTarget()),
			handled: () => this.paint()
		});
	}

	/**
	 * Pasted text, which goes to whatever has the keyboard and **never to the keybinding resolver**.
	 *
	 * That omission is the point of the mechanism rather than a shortcut through it. A browser
	 * delivers a paste to the focused editable element as a `paste` event and produces no keydown at
	 * all, so a character in a clipboard has never been able to run a command there. Here the two
	 * arrived as the same bytes until `?2004h` was asked for, and a paste beginning `t` opened a
	 * shell and fed it the rest of the clipboard.
	 */
	private handlePaste(text: string): void {
		this.publishContext();

		const handled = this.overlays.top ? this.overlays.handlePaste(text) : !!this.pane?.handlePaste(text);
		if (handled) {
			this.paint();
		}
	}

	/** A mouse event, routed to the part the column it landed in belongs to. */
	private handleMouse(mouse: IMouse): boolean {
		// `ContextMenuHandler` blocks the mouse over the rest of the UI while a menu is up; this is
		// the same rule, and it is what stops a click behind a picker acting on the pane under it.
		if (this.overlays.top) {
			return false;
		}

		const sideBar = this.sideBarWidth;
		const body = Math.max(0, this.screen.rows - STATUS_ROWS);
		if (mouse.row >= body) {
			return false;
		}

		if (mouse.col < ACTIVITY_BAR_COLUMNS) {
			return mouse.kind === 'down' && mouse.row < this.containers.length && this.showViewContainerAt(mouse.row);
		}

		if (mouse.col < ACTIVITY_BAR_COLUMNS + sideBar) {
			return this.sideBarMouse(mouse);
		}

		if (mouse.col < ACTIVITY_BAR_COLUMNS + sideBar + (sideBar ? DIVIDER_COLUMNS : 0)) {
			return false;
		}

		if (mouse.kind === 'down') {
			this.focus = Focus.EditorArea;
		}

		return this.editors.handleMouse(mouse, 0) || mouse.kind === 'down';
	}

	private showViewContainerAt(index: number): boolean {
		this.active = index;
		this.focus = Focus.SideBar;

		return true;
	}

	/** A click inside the side bar: the view whose rows it landed in takes the keyboard. */
	private sideBarMouse(mouse: IMouse): boolean {
		const container = this.container;
		const views = this.views(Math.max(0, this.screen.rows - STATUS_ROWS - TITLE_ROWS));
		const view = views.findLast(candidate => mouse.row >= candidate.top);
		if (!container || !view) {
			return false;
		}

		const index = views.indexOf(view);
		if (mouse.kind === 'down') {
			this.focus = Focus.SideBar;
			if (container.view !== index) {
				container.view = index;

				// A click on the header is the focus and nothing else; a click on a row is both.
				if (mouse.row < view.top + view.header) {
					return true;
				}
			}
		}

		return view.pane.handleMouse(mouse, view.top + view.header) || mouse.kind === 'down';
	}

	//#endregion
}
