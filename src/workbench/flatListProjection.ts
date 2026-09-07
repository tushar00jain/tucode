/*---------------------------------------------------------------------------------------------
 * Immutable flat-list state at a frontend boundary.
 *
 * The shared controller owns behavior and live rows. Frontends receive frozen semantic records
 * with stable presentation/action identities and return generation-tagged identity input only.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';

export interface IFlatListProjectionRow<TRender> {
	readonly id: string;
	readonly actionId: string;
	readonly order: number;
	readonly accessibleLabel: string;
	readonly render: TRender;
	readonly selected: boolean;
	readonly focused: boolean;
}

export function flatListProjectionIdentity(scope: string, semanticId: string): { readonly id: string; readonly actionId: string } {
	if (!scope || !semanticId) { throw new Error('flat-list identity requires a scope and semantic id'); }
	return Object.freeze({ id: `${scope}-row:${semanticId}`, actionId: `${scope}-action:${semanticId}` });
}

export interface IFlatListProjectionSnapshot<TRender> {
	readonly generation: number;
	readonly rows: ReadonlyMap<string, Readonly<IFlatListProjectionRow<TRender>>>;
	readonly order: readonly string[];
	readonly inputActions: ReadonlyMap<string, string>;
}

export type FlatListInputEvent =
	| { readonly generation: number; readonly kind: 'focus'; readonly id: string | undefined }
	| { readonly generation: number; readonly kind: 'select'; readonly ids: readonly string[] }
	| { readonly generation: number; readonly kind: 'open'; readonly id: string };

export type FlatListControllerEvent =
	| { readonly generation: number; readonly kind: 'focus'; readonly actionId: string | undefined }
	| { readonly generation: number; readonly kind: 'select'; readonly actionIds: readonly string[] }
	| { readonly generation: number; readonly kind: 'open'; readonly actionId: string };

export interface IFlatListProjectionSource<TRender> {
	readonly snapshot: IFlatListProjectionSnapshot<TRender>;
	readonly onDidSnapshot: Event<IFlatListProjectionSnapshot<TRender>>;
	readonly onDidInput: Event<FlatListControllerEvent>;
	dispatch(event: FlatListInputEvent): boolean;
}

export function flatListSnapshot<TRender>(generation: number, records: readonly IFlatListProjectionRow<TRender>[],
	controllerActions?: ReadonlySet<string>): IFlatListProjectionSnapshot<TRender> {
	if (!Number.isSafeInteger(generation) || generation < 1) {
		throw new Error('flat-list projection generation must be a positive safe integer');
	}
	const rows = new Map<string, Readonly<IFlatListProjectionRow<TRender>>>();
	const inputActions = new Map<string, string>();
	for (const record of records) {
		if (record.id === record.actionId) { throw new Error(`flat-list presentation identity conflates controller action ${record.id}`); }
		if (controllerActions && !controllerActions.has(record.actionId)) { throw new Error(`orphan flat-list action identity ${record.actionId}`); }
		if (rows.has(record.id)) { throw new Error(`duplicate flat-list projection identity ${record.id}`); }
		if (inputActions.has(record.id)) { throw new Error(`duplicate flat-list input identity ${record.id}`); }
		rows.set(record.id, Object.freeze({ ...record }));
		inputActions.set(record.id, record.actionId);
	}
	const order = Object.freeze([...records].sort((a, b) => a.order - b.order).map(record => record.id));
	return Object.freeze({ generation, rows, order, inputActions });
}

export class FlatListProjectionGateway<TRender> extends Disposable implements IFlatListProjectionSource<TRender> {
	private current: IFlatListProjectionSnapshot<TRender>;
	private readonly _onDidSnapshot = this._register(new Emitter<IFlatListProjectionSnapshot<TRender>>());
	readonly onDidSnapshot = this._onDidSnapshot.event;
	private readonly _onDidInput = this._register(new Emitter<FlatListControllerEvent>());
	readonly onDidInput = this._onDidInput.event;

	constructor(initial: IFlatListProjectionSnapshot<TRender>, private readonly handle: (event: FlatListControllerEvent) => void) {
		super();
		this.current = initial;
	}

	get snapshot(): IFlatListProjectionSnapshot<TRender> { return this.current; }

	publish(snapshot: IFlatListProjectionSnapshot<TRender>): boolean {
		if (snapshot.generation <= this.current.generation) { return false; }
		this.current = snapshot;
		this._onDidSnapshot.fire(snapshot);
		return true;
	}

	dispatch(event: FlatListInputEvent): boolean {
		if (event.generation !== this.current.generation) { return false; }
		const ids = event.kind === 'select' ? event.ids : event.id === undefined ? [] : [event.id];
		const actionIds = ids.map(id => this.current.inputActions.get(id));
		if (actionIds.some(id => id === undefined)) { return false; }
		const normalized: FlatListControllerEvent = event.kind === 'select'
			? { generation: event.generation, kind: 'select', actionIds: actionIds as string[] }
			: event.kind === 'focus'
				? { generation: event.generation, kind: 'focus', actionId: actionIds[0] }
				: { generation: event.generation, kind: 'open', actionId: actionIds[0]! };
		this._onDidInput.fire(normalized);
		this.handle(normalized);
		return true;
	}
}
