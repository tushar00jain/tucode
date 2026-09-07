/*---------------------------------------------------------------------------------------------
 *  The floating layer: something drawn over the parts, that has the keyboard while it is up.
 *
 *  A browser gives the workbench this for free — an absolutely positioned element over everything
 *  else, with focus in it. A terminal has one grid of cells and one stream of keys, so the layer is
 *  explicit: `Overlays` holds a stack, `Workbench` composites it over the frame it just built and
 *  offers every keystroke to the top of the stack first.
 *
 *  **The geometry is upstream's, in cells rather than pixels.** Where a box goes is `layout2d`
 *  (`base/common/layout.ts`), the same flip-and-clamp arithmetic `ContextView.doLayout` uses and
 *  unit-agnostic — so a menu that would run off the bottom flips above its row here for the reason
 *  it does there. How big a quick input is comes from `QuickInputController.updateLayout`:
 *  `width * 0.62`, which its own comment calls the golden cut, and `height * 0.4`. Both are ratios,
 *  and therefore survive the change of unit exactly as `SIDEBAR_SIZE`'s `width / 4` did (`§6.2`).
 *
 *  **The list inside an overlay is `Pane`.** A quick pick and a context menu are each a row count, a
 *  row renderer and a cursor, which is what `Pane` already is — and upstream agrees at the level
 *  that matters: `QuickInputTree` is a `WorkbenchObjectTree`, the same widget its views are built
 *  from. So `ListOverlay` extends `Pane` and inherits `RangeMap`, `Scrollable` and the navigation
 *  keys rather than carrying a second scroll model.
 *
 *  Upstream counterpart: src/vs/base/browser/ui/contextview/contextview.ts
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { AnchorPosition, IRect, layout2d } from '../../vs/base/common/layout.js';
import { combinedDisposable, Disposable, DisposableMap, IDisposable, toDisposable } from '../../vs/base/common/lifecycle.js';
import { IKey } from '../terminal/input.js';
import { columns, ILine, over } from '../terminal/screen.js';
import { Pane, PendingWork } from './pane.js';

/** `QuickInputController.updateLayout`'s own two ratios, with the pixel divided out. */
export const GOLDEN_CUT = 0.62;
export const LIST_HEIGHT_SHARE = 0.4;

/** The frame an overlay is placed in. */
export interface IFrameSize {
	readonly cols: number;
	readonly rows: number;
}

/** How big an overlay is, in cells — the outer box, border included. */
export interface IOverlaySize {
	readonly width: number;
	readonly height: number;
}

/**
 * One thing on the floating layer. It is a box of lines and a key handler, and nothing else: where
 * it lands, what it is drawn over and when it is torn down are the host's.
 */
export interface IOverlay {

	/** Fires when the overlay wants repainting. */
	readonly onDidChange: Event<void>;

	/** Fires when the overlay is done. Every way out of an overlay ends here. */
	readonly onDidClose: Event<void>;

	/** The rectangle it hangs off, or nothing for the centred placement a quick input opens with. */
	readonly anchor?: IRect;

	/** `menu.background` / `quickInput.background` — what fills the box. */
	readonly background: Color | undefined;

	/**
	 * Whether the overlay is still filling itself. A box waiting for a keystroke is settled and one
	 * waiting for its own results is not, which is the difference `Workbench.whenSettled` reads:
	 * `IQuickPick.busy` is upstream's own flag for it and `PickerQuickAccessProvider` sets it around
	 * every slow `_getPicks`.
	 */
	readonly busy?: boolean;

	/** The one-column rule upstream paints as a 1px border, where the theme defines one. */
	readonly border?: Color | undefined;

	/** What the status line says while this has the keyboard. */
	readonly hint: string;

	size(frame: IFrameSize): IOverlaySize;

	/** The inside of the box, at the size the host settled on. */
	render(size: IOverlaySize): ILine[];

	/** Answers whether the key was consumed. A key it does not take falls through to the workbench. */
	handleKey(key: IKey): boolean;

	/** The same for pasted text, which the resolver has already been kept out of (`Pane.handlePaste`). */
	handlePaste(text: string): boolean;

	/** Takes it down as though the user had escaped it. What ends a run with one still open. */
	cancel(): void;
}

/**
 * An overlay that is a list — which both of the ones this frontend has are. Everything about the
 * rows, the cursor and the scrolling is `Pane`'s; what is added here is the box the list sits in
 * and the two keys that end it.
 */
export abstract class ListOverlay extends Pane implements IOverlay {

	/** An overlay is not a view, so no `when` clause and no `focusedView` answer names one. */
	readonly viewId = '';
	/** Not readonly, because a quick input's title is set by whoever opened it. */
	title = '';

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;

	abstract get background(): Color | undefined;

	abstract override get hint(): string;

	abstract size(frame: IFrameSize): IOverlaySize;

	/** The size the host settled on, which a row needs in order to fill it — a rule, a right edge. */
	protected inner: IOverlaySize = { width: 0, height: 0 };

	render(size: IOverlaySize): ILine[] {
		this.inner = size;
		// The width is what fills a focused row out to the box's edge — an overlay's rows are
		// `.monaco-list-row`s too, and a menu's focused action is as wide as the menu.
		const lines = this.layout(size.height, size.width);

		return [...lines, ...Array.from({ length: Math.max(0, size.height - lines.length) }, (): ILine => [])];
	}

	/** Whether a row can take the cursor. A separator cannot, and neither can a disabled action. */
	protected focusable(index: number): boolean {
		return true;
	}

	/**
	 * Navigation that steps over what cannot take the cursor, which is what both of upstream's
	 * widgets do — `Menu` makes a separator unfocusable and `QuickInputTree` filters one out of its
	 * focus set. The direction is the one the caller was moving in, so a separator between two items
	 * is crossed rather than landed on, and it turns round at either end: the command palette's
	 * first row is a *"recently used"* separator as soon as one command has been run, and there is
	 * nothing in front of it to land on.
	 */
	protected override focusTo(index: number): boolean {
		if (this.rowCount === 0) {
			return super.focusTo(0);
		}

		const step = index < this.focus ? -1 : 1;
		let at = Math.max(0, Math.min(index, this.rowCount - 1));
		for (let stepped = 0; stepped < this.rowCount && !this.focusable(at); stepped++) {
			at = (at + step + this.rowCount) % this.rowCount;
		}

		return super.focusTo(at);
	}

	/** Escaping. A picker overrides it, because a caller is waiting on an answer it has to give. */
	cancel(): void {
		this.close();
	}

	protected close(): void {
		this._onDidClose.fire();
	}
}

/** The corners and rules of a one-cell box, which is what a 1px border is in a grid of cells. */
const BOX = { topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘', horizontal: '─', vertical: '│' };

export class Overlays extends Disposable {

	private readonly stack: IOverlay[] = [];
	private readonly listeners = this._register(new DisposableMap<IOverlay, IDisposable>());

	/**
	 * Work an overlay started that outlives it. An action picked from a context menu runs *after*
	 * the menu is gone, so the promise cannot be the overlay's — a driven run would read the screen
	 * before the action landed.
	 */
	private readonly pending = this._register(new PendingWork('overlay'));

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the layer wants repainting — an overlay shown, hidden or changed. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** The overlay the keyboard is in, or nothing. */
	get top(): IOverlay | undefined {
		return this.stack[this.stack.length - 1];
	}

	get hint(): string | undefined {
		return this.top?.hint;
	}

	/** Whether the overlay with the keyboard is still filling itself — see `IOverlay.busy`. */
	get busy(): boolean {
		return !!this.top?.busy;
	}

	/** Puts an overlay on the layer. It comes off when it closes, or when the handle is disposed. */
	show(overlay: IOverlay): IDisposable {
		this.stack.push(overlay);

		const remove = toDisposable(() => {
			const at = this.stack.indexOf(overlay);
			if (at === -1) {
				return;
			}

			this.stack.splice(at, 1);
			this.listeners.deleteAndDispose(overlay);
			this._onDidChange.fire();
		});

		this.listeners.set(overlay, combinedDisposable(
			overlay.onDidChange(() => this._onDidChange.fire()),
			overlay.onDidClose(() => remove.dispose())
		));
		this._onDidChange.fire();

		return remove;
	}

	handleKey(key: IKey): boolean {
		return !!this.top?.handleKey(key);
	}

	handlePaste(text: string): boolean {
		return !!this.top?.handlePaste(text);
	}

	/**
	 * Takes every overlay down. Stdin closing is the end of a driven run, and an unanswered picker
	 * would otherwise be work that never settles — a run that has finished and does not exit, which
	 * §16.7 calls a defect rather than something to wait out.
	 */
	cancelAll(): void {
		for (const overlay of [...this.stack].reverse()) {
			overlay.cancel();
		}
	}

	track(work: Promise<unknown>): void {
		this.pending.track(work);
	}

	/** Nothing an overlay started is outstanding — `Workbench.whenSettled`'s question between passes. */
	get idle(): boolean {
		return this.pending.idle;
	}

	/** Resolves once nothing an overlay started is still outstanding. */
	async whenSettled(): Promise<void> {
		await this.pending.whenSettled();
	}

	/** Every overlay drawn over the frame, bottom of the stack first. */
	compose(frame: readonly ILine[], size: IFrameSize): ILine[] {
		let painted = [...frame];

		for (const overlay of this.stack) {
			painted = this.draw(painted, overlay, size);
		}

		return painted;
	}

	private draw(frame: ILine[], overlay: IOverlay, frameSize: IFrameSize): ILine[] {
		const asked = overlay.size(frameSize);
		const width = Math.max(1, Math.min(asked.width, frameSize.cols));
		const height = Math.max(1, Math.min(asked.height, frameSize.rows));
		const border = overlay.border;
		const inset = border ? 1 : 0;
		const inner = { width: Math.max(0, width - inset * 2), height: Math.max(0, height - inset * 2) };

		const { top, left } = this.place(overlay, { width, height }, frameSize);
		const lines = overlay.render(inner);

		if (!border) {
			return over(frame, lines, top, left, width, overlay.background);
		}

		// Each row cut or padded to the inside of the box, so the right-hand rule lands on the edge
		// rather than after the text — `columns` is the same fit the parts are laid out with.
		const body = columns([{ width: inner.width, lines, background: overlay.background }], inner.height);
		const rule = (start: string, end: string): ILine =>
			[{ text: start + BOX.horizontal.repeat(Math.max(0, width - 2)) + end, fg: border, bg: overlay.background }];
		const side = { text: BOX.vertical, fg: border, bg: overlay.background };
		const boxed: ILine[] = [
			rule(BOX.topLeft, BOX.topRight),
			...body.map((line): ILine => [side, ...line, side]),
			rule(BOX.bottomLeft, BOX.bottomRight)
		];

		return over(frame, boxed, top, left, width, overlay.background);
	}

	/**
	 * Where the box lands. With an anchor that is `layout2d`, upstream's own arithmetic for putting
	 * a context view beside the thing it is about and flipping it when it does not fit; without one
	 * it is `updateLayout`'s no-anchor arm — centred horizontally, at the top of the workbench,
	 * which is where a quick input opens.
	 */
	private place(overlay: IOverlay, size: IOverlaySize, frame: IFrameSize): { top: number; left: number } {
		if (!overlay.anchor) {
			return { top: 0, left: Math.max(0, Math.round(frame.cols / 2 - size.width / 2)) };
		}

		const viewport: IRect = { top: 0, left: 0, width: frame.cols, height: frame.rows };
		const placed = layout2d(viewport, size, overlay.anchor, { anchorPosition: AnchorPosition.BELOW });

		return {
			top: Math.max(0, Math.min(placed.top, frame.rows - size.height)),
			left: Math.max(0, Math.min(placed.left, frame.cols - size.width))
		};
	}
}
