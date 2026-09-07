/*---------------------------------------------------------------------------------------------
 * Immutable pane-chrome state at a frontend boundary.
 *
 * Shared panes publish already interpreted header records and accept generation-tagged semantic
 * input. Frontends may lay those records out and decode their own text-input protocol, but never
 * retain a second filter value or call a pane callback directly.
 *--------------------------------------------------------------------------------------------*/

import type { ISegmentedDomRenderRecords } from '../render/domRecords.js';
import { editTextField, isTextEditingCommand } from '../input/editValue.js';
import type { IWorkbenchKeyTarget } from '../input/workbenchKeyDispatch.js';
import type { INormalizedKey as IKey } from '../input/key.js';
import { Emitter, Event } from '../vs/base/common/event.js';
import { combinedDisposable, Disposable, IDisposable, toDisposable } from '../vs/base/common/lifecycle.js';
import type { IContextKey } from '../vs/platform/contextkey/common/contextkey.js';

export interface IPaneChromeSnapshot {
	readonly generation: number;
	readonly identity: string;
	readonly title: string;
	readonly header: readonly ISegmentedDomRenderRecords[];
	readonly textInputValue: string | undefined;
	readonly canEdit: boolean;
	readonly editing: boolean;
	readonly filtering: boolean;
	readonly expanded: boolean;
	readonly focused: boolean;
}

export type PaneChromeInputEvent =
	| { readonly generation: number; readonly kind: 'set-text'; readonly value: string; readonly diagnosticEventId?: number }
	| { readonly generation: number; readonly kind: 'set-expanded'; readonly expanded: boolean }
	| { readonly generation: number; readonly kind: 'set-editing'; readonly editing: boolean }
	| { readonly generation: number; readonly kind: 'complete-filter'; readonly delta: number }
	| { readonly generation: number; readonly kind: 'scroll-horizontal'; readonly direction: number }
	| { readonly generation: number; readonly kind: 'focus'; readonly focused: boolean }
	| { readonly generation: number; readonly kind: 'activate-segment'; readonly actionId: string };

export interface IPaneChromeProjectionSource {
	readonly snapshot: IPaneChromeSnapshot;
	readonly onDidSnapshot: Event<IPaneChromeSnapshot>;
	dispatch(event: PaneChromeInputEvent): boolean;
}

/** Projects a pane-owned upstream focus key from its semantic focus snapshot. */
export function bindPaneFocusContext(source: IPaneChromeProjectionSource, context: IContextKey<boolean>): IDisposable {
	context.set(source.snapshot.focused);
	return combinedDisposable(
		source.onDidSnapshot(snapshot => context.set(snapshot.focused)),
		toDisposable(() => context.set(false))
	);
}

/** Projects whether the pane body is actually exposed; detached panes cannot own focus separately. */
export function bindPaneVisibilityContext(source: IPaneChromeProjectionSource, context: IContextKey<boolean>): IDisposable {
	context.set(source.snapshot.expanded);
	return combinedDisposable(
		source.onDidSnapshot(snapshot => context.set(snapshot.expanded)),
		toDisposable(() => context.set(false))
	);
}

/** Shared scalar-header command adapter; committed text remains owned by each platform text client. */
export class PaneChromeWorkbenchKeyTarget implements IWorkbenchKeyTarget {
	constructor(private readonly source: IPaneChromeProjectionSource) { }
	handleKey(key: IKey): boolean {
		const value = this.source.snapshot.textInputValue;
		if (value === undefined || !isTextEditingCommand(key)) { return false; }
		const edited = editTextField(key, { value, selection: [value.length, value.length] });
		return !!edited && this.source.dispatch({ generation: this.source.snapshot.generation,
			kind: 'set-text', value: edited.value });
	}
}

export function paneChromeSnapshot(value: IPaneChromeSnapshot): IPaneChromeSnapshot {
	return Object.freeze({ ...value, header: Object.freeze(value.header.map(line => Object.freeze({
		root: Object.freeze({ ...line.root }),
		runs: Object.freeze(line.runs.map(run => Object.freeze({ text: run.text, style: Object.freeze({ ...run.style }) }))),
		accessibleLabel: line.accessibleLabel,
		segments: Object.freeze(line.segments.map(segment => Object.freeze({ ...segment })))
	}))) });
}

export class PaneChromeProjectionGateway extends Disposable implements IPaneChromeProjectionSource {
	private current: IPaneChromeSnapshot;
	private readonly _onDidSnapshot = this._register(new Emitter<IPaneChromeSnapshot>());
	readonly onDidSnapshot = this._onDidSnapshot.event;

	constructor(initial: IPaneChromeSnapshot, private readonly handle: (event: PaneChromeInputEvent) => boolean) {
		super();
		this.current = paneChromeSnapshot(initial);
	}

	get snapshot(): IPaneChromeSnapshot { return this.current; }

	publish(next: Omit<IPaneChromeSnapshot, 'generation' | 'focused'>): void {
		this.current = paneChromeSnapshot({ ...next, focused: this.current.focused, generation: this.current.generation + 1 });
		this._onDidSnapshot.fire(this.current);
	}

	dispatch(event: PaneChromeInputEvent): boolean {
		if (event.generation !== this.current.generation) { return false; }
		if (event.kind === 'focus') {
			if (event.focused === this.current.focused) { return true; }
			this.current = paneChromeSnapshot({ ...this.current, focused: event.focused, generation: this.current.generation + 1 });
			this._onDidSnapshot.fire(this.current);
			return true;
		}
		return this.handle(event);
	}
}
