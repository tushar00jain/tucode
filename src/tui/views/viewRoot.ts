/*---------------------------------------------------------------------------------------------
 *  What a view root's `/` **draws**, and what the box does with a key — the two answers that are
 *  cells in a character grid rather than decisions, for the panes that have a `/`.
 *
 *  **Everything the box decides is the vendored tree's**: the grammar (how a query splits into a
 *  path and a name, how the path descends, what `Tab` completes to) is
 *  `vs/workbench/browser/tauri/viewRoot.ts`, the composition of a pane's ranking over the filter and
 *  the sorter its tree already had is `viewRootFilter.ts` beside it, and **the driving of the box —
 *  when each arm runs, in what order, and what `Tab` cycles — is `viewRootController.ts`**. Panes
 *  import all three directly; only the paint is here.
 *
 *  So what is here is a box and a base. `FilterBox` is the terminal's `ViewRootBox`: a string and a
 *  header row where the GUI has an `InputBox` mounted in the pane body, answering the same
 *  `IViewRootBox` the driving reaches. `PaneViewRoot` is the part of `ViewRootController` every
 *  *pane* answers the same way — the cursor is an index, and a header row costs no layout of its own.
 *
 *  It is the same header and the same keys as its counterpart, mounted there as an `InputBox` in the
 *  pane body instead of drawn as rows above it.
 *
 *  Upstream counterpart: src/vs/workbench/browser/tauri/viewRootBox.ts
 *--------------------------------------------------------------------------------------------*/

import { IColorTheme } from '../../vs/platform/theme/common/themeService.js';
import { descriptionForeground, foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { inputBackground, inputForeground, inputPlaceholderForeground } from '../../vs/platform/theme/common/colors/inputColors.js';
import { SIDE_BAR_BACKGROUND } from '../../vs/workbench/common/theme.js';
import { FILTER_PLACEHOLDER } from '../../vs/workbench/browser/tauri/viewRoot.js';
import { IViewRoot, IViewRootBox, IViewRootTree, ViewRootController, ViewRootQueued } from '../../vs/workbench/browser/tauri/viewRootController.js';
import { IKey } from '../terminal/input.js';
import { ILine } from '../terminal/screen.js';
import { editValue } from '../../input/editValue.js';
import { recordInputStage } from '../../input/inputTrace.js';
import { inputSpans } from '../workbench/inputBox.js';


/**
 * The header rows a `/` draws: where the pane is rooted, and — while the box is open — the row the
 * query is typed into. **The root goes here rather than into the side bar's title**, which is
 * `ViewPaneContainer.getTitle`'s formula read by the workbench (`§6.1`) and is uppercased by
 * `sidebarpart.css`. A pane with no view root has no root row and answers `undefined` for it.
 */
export function filterHeader(theme: IColorTheme, root: string | undefined, input: string | undefined, placeholder = FILTER_PLACEHOLDER): ILine[] {
	const lines: ILine[] = [];

	if (root) {
		lines.push([{ text: ` ${root}`, fg: theme.getColor(descriptionForeground), bg: theme.getColor(SIDE_BAR_BACKGROUND) }]);
	}

	if (input !== undefined) {
		const bg = theme.getColor(inputBackground);
		lines.push([
			// `.monaco-inputbox` has its own padding; one column of the box's background is it.
			{ text: ' ', actionId: 'view-root-filter', bg },
			...inputSpans(input, placeholder, true, {
				fg: theme.getColor(inputForeground) ?? theme.getColor(foreground),
				placeholderFg: theme.getColor(inputPlaceholderForeground) ?? theme.getColor(foreground),
				bg, actionId: 'view-root-filter'
			})
		]);
	}

	return lines;
}

/**
 * What the filter row does with a key: the value it took, `'commit'` for `Enter`, and nothing for a
 * key that belongs to the rows below it — which is what leaves the arrows to the tree, so a query
 * can be narrowed and the row picked without leaving the box.
 */
export function filterKey(key: IKey, value: string): { value: string } | 'commit' | undefined {
	const edited = editValue(key, value);
	if (edited !== undefined) {
		return { value: edited };
	}

	return key.name === 'enter' ? 'commit' : undefined;
}

/**
 * The `/` box in a terminal: a row of the pane's header, and the string typed into it.
 *
 * It is `ViewRootBox` with the DOM taken out. **The value outlives the box being open**, which is
 * that class's own arrangement and not an accident: `commit` closes the box in front of the queue
 * and the arm behind it still reads what was typed (`viewRootController.ts`).
 */
export class FilterBox implements IViewRootBox {

	private input = '';
	private _isOpen = false;

	constructor(private readonly root: IViewRoot, private readonly repaint: () => void) { }

	get isOpen(): boolean {
		return this._isOpen;
	}

	/** One header row while it is open, and no rows at all while it is not. */
	get height(): number {
		return this._isOpen ? 1 : 0;
	}

	/** What `filterHeader` draws, which is nothing for a pane with no `/` row on screen. */
	get query(): string | undefined {
		return this._isOpen ? this.input : undefined;
	}

	get value(): string {
		return this.input;
	}

	/** Writing it is a completion, so it repaints and does not run as a query. */
	set value(value: string) {
		this.input = value;
		this.repaint();
	}

	open(query: string): void {
		this._isOpen = true;
		this.value = query;
	}

	/**
	 * The box goes, and it always had the keyboard: the `/` row is the only thing taking keys while
	 * it is up, and a terminal has no click that could have moved focus off it — which is the case
	 * `restoreDomFocus` answers the other way in the GUI.
	 */
	close(): boolean {
		this._isOpen = false;
		this.repaint();

		return true;
	}

	/**
	 * A key offered to the box: `ViewRootBox`'s two listeners in one, since a terminal has no
	 * element to hang them off. `filterKey` answers the box's own keys and everything else is left
	 * to the rows below it, which is what leaves the arrows to the tree — so a query can be narrowed
	 * and the row picked without leaving the box.
	 */
	handleKey(key: IKey): boolean {
		if (!this._isOpen) {
			return false;
		}

		const taken = filterKey(key, this.input);
		if (taken === 'commit') {
			this.root.commit();

			return true;
		}

		if (!taken) {
			return false;
		}

		this.value = taken.value;
		this.root.apply(this.input);

		return true;
	}

	dispose(): void { }
}

/** What a pane hands its `/`: the rows it draws, the cursor over them, and its own repaint. */
export interface IPaneViewRoot<T> {

	/** The rows on screen, in the order they are drawn — `Tab`'s candidates. */
	readonly rows: () => readonly T[];

	/** The row the cursor is on, which is what `Enter` commits. */
	readonly focused: () => T | undefined;

	/** `Pane.focusTo`, which clamps — so `-1` is the top row. */
	readonly focusTo: (index: number) => void;

	/** What a box that has changed costs, the box being a row of the pane's header. */
	readonly repaint: () => void;
}

/**
 * The four answers above, off the four members every pane already has: the nodes its tree splices,
 * the cursor's index, `Pane.focusTo` and `Pane.didChangeRows`. A pane's `/` extends what this
 * returns with whatever else its own arms reach.
 */
export function paneViewRoot<T>(
	nodes: () => readonly { readonly element: T }[],
	focus: () => number,
	focusTo: (index: number) => void,
	repaint: () => void
): IPaneViewRoot<T> {
	return {
		rows: () => nodes().map(node => node.element),
		focused: () => nodes()[focus()]?.element,
		focusTo,
		repaint
	};
}

/**
 * What every pane's `/` answers the same way, over `ViewRootController`. What is left for a pane's
 * own subclass is the five arms that differ: what the box opens on, what a query does to its tree,
 * and what `Enter` commits to.
 *
 * **A subclass's `applyQuery` runs whether or not the box is still open**, which is the one thing
 * these three do that the GUI's three do not, and the reason is the wire rather than taste: a
 * terminal delivers several keystrokes in one read, so `/`, `Ctrl+U` and `Enter` all arrive before
 * the queue turns once — and the box closes in front of the queue. Guarding an arm on the box being
 * open *now* would drop the cleared query and commit the root the user had just typed away, which is
 * `Enter` on an empty query leaving the pane rooted where it was. The GUI cannot reach it: an input
 * element raises one change per turn, so nothing is ever queued behind a close there.
 */
export abstract class PaneViewRoot<T, THost extends IPaneViewRoot<T> = IPaneViewRoot<T>> extends ViewRootController<T, FilterBox> {

	constructor(protected readonly pane: THost, queued: ViewRootQueued) {
		super(root => new FilterBox(root, pane.repaint), queued);
	}

	/** What the `/` row holds, which is what the pane draws it from. */
	get input(): string | undefined {
		return this.box.query;
	}

	/** Replaces the open filter's committed text and applies it through the controller's one path. */
	setInput(value: string, diagnosticEventId?: number): boolean {
		if (this.box.query === undefined) {
			return false;
		}

		this.box.value = value;
		recordInputStage(diagnosticEventId, 'view-root.draft.commit', { query: value });
		this.apply(value, diagnosticEventId);
		return true;
	}

	/** A key offered to the `/` row before the rows below it take it. */
	handleKey(key: IKey): boolean {
		return this.box.handleKey(key);
	}

	protected get focused(): T | undefined {
		return this.pane.focused();
	}

	protected override get rows(): T[] {
		return [...this.pane.rows()];
	}

	/**
	 * Nothing. A pane's header is re-read on every paint and the rows below it are given whatever
	 * height is left (`pane.ts`), so a box appearing costs no layout of its own.
	 */
	protected override relayout(): void { }

	/**
	 * The cursor, which in a terminal pane is an index into the rows rather than a tree's own focus.
	 * `reveal` is `Pane.focusTo`'s own scroll, and `domFocus` has nothing to take the keyboard back
	 * from — the pane never gave it away.
	 */
	protected override get tree(): IViewRootTree<T> {
		return {
			setFocus: ([row]) => this.pane.focusTo(row === undefined ? -1 : this.rows.indexOf(row)),
			reveal: () => { },
			domFocus: () => { }
		};
	}
}
