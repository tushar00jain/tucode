import type { IContextMenuDelegate, IContextMenuEvent } from '../vs/base/browser/contextmenu.js';
import { getActiveElement, isHTMLElement, ModifierKeyEmitter } from '../vs/base/browser/dom.js';
import { StandardMouseEvent } from '../vs/base/browser/mouseEvent.js';
import { Emitter } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { IMenuService, MenuId } from '../vs/platform/actions/common/actions.js';
import { getFlatContextMenuActions } from '../vs/platform/actions/browser/menuEntryActionViewItem.js';
import { CommandsRegistry } from '../vs/platform/commands/common/commands.js';
import { IFileService } from '../vs/platform/files/common/files.js';
import { URI } from '../vs/base/common/uri.js';
import { ResourceContextKey } from '../vs/workbench/common/contextkeys.js';
import { IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { ContextMenuMenuDelegate } from '../vs/platform/contextview/browser/contextMenuService.js';
import { IContextMenuMenuDelegate, IContextMenuService } from '../vs/platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../vs/platform/keybinding/common/keybinding.js';
import { INotificationService } from '../vs/platform/notification/common/notification.js';
import { ITelemetryService } from '../vs/platform/telemetry/common/telemetry.js';
import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../vs/base/common/actions.js';
import { NativeContextMenuSession } from './nativeContextMenu.js';
import { nativeMenuKeybinding } from './nativeMenuKeybinding.js';

export class MacContextMenuService extends Disposable implements IContextMenuService {
	declare readonly _serviceBrand: undefined;
	private readonly shown = this._register(new Emitter<void>());
	private readonly hidden = this._register(new Emitter<void>());
	readonly onDidShowContextMenu = this.shown.event;
	readonly onDidHideContextMenu = this.hidden.event;
	private sequence = 0;
	private session: NativeContextMenuSession | undefined;

	constructor(
		private readonly publish: (type: string, payload?: unknown) => void,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IFileService private readonly files: IFileService,
	) { super(); }

	/** Native rows supply the clicked model/context; VS Code supplies the menu and original actions. */
	showNativeMenu(menuId: MenuId, resource: URI | undefined, context: Iterable<[string, unknown]>,
		anchor: { x: number; y: number }, actionContext: () => unknown, supported: ReadonlySet<string>): void {
		const keys = this.contextKeyService.createOverlay([
			[ResourceContextKey.HasResource.key, !!resource],
			[ResourceContextKey.Scheme.key, resource?.scheme],
			[ResourceContextKey.IsFileSystemResource.key, !!resource && this.files.hasProvider(resource)],
			...context
		]);
		const groups = this.menuService.getMenuActions(menuId, keys, { arg: resource, shouldForwardArgs: true });
		const actions = getFlatContextMenuActions(groups.map(([group, items]) =>
			[group, items.filter(action => supported.has(action.id) && !!CommandsRegistry.getCommand(action.id))]));
		this.showContextMenu({ getAnchor: () => anchor, getActions: () => actions,
			getActionsContext: actionContext, getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id, keys) }, anchor);
	}

	showContextMenu(input: IContextMenuDelegate | IContextMenuMenuDelegate, nativeAnchor?: { x: number; y: number }): void {
		if (this.session) {
			this.publish('contextMenuHidden');
			this.session.finish();
		}
		const requestId = ++this.sequence;
		const delegate = ContextMenuMenuDelegate.transform(input, this.menuService, this.contextKeyService);
		const actions = delegate.getActions();
		if (!actions.length) { delegate.onHide?.(true); return; }
		const focus = getActiveElement();
		const anchor = delegate.getAnchor();
		const rect = isHTMLElement(anchor) ? anchor.getBoundingClientRect() : undefined;
		// DOM client coordinates are CSS pixels from the WKWebView's upper-left corner.
		const x = rect ? rect.left : anchor instanceof StandardMouseEvent ? anchor.posx - window.scrollX : (anchor as { x: number }).x;
		const y = rect ? rect.bottom : anchor instanceof StandardMouseEvent ? anchor.posy - window.scrollY : (anchor as { y: number }).y;
		this.session = new NativeContextMenuSession({ ...delegate, getActions: () => actions },
			action => nativeMenuKeybinding(delegate.getKeyBinding?.(action) ?? this.keybindingService.lookupKeybinding(action.id)),
			cancelled => {
				this.session = undefined;
				if (!nativeAnchor && isHTMLElement(focus) && focus.isConnected) { focus.focus(); }
				try { delegate.onHide?.(cancelled); } finally { this.hidden.fire(); }
			}, error => this.notificationService.error(error),
			action => this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: action.id, from: 'contextMenu' }));
		ModifierKeyEmitter.getInstance().resetKeyStatus();
		this.shown.fire();
		try {
			this.publish('contextMenu', { requestId, x, y, nativeAnchor, viewportWidth: window.innerWidth, items: this.session.items });
		} catch (error) { this.session?.finish(); throw error; }
	}

	dispatch(payload: { requestId?: number; id?: number; expandId?: number; modifiers?: IContextMenuEvent } | undefined): boolean {
		if (!payload || payload.requestId !== this.sequence || !this.session) { return false; }
		if (typeof payload.expandId === 'number') {
			const session = this.session;
			void session.expand(payload.expandId).then(items => {
				if (items && this.session === session) {
					this.publish('contextMenuChildren', { requestId: payload.requestId, id: payload.expandId, items });
				}
			}, error => {
				if (this.session !== session) { return; }
				this.notificationService.error(error);
				this.publish('contextMenuChildren', { requestId: payload.requestId, id: payload.expandId,
					items: [{ label: 'Unable to load folder', enabled: false }] });
			});
			return true;
		}
		this.session.finish(payload.id, payload.modifiers);
		return true;
	}

	override dispose(): void {
		this.session?.finish();
		this.publish('contextMenuHidden');
		super.dispose();
	}
}
