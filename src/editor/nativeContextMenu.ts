import type { IContextMenuDelegate, IContextMenuEvent } from '../vs/base/browser/contextmenu.js';
import { ActionRunner, IAction, Separator, SubmenuAction } from '../vs/base/common/actions.js';
import { isCancellationError } from '../vs/base/common/errors.js';
import { stripIcons } from '../vs/base/common/iconLabels.js';
import type { IMenuProjectionKey } from '../workbench/menuProjection.js';

export interface NativeMenuItem {
	id?: number;
	label?: string;
	enabled?: boolean;
	checked?: boolean;
	radio?: boolean;
	keyLabel?: string;
	key?: string;
	modifiers?: number;
	separator?: boolean;
	children?: NativeMenuItem[];
	lazy?: boolean;
	iconResource?: string;
}

/** A native submenu asks for its actions only when AppKit opens it. */
export class NativeSubmenuAction extends SubmenuAction {
	constructor(id: string, label: string, readonly loadActions: () => Promise<readonly IAction[]>, readonly iconResource?: string) {
		super(id, label, []);
	}
}

/** Retains action identity in JavaScript; the native menu only returns opaque item ids. */
export class NativeContextMenuSession {
	readonly items: NativeMenuItem[];
	private readonly actions = new Map<number, IAction>();
	private closed = false;
	private readonly pending = new Map<number, Promise<NativeMenuItem[] | undefined>>();
	private readonly serialize: (actions: readonly IAction[], ancestors: Set<IAction>) => NativeMenuItem[];

	constructor(
		private readonly delegate: IContextMenuDelegate,
		keybinding: (action: IAction) => IMenuProjectionKey | undefined,
		private readonly hide: (cancelled: boolean) => void,
		private readonly reportError: (error: Error) => void,
		private readonly logAction: (action: IAction) => void,
	) {
		const visit = this.serialize = (actions: readonly IAction[], ancestors: Set<IAction>): NativeMenuItem[] => actions.map(action => {
			if (action.id === Separator.ID) { return { separator: true }; }
			const key = keybinding(action);
			const item: NativeMenuItem = {
				label: stripIcons(action.label).replace(/\(&&\w\)|&&/g, ''),
				enabled: action.enabled, checked: action.checked,
				keyLabel: key?.label, key: key?.characters, modifiers: key?.modifiers,
				radio: delegate.getCheckedActionsRepresentation?.(action) === 'radio',
				iconResource: (action as IAction & { iconResource?: string }).iconResource
			};
			if (action instanceof NativeSubmenuAction) {
				item.id = this.actions.size;
				this.actions.set(item.id, action);
				item.lazy = true;
			} else if (action instanceof SubmenuAction) {
				item.children = ancestors.has(action) ? [] : visit(action.actions, new Set([...ancestors, action]));
			} else {
				item.id = this.actions.size;
				this.actions.set(item.id, action);
			}
			return item;
		});
		this.items = visit(delegate.getActions(), new Set());
	}

	expand(id: number): Promise<NativeMenuItem[] | undefined> {
		const action = this.actions.get(id);
		if (this.closed || !(action instanceof NativeSubmenuAction)) { return Promise.resolve(undefined); }
		let pending = this.pending.get(id);
		if (!pending) {
			pending = action.loadActions().then(actions => this.closed ? undefined : this.serialize(actions, new Set([action])));
			this.pending.set(id, pending);
		}
		return pending;
	}

	finish(id?: number, event?: IContextMenuEvent): void {
		if (this.closed) { return; }
		this.closed = true;
		const action = id === undefined ? undefined : this.actions.get(id);
		this.actions.clear();
		this.pending.clear();
		const selected = action?.enabled && !(action instanceof SubmenuAction) ? action : undefined;
		this.hide(!selected);
		if (!selected) { return; }
		const runner = this.delegate.actionRunner ?? new ActionRunner();
		const listener = runner.onDidRun(e => {
			if (e.error && !isCancellationError(e.error)) { this.reportError(e.error); }
		});
		const run = async () => {
			try {
				if (!this.delegate.skipTelemetry) { this.logAction(selected); }
				await runner.run(selected, this.delegate.getActionsContext?.(event));
			} catch (error) {
				if (!isCancellationError(error)) { this.reportError(error as Error); }
			} finally {
				listener.dispose();
				if (!this.delegate.actionRunner) { runner.dispose(); }
			}
		};
		void run();
	}
}
