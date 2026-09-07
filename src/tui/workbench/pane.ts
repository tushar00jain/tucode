/*---------------------------------------------------------------------------------------------
 *  The seam every pane sits behind.
 *
 *  A pane is a list: a row count, a row renderer, and whatever keys it wants beyond navigation.
 *  Everything else — the viewport, the scroll position, which row has focus, and turning all of
 *  that into the lines the screen paints — is here, once, for all four panes.
 *
 *  A pane that needs more than a list says so in three optional members: `header` for lines above
 *  the viewport that do not scroll (the search pane's query box), the `canEdit`/`editing` pair for
 *  a pane with a text input in it, and `hint` for the navigation keys the status line names. All
 *  default to "nothing", so a pane that is only a list is laid out and routed exactly as before.
 *
 *  Everything a pane does beyond navigating and typing is a command with a keybinding rule
 *  (`commands.ts`), not an arm of `handleKey`. `handleKey` is reached only for what no rule
 *  matched, which is the navigation set below and a keystroke going into an input.
 *
 *  The geometry is upstream's, not ours: `RangeMap` is the variable-height virtual-scroll index
 *  `ListView` uses, and `Scrollable` is the scroll state and its clamping. Neither is DOM-bound,
 *  and a second scroll model is exactly what disqualified every TUI framework (§4) — so a pane
 *  that needs a row of a different height says so in `rowHeight`, and does not do arithmetic of
 *  its own.
 *
 *  Upstream counterpart: src/vs/workbench/browser/parts/views/viewPane.ts, src/vs/base/browser/ui/list/listView.ts
 *--------------------------------------------------------------------------------------------*/

// The sheet every view's tree carries in tscode, which is what decides that a `force-no-twistie`
// row — the source control view's input and its action button — has no twistie box.
import '../../vs/workbench/browser/parts/views/media/views.css';

import type { IStyle } from '../terminal/dom/paint.js';

import { localize } from '../../vs/nls.js';
import { IContextMenuDelegate } from '../../vs/base/browser/contextmenu.js';
import { Color } from '../../vs/base/common/color.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, toDisposable } from '../../vs/base/common/lifecycle.js';
import { IContextMenuMenuDelegate } from '../../vs/platform/contextview/browser/contextView.js';
import type { IContextKeyServiceTarget } from '../../vs/platform/contextkey/common/contextkey.js';
import { RangeMap } from '../../vs/base/browser/ui/list/rangeMap.js';
import { Scrollable } from '../../vs/base/common/scrollable.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { PendingWork } from '../../vs/workbench/browser/tauri/pendingWork.js';
import { foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { listActiveSelectionBackground, listActiveSelectionForeground } from '../../vs/platform/theme/common/colors/listColors.js';
import { IKey, IMouse } from '../terminal/input.js';
import { cut, ILine, lineWidth } from '../terminal/screen.js';
import { lineRenderRecords, renderRecordsLine } from '../../render/domRecords.js';
import { IPaneChromeProjectionSource, PaneChromeInputEvent, PaneChromeProjectionGateway } from '../../workbench/paneChromeProjection.js';

/**
 * One wheel notch, as `ListView` reads it: a fixed number of rows rather than a pixel delta — and
 * the same number of *columns* once the gesture is horizontal, because upstream's shift-convert
 * moves the delta to the other axis rather than scaling it (`scrollableElement.ts`).
 *
 * It is also what `list.scrollLeft` and `list.scrollRight` move by. Upstream's own amount for those
 * is `scrollLeft ± 10` **pixels**, which is a fraction of one character: a cell is the unit that
 * survives the change of unit, and a notch is the only horizontal quantity already stated in it.
 */
const WHEEL_STEP = 3;

/**
 * The keys `handleKey` below answers, which is what the status line names for a pane that declares
 * no `hint` of its own. It is a string rather than a derived hint because none of these keys is a
 * command: they are the list's own movement, and there is no rule in the registry to read a label
 * off.
 */
export const NAVIGATION_HINT = localize('tscode.navigationHint', "↑↓ move");

/**
 * The same, for a pane whose rows fold: `←` and `→` are the tree's own collapse and expand, which
 * three panes answer in `handleKey` and the rest do not. **Naming them everywhere was a promise two
 * panes could not keep** — the commit-info drawer and the graph are flat lists, and a status line
 * offering `←→` there sent the user looking for a horizontal scroll that lives on `Ctrl`+`←→`
 * (`list.scrollLeft` / `list.scrollRight`) and works in every pane.
 */
export const TREE_NAVIGATION_HINT = localize('tscode.treeNavigationHint', "↑↓→← move");

/**
 * Work a keystroke started that has not painted yet, and the wait for it — the holder both
 * frontends use, re-exported so a pane and `Overlays` read it from one place beside them.
 *
 * A pane must not drop such a promise on the floor: a driven run would then read the screen before
 * the answer arrived.
 */
export { PendingWork };

/**
 * What a pane says its focused row offers. `getAnchor` is the workbench's, because a row knows its
 * index and only the frame knows where that index landed — which is the same split a browser makes,
 * where the *view* fills `getActions` and the *tree widget* fills the anchor out of the event.
 */
export type IPaneContextMenu = Omit<IContextMenuDelegate, 'getAnchor'> | Omit<IContextMenuMenuDelegate, 'getAnchor'>;

export interface ITreeProjectionChangeEvent {
	readonly diagnosticEventId?: number;
}

export abstract class Pane extends Disposable {

	/** The pane's name in the tab bar. */
	abstract readonly title: string;

	/**
	 * The id of the view this pane is the terminal form of, as tscode registers it. It is what
	 * `focusedView` answers while the pane is focused, so a `when` clause scoped to the view —
	 * ours or upstream's — applies here for the same reason it applies there.
	 */
	abstract readonly viewId: string;

	/** Context target of the VS Code controller this painter represents, when it has one. */
	keybindingTarget(): IContextKeyServiceTarget | undefined { return undefined; }

	/** How many rows the pane currently has. */
	abstract get rowCount(): number;

	/** The row as styled spans. `focused` is set for the row the keyboard is on. */
	protected abstract renderRow(index: number, focused: boolean): ILine;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the pane wants repainting. */
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidTreeProjectionChange = this._register(new Emitter<ITreeProjectionChangeEvent>());
	/** Rows or their shared selection changed; header-only repaint is deliberately excluded. */
	readonly onDidTreeProjectionChange: Event<ITreeProjectionChangeEvent> = this._onDidTreeProjectionChange.event;
	private treeProjectionTransactionDepth = 0;
	private treeProjectionDirty = false;
	private treeProjectionDiagnosticEventId: number | undefined;
	/** Native/shared adapters may suppress raw model deltas until this transaction publishes refresh. */
	protected get treeProjectionTransactionActive(): boolean {
		return this.treeProjectionTransactionDepth > 0;
	}

	private readonly rangeMap = new RangeMap();
	private readonly scrollable = this._register(new Scrollable({
		forceIntegerValues: true,
		// A terminal viewport's positions are whole rows and there is no animation frame to
		// interpolate over, so a smooth scroll would be a scroll with steps missing.
		smoothScrollDuration: 0,
		scheduleAtNextAnimationFrame: callback => {
			const handle = setTimeout(callback, 0);

			return toDisposable(() => clearTimeout(handle));
		}
	}));

	private _focus = 0;
	private height = 0;
	private width = 0;

	/**
	 * How wide the pane's content is, which is `scrollWidth`. Upstream measures the rows it has in
	 * the DOM and grows the number as more of them are rendered (`ListView.updateWidth`), so a row
	 * that has never been on screen is not in it.
	 */
	private contentWidth = 0;

	/**
	 * That a splice happened, so the next measurement starts from nothing rather than growing what
	 * the rows it replaced had measured.
	 *
	 * **It is a flag rather than a reset, and the difference is a scroll position.** Zeroing
	 * `contentWidth` in the splice publishes a `scrollWidth` of zero to `Scrollable`, which clamps
	 * `scrollLeft` to zero on the spot — so a pane re-splicing rows that did not change (the search
	 * pane rebuilds on its own `RunOnceScheduler`, twice per batch) threw away the position a
	 * moment after the user scrolled to it, and left the two keys disabled in the window between.
	 * Upstream never has that window: `updateScrollWidth` recomputes from measurements it *keeps*
	 * per item, so an unchanged row answers with the same width and nothing moves.
	 */
	private remeasure = false;

	private readonly pending = this._register(new PendingWork('pane'));
	private _paneChromeProjection: PaneChromeProjectionGateway | undefined;

	constructor(protected readonly themeService: IThemeService) {
		super();
	}

	/** One immutable header/state source shared by ANSI and native chrome projectors. */
	get paneChromeProjection(): IPaneChromeProjectionSource {
		if (!this._paneChromeProjection) {
			const gateway = this._register(new PaneChromeProjectionGateway({ ...this.chromeSnapshot(1), focused: false }, event => this.handleChromeInput(event)));
			this._register(this.onDidChange(() => gateway.publish(this.chromeSnapshot())));
			this._paneChromeProjection = gateway;
		}
		return this._paneChromeProjection;
	}

	private chromeSnapshot(generation = 0) {
		return {
			generation,
			identity: this.viewId,
			title: this.title,
			header: this.header().map(lineRenderRecords),
			textInputValue: this.textInputValue,
			canEdit: this.canEdit,
			editing: this.editing,
			filtering: this.filtering,
			expanded: this.isExpanded()
		};
	}

	private handleChromeInput(event: PaneChromeInputEvent): boolean {
		switch (event.kind) {
			case 'set-text': return this.setTextInputValue(event.value, event.diagnosticEventId);
			case 'set-expanded': return this.setExpanded(event.expanded);
			case 'set-editing': return this.setEditing(event.editing);
			case 'complete-filter': this.completeFilter(event.delta); return true;
			case 'scroll-horizontal': return this.scrollHorizontallyBy(event.direction);
			case 'focus': return true;
			case 'activate-segment': return this.activateHeaderSegment(event.actionId);
		}
	}

	/** A semantic painted-header target activated by either frontend. */
	protected activateHeaderSegment(_actionId: string): boolean { return false; }

	/** The row the keyboard is on. */
	get focus(): number {
		return this._focus;
	}

	/**
	 * What a row's background is, whether or not its text reaches the edge of the pane.
	 *
	 * Upstream's `.monaco-list-row` is a block element the width of the list, so the background
	 * `DefaultStyleController.style` writes for `.focused` — `defaultListStyles`'
	 * `list.activeSelectionBackground` — covers the whole row. A line of spans stops where the text
	 * stops, so `layout` fills the rest of the row out to the width the pane was laid out at, and
	 * this is the colour it fills it in. Every pane draws its focused row's spans in the same one.
	 */
	protected rowBackground(index: number, focused: boolean): Color | undefined {
		return focused ? this.themeService.getColorTheme().getColor(listActiveSelectionBackground) : undefined;
	}

	/** A widget-backed pane reads row focus from its widget, including an empty focus. */
	protected isRowFocused(index: number): boolean { return index === this._focus; }

	/**
	 * What a row starts from: the selection's foreground while the row has the cursor and the
	 * theme's otherwise, over whatever `rowBackground` gives it. It is `defaultListStyles`'
	 * `listActiveSelectionForeground` pair, which is the one every pane drawing in the theme's own
	 * colours opens with — the picker and the context menu name colours of their own instead, and
	 * build their style from those.
	 */
	protected rowStyle(index: number, focused: boolean): IStyle {
		const theme = this.themeService.getColorTheme();

		return {
			fg: focused ? theme.getColor(listActiveSelectionForeground) : theme.getColor(foreground),
			bg: this.rowBackground(index, focused)
		};
	}

	/** Rows are one line tall unless a pane says otherwise. */
	protected rowHeight(index: number): number {
		return 1;
	}

	/**
	 * Lines above the list, which do not scroll and cannot take focus — the search pane's query
	 * box and its result count. A pane with none is laid out exactly as before.
	 */
	protected header(): ILine[] {
		return [];
	}

	/**
	 * Whether there is a text input to type into — the search pane's query box, or an SCM commit
	 * message on the focused row. `Workbench` publishes it as `tscodeCanEditInput`, which is what
	 * decides whether the key that starts editing means anything here.
	 */
	get canEdit(): boolean {
		return false;
	}

	/**
	 * Whether that input is being typed into. Published as upstream's `inputFocus`, which is how
	 * every single-character keybinding stays out of the way while it is true.
	 */
	get editing(): boolean {
		return false;
	}

	/**
	 * Whether the box being typed into is the view root's filter row. Published as
	 * `tscodeFiltering`, which is what scopes `Tab`'s completion to the pane that has one — a pane
	 * with two boxes sets `inputFocus` for either of them.
	 */
	get filtering(): boolean {
		return false;
	}

	/** The committed value of the pane-owned input that is currently editing. */
	get textInputValue(): string | undefined {
		return undefined;
	}

	/** Replaces that input atomically, through the same model setter ordinary pane editing uses. */
	setTextInputValue(_value: string, _diagnosticEventId?: number): boolean {
		return false;
	}

	/**
	 * `Tab` in that box: the ranked row `delta` on from the one it already reads, written into the
	 * query's last segment and taken by the cursor. Only a pane with a view root has one, which is
	 * what `filtering` says — so the key is declared once, for whichever pane answers it.
	 */
	completeFilter(delta: number): void { }

	/** Starts or stops typing into it. Answers whether the state changed. */
	setEditing(editing: boolean): boolean {
		return false;
	}

	/**
	 * The navigation keys the status line names, which are the ones `handleKey` answers rather
	 * than a keybinding rule. Everything bound to a command is appended by `commands.ts`.
	 */
	get hint(): string | undefined {
		return undefined;
	}

	/**
	 * Whether the view is expanded, which is `Pane._expanded` (`paneview.ts:194`). A collapsed view
	 * keeps its header and is given no body rows, exactly as a collapsed pane's `minimumSize` there
	 * is its `headerSize` and nothing more.
	 *
	 * Whether it may be collapsed at all is not the pane's to answer: `updateViewHeaders`
	 * (`viewPaneContainer.ts:1089`) sets `collapsible` from the *container* — a merged single view is
	 * forced expanded and a lone unmerged one is not collapsible — so `Workbench` decides it.
	 */
	private _expanded = true;

	isExpanded(): boolean {
		return this._expanded;
	}

	/** `Pane.setExpanded`: answers whether the state changed, as upstream's does. */
	setExpanded(expanded: boolean): boolean {
		if (this._expanded === expanded) {
			return false;
		}

		this._expanded = expanded;
		this._onDidChange.fire();

		return true;
	}

	/**
	 * The actions the focused row offers, or nothing for a pane whose rows have no menu. The
	 * workbench turns it into a context menu on `Shift+F10`, anchored at `focusOffset`.
	 */
	contextMenu(): IPaneContextMenu | undefined {
		return undefined;
	}

	/**
	 * Whether the focused row has any. `Workbench` publishes it as `tscodeHasContextMenu`, which is
	 * what keeps `Shift+F10` off the status line where it would do nothing — so it has to be cheap:
	 * it is asked before every resolve and every paint, and building a menu is not.
	 */
	get hasContextMenu(): boolean {
		return false;
	}

	/**
	 * Which of the pane's own lines the cursor row is drawn on, which is what anchors a menu to it.
	 * A row scrolled out of view answers the first line, as `getBoundingClientRect` does for an
	 * element a browser has not laid out.
	 */
	get focusOffset(): number {
		let offset = this.header().length;
		for (let index = this.rangeMap.indexAt(this.scrollTop); index < this._focus; index++) {
			offset += this.rowHeight(index);
		}

		return Math.max(0, Math.min(offset, this.header().length + this.height - 1));
	}

	/** Whatever the pane has to do before its first paint. */
	async open(): Promise<void> { }

	/**
	 * Runs work a keystroke started — reading a folder, a query — without waiting for it, and
	 * keeps it visible to `whenSettled`.
	 */
	protected track(work: Promise<unknown>, label = `${this.constructor.name}.semantic`): void {
		this.pending.track(work, label);
	}

	/** Owns both a queued task and the queue-drain edge that makes the next semantic task runnable. */
	protected trackQueued<T>(
		queue: { queue(factory: () => Promise<T>): Promise<T>; whenIdle(): Promise<void> },
		factory: () => Promise<T>,
		label = `${this.constructor.name}.queuedSemantic`
	): Promise<T> {
		return this.pending.queue(queue, factory, label);
	}

	settlementDiagnostics(): readonly { readonly label: string; readonly ageMs: number }[] { return this.pending.diagnostics(); }

	/** Nothing the pane started is outstanding — `Workbench.whenSettled`'s question between passes. */
	get idle(): boolean {
		return this.pending.idle;
	}

	/** Resolves once nothing the pane started is still outstanding. */
	async whenSettled(): Promise<void> {
		await this.pending.whenSettled();
	}

	/**
	 * Asks for a repaint without re-measuring. For a change that is visible and is not a change to
	 * the rows — a character typed into a header box, an input row's value — where re-measuring
	 * every row per keystroke would be work with no answer of its own.
	 */
	protected repaint(): void {
		this._onDidChange.fire();
	}

	/**
	 * Re-reads the row count and heights. A pane calls this whenever its rows change, which is
	 * the one call that must always travel with a change to them.
	 */
	protected didChangeRows(diagnosticEventId?: number, revealFocus = true): void {
		const items = [];
		for (let i = 0; i < this.rowCount; i++) {
			items.push({ size: this.rowHeight(i) });
		}
		this.rangeMap.splice(0, this.rangeMap.count, items);
		// The rows these were measured from are gone, so the next `layout` measures whatever
		// replaced them instead of growing their number — and `scrollWidth` keeps the width it had
		// until that measurement exists, because a width of nothing is a scroll position of nothing.
		this.remeasure = true;
		this.setScrollDimensions();
		this._focus = Math.max(0, Math.min(this._focus, this.rowCount - 1));
		if (revealFocus) { this.reveal(this._focus); }
		this.invalidateTreeProjection(diagnosticEventId);
		this._onDidChange.fire();
	}

	/**
	 * Publishes one immutable tree boundary after a semantic update has completely settled. Tree
	 * models are allowed to keep the same visible identities while their render/filter/status
	 * semantics change, so a rendered-node splice cannot be the publication token by itself.
	 */
	protected invalidateTreeProjection(diagnosticEventId?: number): void {
		if (this.treeProjectionTransactionDepth > 0) {
			this.treeProjectionDirty = true;
			return;
		}
		this._onDidTreeProjectionChange.fire({ diagnosticEventId });
	}

	private beginTreeProjectionTransaction(diagnosticEventId?: number): void {
		if (this.treeProjectionTransactionDepth === 0) {
			this.treeProjectionDiagnosticEventId = diagnosticEventId;
		} else if (this.treeProjectionDiagnosticEventId === undefined) {
			this.treeProjectionDiagnosticEventId = diagnosticEventId;
		}
		this.treeProjectionTransactionDepth++;
	}

	private endTreeProjectionTransaction(): void {
		this.treeProjectionTransactionDepth--;
		if (this.treeProjectionTransactionDepth === 0 && this.treeProjectionDirty) {
			this.treeProjectionDirty = false;
			const event = { diagnosticEventId: this.treeProjectionDiagnosticEventId };
			this.treeProjectionDiagnosticEventId = undefined;
			this._onDidTreeProjectionChange.fire(event);
		} else if (this.treeProjectionTransactionDepth === 0) {
			this.treeProjectionDiagnosticEventId = undefined;
		}
	}

	/** A fully in-memory model change commits its row projection before the input callback returns. */
	protected transactTreeProjectionSync<T>(work: () => T, diagnosticEventId?: number): T {
		this.beginTreeProjectionTransaction(diagnosticEventId);
		try {
			return work();
		} finally {
			this.endTreeProjectionTransaction();
		}
	}

	/** Coalesces synchronous/async row, focus and status changes into one settled projection event. */
	protected async transactTreeProjection<T>(work: () => Promise<T>, diagnosticEventId?: number): Promise<T> {
		this.beginTreeProjectionTransaction(diagnosticEventId);
		try {
			return await work();
		} finally {
			this.endTreeProjectionTransaction();
		}
	}

	/**
	 * The lines to paint, for a viewport of `height` rows — the header first, then the list.
	 *
	 * `width` is what turns the horizontal axis on, which is `ListView.layout(height, width)`'s own
	 * signature: a caller that does not say how wide the pane is leaves `horizontalScrolling` at
	 * upstream's default of off, and every line is painted from column zero as before. The header
	 * does not move with it — it is a widget above the list there, not a row in it.
	 */
	layout(height: number, width?: number): ILine[] {
		const header = this.paneChromeProjection.snapshot.header.map(renderRecordsLine) as ILine[];
		const body = Math.max(0, height - header.length);

		if (body !== this.height || (width !== undefined && width !== this.width)) {
			this.height = body;
			this.width = width ?? this.width;
			this.setScrollDimensions();
		}

		const top = this.scrollTop;
		const lines: ILine[] = [];
		const backgrounds: (Color | undefined)[] = [];

		for (let index = this.rangeMap.indexAt(top); index < this.rowCount && lines.length < body; index++) {
			const focused = this.isRowFocused(index);
			const line = this.renderRow(index, focused);
			const background = this.rowBackground(index, focused);
			for (let row = 0; row < this.rowHeight(index) && lines.length < body; row++) {
				lines.push(line);
				backgrounds.push(background);
			}
		}

		this.measure(lines);
		const left = this.scrollLeft;

		return [...header, ...lines.map((line, at) => this.fill(left ? cut(line, left, Number.MAX_SAFE_INTEGER) : line, backgrounds[at]))];
	}

	/**
	 * A row's line padded out to the pane's width in the colour the row is drawn in, which is what
	 * makes a selected row read as selected across the pane rather than only under its text. A pane
	 * laid out without a width — an editor's, which `EditorArea` lays out by height alone — is padded
	 * by the strip it is composited into, exactly as before.
	 */
	private fill(line: ILine, background: Color | undefined): ILine {
		const remaining = this.width - lineWidth(line);

		return background && remaining > 0 ? [...line, { text: ' '.repeat(remaining), bg: background }] : line;
	}

	/**
	 * What the rows just rendered do to `scrollWidth`, which is `ListView.updateWidth`: a row wider
	 * than anything measured so far grows it, and the scroll position is re-clamped against the new
	 * one before those rows are cut.
	 */
	private measure(lines: readonly ILine[]): void {
		const widest = lines.reduce((width, line) => Math.max(width, lineWidth(line)), this.remeasure ? 0 : this.contentWidth);
		this.remeasure = false;
		if (widest !== this.contentWidth) {
			this.contentWidth = widest;
			this.setScrollDimensions();
		}
	}

	/**
	 * Whether the pane takes this keystroke itself, ahead of the keybinding resolver.
	 *
	 * The one pane that answers yes is the one hosting a child process: a shell or an `$EDITOR`
	 * needs `Tab`, `Escape` and `Ctrl+C` far more than the workbench does. It is the question
	 * `TerminalInstance.attachCustomKeyEventHandler` asks of every key a terminal has focus for,
	 * and the answer is upstream's: `commandId()` is what the resolver *would* run, and the
	 * workbench keeps only the commands in `terminal.integrated.commandsToSkipShell`.
	 *
	 * `commandId` is a thunk because resolving costs a `softDispatch` per keystroke and every
	 * other pane answers without asking — and because the status line asks the same question of a
	 * command it already has the id of, so that it names only the keys that still reach.
	 */
	takesKey(commandId: () => string | undefined, key?: IKey): boolean {
		return false;
	}

	handleKey(key: IKey): boolean {
		switch (key.name) {
			case 'up': return this.focusBy(-1);
			case 'down': return this.focusBy(1);
			case 'pageUp': return this.focusBy(-Math.max(1, this.height - 1));
			case 'pageDown': return this.focusBy(Math.max(1, this.height - 1));
			case 'home': return this.focusTo(0);
			case 'end': return this.focusTo(this.rowCount - 1);
		}

		return false;
	}

	/**
	 * Pasted text, which is not typed text: it has already skipped the keybinding resolver by the
	 * time it reaches a pane, so no character in it can run a command. What is left is what a
	 * browser does with a paste — the focused text input takes it, and everything else ignores it.
	 *
	 * So the default offers each character to `handleKey` as the character it is, and a pane that
	 * has no input to type into answers `false` to every one of them without a second arm to write.
	 * **A control character is dropped**: `Enter` is a command in every input this fork has, and a
	 * newline in a clipboard is exactly how a paste would otherwise run one.
	 */
	handlePaste(text: string): boolean {
		let handled = false;
		for (const char of text) {
			if (char >= ' ' && char !== '\x7f') {
				handled = this.handleKey({ name: 'char', char, sequence: char }) || handled;
			}
		}

		return handled;
	}

	handleMouse(mouse: IMouse, top: number): boolean {
		const listTop = top + this.header().length;

		switch (mouse.kind) {
			// Shift held turns a vertical wheel into a horizontal one, which is upstream's own rule
			// for the gesture (`_onMouseWheel`'s `shiftConvert`) rather than one of ours.
			case 'wheelUp': return mouse.shift ? this.scrollBy(0, -WHEEL_STEP) : this.scrollBy(-WHEEL_STEP);
			case 'wheelDown': return mouse.shift ? this.scrollBy(0, WHEEL_STEP) : this.scrollBy(WHEEL_STEP);
			case 'down': return mouse.row >= listTop && this.focusTo(this.rangeMap.indexAt(this.scrollTop + mouse.row - listTop));
		}

		return false;
	}

	/** Maps a painted terminal row back to the item index the shared viewport is displaying. */
	protected rowIndexAt(screenRow: number, top: number): number {
		const offset = screenRow - top - this.header().length;
		if (offset < 0 || offset >= this.height) { return -1; }
		const index = this.rangeMap.indexAt(this.scrollTop + offset);
		return index >= 0 && index < this.rowCount ? index : -1;
	}

	protected focusBy(delta: number): boolean {
		return this.focusTo(this._focus + delta);
	}

	protected focusTo(index: number): boolean {
		const focus = Math.max(0, Math.min(index, this.rowCount - 1));
		if (focus === this._focus) {
			return true;
		}

		this._focus = focus;
		this.reveal(focus);
		this.invalidateTreeProjection();
		this._onDidChange.fire();

		return true;
	}

	/**
	 * Whether anything is off the right-hand edge. `Workbench` publishes it, which is what keeps the
	 * two scrolling keys off the status line of a pane where they could do nothing — the reason
	 * `tscodeMultipleViews` exists, and the reason upstream scopes `list.scrollUp` out of a list
	 * already at the top.
	 */
	get canScrollHorizontally(): boolean {
		return this.width > 0 && this.contentWidth > this.width;
	}

	/** `list.scrollLeft` and `list.scrollRight`: one step in the direction's sign. */
	scrollHorizontallyBy(direction: number): boolean {
		return this.scrollBy(0, direction * WHEEL_STEP);
	}

	private scrollBy(rows: number, columns = 0): boolean {
		this.scrollable.setScrollPositionNow({
			scrollTop: this.scrollTop + rows,
			scrollLeft: this.scrollLeft + columns
		});
		this._onDidChange.fire();

		return true;
	}

	/** Scrolls the least amount that brings a row fully into the viewport, as `ListView` does. */
	private reveal(index: number): void {
		// A pane's rows change before its first `layout`, and there is no viewport to reveal into
		// yet: `elementBottom > 0 + 0` holds for every row, so this would scroll a list that is
		// taller than the screen off its own first row. `ListView` cannot reach the state because a
		// DOM node has a height before anything is in it.
		if (this.height === 0) {
			return;
		}

		const elementTop = this.rangeMap.positionAt(index);
		if (elementTop < 0) {
			return;
		}

		const elementBottom = elementTop + this.rowHeight(index);
		const top = this.scrollTop;

		if (elementTop < top) {
			this.scrollable.setScrollPositionNow({ scrollTop: elementTop });
		} else if (elementBottom > top + this.height) {
			this.scrollable.setScrollPositionNow({ scrollTop: elementBottom - this.height });
		}
	}

	protected get scrollTop(): number {
		return this.scrollable.getCurrentScrollPosition().scrollTop;
	}

	/** The first row actually visible in this pane, independent of which row owns the keyboard. */
	protected get firstVisibleRow(): number {
		return this.rangeMap.indexAt(this.scrollTop);
	}

	protected setScrollTop(scrollTop: number): void {
		this.scrollable.setScrollPositionNow({ scrollTop });
		this.repaint();
	}

	private get scrollLeft(): number {
		return this.scrollable.getCurrentScrollPosition().scrollLeft;
	}

	private setScrollDimensions(): void {
		this.scrollable.setScrollDimensions({
			height: this.height,
			scrollHeight: this.rangeMap.size,
			width: this.width,
			scrollWidth: this.contentWidth
		}, false);
	}
}
