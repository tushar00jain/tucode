/*---------------------------------------------------------------------------------------------
 * Frontend-neutral notification-toast state and command ownership.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { combinedDisposable, Disposable, IDisposable } from '../vs/base/common/lifecycle.js';
import { KeyCode } from '../vs/base/common/keyCodes.js';
import { CommandsRegistry } from '../vs/platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../vs/platform/keybinding/common/keybindingsRegistry.js';
import { NotificationPriority, Severity } from '../vs/platform/notification/common/notification.js';
import { INotificationViewItem, INotificationsModel, NotificationChangeType } from '../vs/workbench/common/notifications.js';
import { NotificationsToastsVisibleContext } from '../vs/workbench/common/contextkeys.js';
import { registerTakeoverKeepCommand } from '../vs/workbench/services/keybinding/tauri/keyboardTakeover.js';

export const HIDE_NOTIFICATION_TOAST = 'notifications.hideToasts';

export interface INotificationToastSnapshotItem {
	readonly id: string;
	readonly message: string;
	readonly source?: string;
	readonly severity: Severity;
}

export interface INotificationToastsSnapshot {
	readonly generation: number;
	readonly items: readonly INotificationToastSnapshotItem[];
}

/**
 * Decides which shared-model notifications are currently toasts. The native surface consumes only
 * immutable snapshots; hiding or closing always comes back through this controller.
 */
export class NotificationToastController extends Disposable {
	private readonly visibleContext: IContextKey<boolean>;
	private readonly identities = new WeakMap<INotificationViewItem, string>();
	private readonly items = new Map<string, INotificationViewItem>();
	private readonly visible: INotificationViewItem[] = [];
	private nextIdentity = 1;
	private generation = 0;

	private readonly _onDidSnapshot = this._register(new Emitter<INotificationToastsSnapshot>());
	readonly onDidSnapshot: Event<INotificationToastsSnapshot> = this._onDidSnapshot.event;

	constructor(model: INotificationsModel, contextKeyService: IContextKeyService) {
		super();
		this.visibleContext = NotificationsToastsVisibleContext.bindTo(contextKeyService);
		this._register(model.onDidChangeNotification(event => {
			switch (event.kind) {
				case NotificationChangeType.ADD: this.add(event.item); break;
				case NotificationChangeType.REMOVE: this.remove(event.item); break;
				case NotificationChangeType.CHANGE:
				case NotificationChangeType.EXPAND_COLLAPSE:
					if (this.visible.includes(event.item)) { this.publish(); }
					break;
			}
		}));
		for (const item of model.notifications.slice().reverse()) { this.add(item); }
	}

	get snapshot(): INotificationToastsSnapshot { return this.createSnapshot(); }

	hide(): void {
		if (this.visible.length === 0) { return; }
		for (const item of this.visible.splice(0)) { item.updateVisibility(false); }
		this.publish();
	}

	close(id: string): boolean {
		const item = this.items.get(id);
		if (!item) { return false; }
		item.close();
		return true;
	}

	private add(item: INotificationViewItem): void {
		if (item.priority === NotificationPriority.SILENT || this.visible.includes(item)) { return; }
		this.identity(item);
		this.visible.unshift(item);
		item.updateVisibility(true);
		while (this.visible.length > 3) { this.visible.pop()?.updateVisibility(false); }
		this.publish();
	}

	private remove(item: INotificationViewItem): void {
		const id = this.identities.get(item);
		if (id) { this.items.delete(id); }
		const index = this.visible.indexOf(item);
		if (index < 0) { return; }
		this.visible.splice(index, 1);
		item.updateVisibility(false);
		this.publish();
	}

	private identity(item: INotificationViewItem): string {
		let id = this.identities.get(item);
		if (!id) {
			id = `notification-toast-${this.nextIdentity++}`;
			this.identities.set(item, id);
			this.items.set(id, item);
		}
		return id;
	}

	private publish(): void {
		this.generation++;
		this.visibleContext.set(this.visible.length > 0);
		this._onDidSnapshot.fire(this.createSnapshot());
	}

	private createSnapshot(): INotificationToastsSnapshot {
		return Object.freeze({ generation: this.generation, items: Object.freeze(this.visible.map(item => Object.freeze({
			id: this.identity(item), message: item.message.raw, source: item.source, severity: item.severity
		}))) });
	}

	override dispose(): void {
		for (const item of this.visible.splice(0)) { item.updateVisibility(false); }
		this.visibleContext.reset();
		this.items.clear();
		super.dispose();
	}
}

/** Upstream's low-priority Escape owner, registered before the native key resolver is cached. */
export function registerNotificationToastCommands(toasts: NotificationToastController): IDisposable {
	registerTakeoverKeepCommand(HIDE_NOTIFICATION_TOAST);
	return combinedDisposable(
		CommandsRegistry.registerCommand(HIDE_NOTIFICATION_TOAST, () => toasts.hide()),
		KeybindingsRegistry.registerKeybindingRule({ id: HIDE_NOTIFICATION_TOAST,
			weight: KeybindingWeight.WorkbenchContrib - 50,
			when: NotificationsToastsVisibleContext, primary: KeyCode.Escape })
	);
}
