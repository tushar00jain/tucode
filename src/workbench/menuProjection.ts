/*---------------------------------------------------------------------------------------------
 * Immutable menu state and the sole normalized input/async-command controller.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable, IDisposable } from '../vs/base/common/lifecycle.js';
import { InteractionSessionOwner } from '../interactionSession.js';
import { IAction, Separator, SubmenuAction } from '../vs/base/common/actions.js';
import { mnemonicMenuLabel } from '../vs/base/common/labels.js';
import { isICommandActionToggleInfo } from '../vs/platform/action/common/action.js';
import { MenuItemAction, SubmenuItemAction } from '../vs/platform/actions/common/actions.js';

export type MenuProjectionKind = 'command' | 'selector' | 'submenu' | 'separator';
export type MenuProjectionRole = 'services' | 'windows' | 'help';

export interface IMenuProjectionKey {
	readonly characters: string;
	readonly modifiers: number;
	readonly label?: string;
}

export interface IMenuProjectionInput {
	readonly id: string;
	readonly kind: MenuProjectionKind;
	readonly label?: string;
	readonly mnemonic?: string;
	readonly tooltip?: string;
	readonly key?: IMenuProjectionKey;
	readonly enabled?: boolean;
	readonly checked?: boolean;
	readonly visible?: boolean;
	readonly role?: MenuProjectionRole;
	readonly selector?: string;
	readonly target?: 'application' | 'responder';
	readonly items?: readonly IMenuProjectionInput[];
	readonly activate?: () => void | Promise<void>;
}
export const MENU_PROJECTION_SEPARATOR: IMenuProjectionInput = Object.freeze({ id: 'separator', kind: 'separator', enabled: false });

export interface IMenuProjectionItem {
	readonly id: string;
	readonly actionId: string;
	readonly parentId: string | undefined;
	readonly order: number;
	readonly depth: number;
	readonly kind: MenuProjectionKind;
	readonly label: string;
	readonly mnemonic?: string;
	readonly tooltip?: string;
	readonly key?: Readonly<IMenuProjectionKey>;
	readonly enabled: boolean;
	readonly checked: boolean;
	readonly visible: boolean;
	readonly role?: MenuProjectionRole;
	readonly selector?: string;
	readonly target?: 'application' | 'responder';
	readonly children: readonly string[];
}

export interface MenuProjectionSnapshot {
	readonly id: string;
	readonly generation: number;
	readonly terminal: 'closed' | 'open' | 'completed' | 'cancelled' | 'failed' | 'disposed';
	readonly roots: readonly string[];
	readonly order: readonly string[];
	readonly items: ReadonlyMap<string, Readonly<IMenuProjectionItem>>;
	readonly context: Readonly<{ targetId?: string; focusedId?: string; focused: boolean }>;
	readonly command: Readonly<{ generation: number; state: 'idle' | 'pending' | 'completed' | 'cancelled' | 'failed' }>;
}

export type MenuProjectionEvent =
	| { readonly generation: number; readonly type: 'open'; readonly targetId?: string; readonly focusedId?: string }
	| { readonly generation: number; readonly type: 'highlight'; readonly id?: string }
	| { readonly generation: number; readonly type: 'activate'; readonly id: string }
	| { readonly generation: number; readonly type: 'close'; readonly cancelled: boolean };

export interface IMenuProjectionSource extends IDisposable {
	readonly snapshot: MenuProjectionSnapshot;
	readonly onDidSnapshot: Event<MenuProjectionSnapshot>;
	dispatch(event: MenuProjectionEvent): boolean;
	rebuild(): MenuProjectionSnapshot;
}

export interface IContextMenuProjectionSource extends IMenuProjectionSource {
	readonly ownsContextLifecycle: boolean;
	attachContextLifecycle(value: IMenuProjectionContextLifecycle): void;
	closeAfterTracking(cancelled: boolean, scheduler?: IMenuProjectionScheduler): void;
	fail(): void;
}

export interface IMenuProjectionScheduler {
	schedule(callback: () => void): IDisposable;
}

export interface IMenuProjectionContextLifecycle {
	readonly disposeMenu: () => void;
	readonly disposeActions: () => void;
	readonly onHide: (cancelled: boolean) => void;
	readonly didHide: () => void;
	readonly restoreFocus: () => void;
}

export interface IMenuProjectionActionOptions {
	readonly key: (action: IAction) => IMenuProjectionKey | undefined;
	readonly run: (action: IAction) => void | Promise<void>;
}

/** The action/menu resolution walk used by terminal menus. */
export function menuProjectionInputsOf(actions: readonly IAction[], options: IMenuProjectionActionOptions): readonly IMenuProjectionInput[] {
	return actions.flatMap((action, order): readonly IMenuProjectionInput[] => {
		if (action instanceof Separator) { return [{ id: `separator-${order}`, kind: 'separator', enabled: false }]; }
		let mnemonic = (action instanceof SubmenuItemAction || action instanceof MenuItemAction) && typeof action.item.title !== 'string'
			? action.item.title.mnemonicTitle ?? action.item.title.value : action.label;
		if (action instanceof SubmenuAction) {
			const items = menuProjectionInputsOf(action.actions, options);
			return items.length ? [{ id: action.id, kind: 'submenu', label: mnemonicMenuLabel(mnemonic), mnemonic, items }] : [];
		}
		if (action instanceof MenuItemAction && isICommandActionToggleInfo(action.item.toggled)) {
			mnemonic = action.item.toggled.mnemonicTitle ?? action.item.toggled.title ?? mnemonic;
		}
		return [{
			id: action.id, kind: 'command', label: mnemonicMenuLabel(mnemonic), mnemonic,
			tooltip: action.tooltip, enabled: action.enabled, checked: !!action.checked, visible: true,
			key: options.key(action), activate: () => options.run(action)
		}];
	});
}

const immediateScheduler: IMenuProjectionScheduler = {
	schedule: callback => {
		const handle = setImmediate(callback);
		handle.unref();
		return { dispose: () => clearImmediate(handle) };
	}
};

let nextMenuGeneration = 0;

function equalValues<T>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalProjectionItem(left: Readonly<IMenuProjectionItem>, right: Readonly<IMenuProjectionItem>): boolean {
	return left.id === right.id && left.actionId === right.actionId && left.parentId === right.parentId &&
		left.order === right.order && left.depth === right.depth && left.kind === right.kind && left.label === right.label &&
		left.mnemonic === right.mnemonic && left.tooltip === right.tooltip && left.enabled === right.enabled &&
		left.checked === right.checked && left.visible === right.visible && left.role === right.role &&
		left.selector === right.selector && left.target === right.target && equalValues(left.children, right.children) &&
		(left.key === right.key || (!!left.key && !!right.key && left.key.characters === right.key.characters &&
			left.key.modifiers === right.key.modifiers && left.key.label === right.key.label));
}

/** Generation is a committed-change sequence, not a count of rebuild requests. */
function equalProjectionState(left: MenuProjectionSnapshot, right: MenuProjectionSnapshot): boolean {
	if (left.id !== right.id || left.terminal !== right.terminal || !equalValues(left.roots, right.roots) ||
		!equalValues(left.order, right.order) || left.items.size !== right.items.size ||
		left.context.targetId !== right.context.targetId || left.context.focusedId !== right.context.focusedId ||
		left.context.focused !== right.context.focused || left.command.generation !== right.command.generation ||
		left.command.state !== right.command.state) {
		return false;
	}
	for (const [id, item] of left.items) {
		const candidate = right.items.get(id);
		if (!candidate || !equalProjectionItem(item, candidate)) { return false; }
	}
	return true;
}

/** Owns resolution, rebuild generations, normalized input and asynchronous command settlement. */
export class MenuProjectionController extends Disposable {
	private readonly commands = this._register(new InteractionSessionOwner<{
		readonly run: () => void | Promise<void>;
	}>('MenuProjection.command'));
	private readonly snapshots = this._register(new Emitter<MenuProjectionSnapshot>());
	readonly onDidSnapshot: Event<MenuProjectionSnapshot> = this.snapshots.event;
	private activations = new Map<string, () => void | Promise<void>>();
	private terminal: MenuProjectionSnapshot['terminal'] = 'closed';
	private commandGeneration = 0;
	private commandState: MenuProjectionSnapshot['command']['state'] = 'idle';
	private context: MenuProjectionSnapshot['context'] = Object.freeze({ focused: false });
	private current: MenuProjectionSnapshot;
	private contextLifecycle: IMenuProjectionContextLifecycle | undefined;
	private contextClose: IDisposable | undefined;

	constructor(readonly id: string, private readonly source: () => readonly IMenuProjectionInput[],
		private readonly scheduler: IMenuProjectionScheduler = immediateScheduler,
		private readonly reportFailure: (error: unknown) => void = error => queueMicrotask(() => { throw error; })) {
		super();
		this.current = this.capture(++nextMenuGeneration);
	}

	get snapshot(): MenuProjectionSnapshot { return this.current; }
	get ownsContextLifecycle(): boolean { return !!this.contextLifecycle; }

	attachContextLifecycle(value: IMenuProjectionContextLifecycle): void {
		this.finishContext(true);
		this.contextLifecycle = value;
	}

	closeAfterTracking(cancelled: boolean, scheduler: IMenuProjectionScheduler = immediateScheduler): void {
		this.contextClose?.dispose();
		this.contextClose = scheduler.schedule(() => {
			this.contextClose = undefined;
			const snapshot = this.snapshot;
			this.dispatch({ generation: snapshot.generation, type: 'close', cancelled });
			this.finishContext(cancelled);
		});
	}

	rebuild(): MenuProjectionSnapshot {
		// Every request must re-resolve actions so a submenu opened directly is current, but only a
		// changed immutable state owns a generation. capture() also replaces the
		// activation closures, so an unchanged presentation never retains a stale command callback.
		this.publish();
		return this.current;
	}

	fail(): void {
		if (this.terminal === 'disposed') { return; }
		this.terminal = 'failed';
		if (this.commands.current) { this.commands.end(this.commands.current, 'failed'); }
		this.commandState = 'failed';
		this.context = Object.freeze({ ...this.context, focused: false });
		this.publish();
		this.finishContext(true);
	}

	dispatch(event: MenuProjectionEvent): boolean {
		if (event.generation !== this.current.generation || this.terminal === 'disposed') { return false; }
		switch (event.type) {
			case 'open':
				this.terminal = 'open';
				this.context = Object.freeze({ targetId: event.targetId, focusedId: event.focusedId, focused: true });
				this.publish();
				return true;
			case 'highlight':
				if (event.id !== undefined && !this.current.items.has(event.id)) { return false; }
				this.context = Object.freeze({ ...this.context, focusedId: event.id });
				this.publish();
				return true;
			case 'close':
				this.terminal = event.cancelled ? 'cancelled' : 'completed';
				this.context = Object.freeze({ ...this.context, focused: false });
				this.publish();
				return true;
			case 'activate':
				return this.activate(event.id);
		}
	}

	override dispose(): void {
		this.contextClose?.dispose(); this.contextClose = undefined;
		this.finishContext(true);
		if (this.terminal !== 'disposed') {
			this.terminal = 'disposed';
			this.commandState = this.commands.current ? 'cancelled' : this.commandState;
			this.context = Object.freeze({ ...this.context, focused: false });
			this.publish();
		}
		this.activations.clear();
		super.dispose();
	}

	private finishContext(cancelled: boolean): void {
		const lifecycle = this.contextLifecycle;
		if (!lifecycle) { return; }
		this.contextLifecycle = undefined;
		lifecycle.disposeMenu(); lifecycle.onHide(cancelled); lifecycle.didHide(); lifecycle.disposeActions(); lifecycle.restoreFocus();
	}

	private activate(id: string): boolean {
		const item = this.current.items.get(id);
		const run = this.activations.get(id);
		if (!item || item.kind !== 'command' || !item.visible || !item.enabled || !run) { return false; }
		const session = this.commands.begin({ run });
		const commandGeneration = ++this.commandGeneration;
		this.commandState = 'pending';
		this.publish();
		session.add(this.scheduler.schedule(async () => {
			if (!this.commands.isCurrent(session)) { return; }
			try {
				await session.value.run();
				if (this.commands.end(session, 'completed')) { this.commandState = 'completed'; this.publish(); }
			} catch (error) {
				if (this.commands.end(session, 'failed')) {
					this.commandState = 'failed'; this.terminal = 'failed'; this.publish(); this.reportFailure(error);
				}
			}
		}));
		void commandGeneration;
		return true;
	}

	private publish(): void {
		const candidate = this.capture(this.current.generation);
		if (equalProjectionState(this.current, candidate)) { return; }
		this.commit(Object.freeze({ ...candidate, generation: ++nextMenuGeneration }));
	}

	private commit(snapshot: MenuProjectionSnapshot): void {
		this.current = snapshot;
		this.snapshots.fire(this.current);
	}

	private capture(generation: number): MenuProjectionSnapshot {
		const activations = new Map<string, () => void | Promise<void>>();
		const records: IMenuProjectionItem[] = [];
		const walk = (inputs: readonly IMenuProjectionInput[], parentId: string | undefined, depth: number): readonly string[] => {
			const counts = new Map<string, number>();
			return inputs.map((input, order) => {
				const count = counts.get(input.id) ?? 0; counts.set(input.id, count + 1);
				const id = `${parentId ?? this.id}/${input.kind}:${input.id}#${count}`;
				const children = walk(input.items ?? [], id, depth + 1);
				const record = Object.freeze({
					id, actionId: input.id, parentId, order, depth, kind: input.kind,
					label: input.label ?? '', mnemonic: input.mnemonic, tooltip: input.tooltip,
					key: input.key ? Object.freeze({ ...input.key }) : undefined,
					enabled: input.enabled ?? input.kind !== 'separator', checked: !!input.checked,
					visible: input.visible !== false, role: input.role, selector: input.selector,
					target: input.target, children: Object.freeze([...children])
				}) satisfies IMenuProjectionItem;
				records.push(record);
				if (input.activate) { activations.set(id, input.activate); }
				return id;
			});
		};
		const roots = walk(this.source(), undefined, 0);
		this.activations = activations;
		const items = new Map(records.map(record => [record.id, record]));
		return Object.freeze({
			id: this.id, generation, terminal: this.terminal,
			roots: Object.freeze([...roots]), order: Object.freeze(records.map(record => record.id)), items,
			context: this.context,
			command: Object.freeze({ generation: this.commandGeneration, state: this.commandState })
		});
	}
}

/** Replaces whole menu controllers without putting generation ownership in a frontend adapter. */
export class MenuProjectionSourceOwner extends Disposable {
	private current: IContextMenuProjectionSource | undefined;
	begin(controller: IContextMenuProjectionSource): IContextMenuProjectionSource {
		this.current?.dispose(); this.current = controller; return controller;
	}
	override dispose(): void { this.current?.dispose(); this.current = undefined; super.dispose(); }
}
