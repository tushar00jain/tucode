/*---------------------------------------------------------------------------------------------
 *  What every pane's `/` does the same way, as one base: the box it opens, the queue every arm runs
 *  through, and what `Tab` cycles. The grammar is `viewRoot.ts`'s and the box is `viewRootBox.ts`'s;
 *  what is here is the third thing all three panes turned out to share — the *driving* of them.
 *
 *  The panes differ in what a query descends over, what a rebuild is (`resort`, `updateChildren`, a
 *  re-input) and what `Enter` commits to; they do not differ in any of this:
 *
 *  - **every arm that touches the tree is queued**, because a key can arrive while the last one's
 *    directory read or refetch is still in flight, and the rows `Tab` cycles have to be the rows the
 *    query that preceded it left behind — but **closing the box is not**, since nothing in the queue
 *    reads or writes it and a way out has to exist whatever the queue is doing (see `closing`);
 *  - **`Tab` does not re-apply the query**, so the candidates stay the rows the *typed* query
 *    ranked — re-running the box's own text after a completion would narrow the list to the one row
 *    it names;
 *  - **a typed query ends whatever cycle `Tab` had started**, which is the `completed` reset;
 *  - **the cursor moves with `setFocus` rather than with focus**, which is what lets a query be
 *    narrowed and its row picked without leaving the box.
 *
 *  **The driving is all that is here, and it is one copy of it**: no DOM, no widget and no
 *  service is named, and the box is an interface (`IViewRootBox`) rather than the GUI's
 *  `ViewRootBox`. Whoever constructs the controller supplies the box — here that is
 *  `viewRootBox.ts`'s input box — and `TBox` is what lets a box keep its own extra members (this
 *  one's `mount`) without a cast.
 *
 *  **The order the arms run in belongs to the host, not to `/`** — `ViewRootQueued` is how it is
 *  supplied, and a host that has no opinion is given `ownQueue`, which is a queue of `/`'s own.
 *  Both of the reasons a host would have one are about arms this file cannot see: a host whose
 *  other arms read or rebuild the same tree has to serialise them against these, and a queue
 *  private to `/` would split one order into two; and a host that keeps a set of outstanding work
 *  can only include `/` in it if it is the thing being handed each arm.
 *
 *  Upstream counterpart: none. Its antecedent is upstream's own `AbstractFindController`
 *  (`abstractTree.ts:989`) in shape only — a widget, a pattern and the tree it re-applies to — and
 *  nothing of its body is taken, because the tree find it drives filters a whole tree rather than
 *  one level of one and has no root to move.
 *--------------------------------------------------------------------------------------------*/

import { Queue } from '../../../base/common/async.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { completeQuery } from './viewRoot.js';

/**
 * What a pane supplies to have a `/`. Everything here is per-pane: what the box opens on, what a
 * query does to the tree, and what `Enter` commits to.
 */
export interface IViewRoot {

	/** `/`: prefill the box with the pane's own root and open it. */
	open(): void;

	/** The box's text changed — apply it as a query. */
	apply(query: string): void;

	/** `Tab` (`1`) and `Shift+Tab` (`-1`): the next ranked row, written into the last segment. */
	complete(delta: number): void;

	/** `Enter`: take the row the ranking put the cursor on. */
	commit(): void;

	/** `Escape`, and the box losing the keyboard: the box goes and the root it opened on comes back. */
	cancel(): void;
}

/**
 * The half of a box the driving reaches: what it holds, what it costs the rows below it, and the
 * fact that it can be open. A frontend's own box is more than this, and every extra member of it
 * stays there — `TBox` below is how a caller keeps them.
 */
export interface IViewRootBox extends IDisposable {

	readonly isOpen: boolean;

	/** What the box costs the rows below it, which is nothing at all while it is closed. */
	readonly height: number;

	/** What the box reads. Writing it is a completion, so it does not run as a query. */
	value: string;

	open(query: string): void;

	/** Answers whether the box still had the keyboard, which is what tells an `Escape` from a blur. */
	close(): boolean;
}

/**
 * The half of a tree the cursor is moved through, structurally — so this file imports no tree type
 * and each pane keeps its own. `setFocus`/`reveal` are `AsyncDataTree`'s own, at their own names.
 */
export interface IViewRootTree<T> {
	setFocus(elements: T[]): void;
	reveal(element: T): void;
	domFocus(): void;
}

/**
 * How one arm of `/` is run: behind whatever the host already has in flight, and with its failure
 * reported rather than lost. A host that has other arms over the same tree, or a set of outstanding
 * work it answers questions about, passes its own; `ownQueue` is what it gets by not passing one.
 */
export type ViewRootQueued = (work: () => Promise<void>) => void;

/** One rebuild at a time, in the order the keys arrived — the serialisation `/` has on its own. */
function ownQueue(): ViewRootQueued {
	const queue = new Queue<void>();

	return work => queue.queue(work).catch(onUnexpectedError);
}

/** What a pane's `/` supplies, over and above the five `IViewRoot` arms the box drives it through. */
export abstract class ViewRootController<T, TBox extends IViewRootBox = IViewRootBox> extends Disposable implements IViewRoot {

	protected readonly box: TBox;

	/** One arm of `/`, run however the host runs one. */
	protected readonly queued: ViewRootQueued;

	/** The row the last `Tab` completed to, and `-1` while the box reads what was typed. */
	private completed = -1;

	/** Whether the box had the keyboard when it closed, which is what `restoreDomFocus` is about. */
	private hadKeyboard = false;

	/**
	 * `createBox` is called with the controller rather than handed a finished box, because the box
	 * drives the five `IViewRoot` arms and so needs the very object being constructed.
	 */
	constructor(createBox: (root: IViewRoot) => TBox, queued: ViewRootQueued = ownQueue()) {
		super();

		this.queued = queued;
		this.box = this._register(createBox(this));
	}

	/** What the pane's layout takes off the rows below, which is nothing while the box is closed. */
	get height(): number {
		return this.box.height;
	}

	//#region --- `IViewRoot`, which is what the box and the keymap drive this through

	/**
	 * `/`: the box opens on the pane's own root, prefilled with the query that names it — **so `/`
	 * never moves the pane**, and the rows on screen are the rows it opens on. The pane is not laid
	 * out again by a box appearing, so the rows below are told their own size before the query the
	 * box already holds is applied to them.
	 */
	open(): void {
		if (this.box.isOpen) {
			return;
		}

		this.box.open(this.opening());
		this.relayout();

		this.apply(this.box.value);
	}

	apply(query: string): void {
		this.queued(async () => {
			// A query is what the user typed, so applying one ends whatever cycle `Tab` had started.
			this.completed = -1;

			await this.applyQuery(query);
		});
	}

	/**
	 * `Tab`: the next ranked row round, written into the last segment and taken by the cursor — so
	 * the box reads what the cursor is on and `Enter` commits a row that is on screen.
	 */
	complete(delta: number): void {
		this.queued(async () => {
			const rows = this.rows;
			const completion = completeQuery(this.box.value, rows, row => this.name(row), this.completed, delta);
			if (!completion) {
				return;
			}

			this.box.value = completion.query;
			this.completed = completion.index;
			this.focusTo(rows[completion.index]);
		});
	}

	/** `Enter`: take the row the ranking put the cursor on. */
	commit(): void {
		this.closing(() => this.commitRoot());
	}

	/** `Escape`, or the box losing the keyboard: the root it opened on comes back. */
	cancel(): void {
		this.closing(() => this.cancelRoot());
	}

	//#endregion

	/**
	 * **The box closes in front of the queue and the tree catches up behind it.** `ViewRootBox.close`
	 * touches nothing an arm touches — it hides the element, drops `FilteringContext` and clears the
	 * one open box — and every arm already reads `box.isOpen` as its guard, so closing *earlier* only
	 * makes a queued `apply` the no-op it was going to become anyway. What has to be serialised
	 * against `apply` is the tree restore underneath the close, and that is what stays queued.
	 *
	 * Behind the queue, one arm that never settled made `Escape` a no-op with the box still up: no key
	 * could reach it, and `FilteringContext` stayed set over the whole window.
	 */
	private closing(restore: () => Promise<void>): void {
		if (!this.box.isOpen) {
			return;
		}

		this.hadKeyboard = this.box.close();
		this.queued(restore);
	}

	/** `Enter`'s answer, taken with the box already shut. */
	protected abstract commitRoot(): Promise<void>;

	/** `Escape`'s: the root the box opened on, put back. */
	protected abstract cancelRoot(): Promise<void>;

	/**
	 * What the box is about to open on: the query that names the pane's own root, and whatever this
	 * pane has to put aside to be able to give it back on `Escape`.
	 *
	 * **A filtered tree is never compressed**, and that is not a taste: a compressed chain takes its
	 * `filterData` from the last element while only the first is a row at the view root, so the tint
	 * would be computed against one name and drawn against another. The pane that has compression
	 * turns it off here and back on when the box closes.
	 */
	protected abstract opening(): string;

	/**
	 * The rows below the box, told their own size. It is the same subtraction the pane's own
	 * `layoutBody` makes for every layout after this one — this is only the first of them.
	 */
	protected abstract relayout(): void;

	/**
	 * The query as it stands, applied — the path resolved to a root, the last segment ranked over
	 * that root's rows, and the tree rebuilt however this pane rebuilds. It is called with the box
	 * shut when a rebuild was queued behind a close, so every arm of it starts by checking.
	 */
	protected abstract applyQuery(query: string): Promise<void>;

	/** The rows on screen, in the order they are drawn — `Tab`'s candidates. */
	protected abstract get rows(): T[];

	/** What `Tab` would write for a row, and nothing for a row the query has no name for. */
	protected abstract name(row: T): string | undefined;

	/**
	 * The tree the cursor lives in, which is the only part of one this file needs — **and it can
	 * answer with nothing.** Every pane supplies it as a thunk into its own view pane, because the
	 * pane builds its tree *after* the controller it hands to the tree's own construction; the same
	 * thunk answers `undefined` again once the pane is torn down. An arm reaching a tree that is
	 * not there is a queued arm arriving late, which is not a failure to report — it is the state
	 * the queue exists to survive.
	 */
	protected abstract get tree(): IViewRootTree<T> | undefined;

	/**
	 * Where the cursor is while the box has the keyboard. `setFocus` moves the tree's own cursor
	 * without taking DOM focus off the box.
	 */
	protected focusTo(row: T | undefined): void {
		const tree = this.tree;
		if (!tree) {
			return;
		}

		tree.setFocus(row ? [row] : []);
		if (row) {
			tree.reveal(row);
		}
	}

	/**
	 * The keyboard, back on the rows the box sat above — **unless the box did not have it when it
	 * closed**, which is what a blur is: focus is already wherever the user has just clicked, and
	 * taking it back would undo that click.
	 *
	 * And **nothing to give it back to is the same answer as not having had it**: a pane whose tree
	 * has gone has no rows for the keyboard to land on, and the throw this used to be —
	 * `Cannot read properties of undefined (reading 'domFocus')` out of source control — was that
	 * case reported as a failure of the restore rather than as the absence of anything to restore.
	 */
	protected restoreDomFocus(): void {
		if (this.hadKeyboard) {
			this.tree?.domFocus();
		}
	}
}
