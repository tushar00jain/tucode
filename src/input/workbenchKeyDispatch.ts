/*---------------------------------------------------------------------------------------------
 *  The one platform-neutral workbench key dispatcher.
 *
 *  Terminal input is decoded at the transport edge, then enters this exact semantic routing order.
 *--------------------------------------------------------------------------------------------*/

import type { IKeyboardEvent } from '../vs/platform/keybinding/common/keybinding.js';
import type { IContextKeyServiceTarget } from '../vs/platform/contextkey/common/contextkey.js';
import type { INormalizedKey as IKey } from './key.js';
import { recordInputStage } from './inputTrace.js';

export interface IWorkbenchKeyTarget {
	/** DOM/context target owned by the VS Code controller behind this painter. */
	keybindingTarget?(): IContextKeyServiceTarget | undefined;
	takesKey?(commandId: () => string | undefined, key?: IKey): boolean;
	handleKey?(key: IKey): boolean;
	diagnosticIdentity?(): Readonly<Record<string, unknown>>;
}

export interface IWorkbenchKeyDispatch<TKey extends IKey = IKey> {
	publishContext(): void;
	handleOverlayKey(key: TKey): boolean;
	target(): IWorkbenchKeyTarget | undefined;
	keyboardEvent(key: IKey): IKeyboardEvent | undefined;
	resolvedCommand(event: IKeyboardEvent): string | undefined;
	dispatchKeybinding(event: IKeyboardEvent, eventId?: number): boolean;
	handled(): void;
	diagnosticTarget?(): Readonly<Record<string, unknown>>;
}

/**
 * The production workbench dispatch order. Keep semantics here: adapters may only translate an
 * input record and implement the mechanics named by `IWorkbenchKeyDispatch`.
 */
export function dispatchWorkbenchKey<TKey extends IKey>(key: TKey, route: IWorkbenchKeyDispatch<TKey>, translatedEvent?: IKeyboardEvent): boolean {
	const eventId = key.diagnosticEventId;
	route.publishContext();
	recordInputStage(eventId, 'shared.focus', { ...(route.diagnosticTarget?.() ?? {}) });

	if (route.handleOverlayKey(key)) {
		recordInputStage(eventId, 'shared.decision', { owner: 'overlay', handled: true });
		route.handled();
		return true;
	}

	const event = translatedEvent ?? route.keyboardEvent(key);
	const target = route.target();
	if (target?.takesKey?.(() => event ? route.resolvedCommand(event) : undefined, key)) {
		const handled = target.handleKey?.(key) ?? false;
		recordInputStage(eventId, 'shared.decision', { owner: 'terminal', handled });
		if (handled) { route.handled(); }
		return true;
	}

	if (event && route.dispatchKeybinding(event, eventId)) {
		recordInputStage(eventId, 'shared.decision', { owner: 'keybinding', handled: true });
		route.handled();
		return true;
	}
	// Meta is a workbench/menu modifier. A rule that declined it returns it to the platform menu
	// chain; it is never reinterpreted as an unmodified pane/editor gesture.
	if (event?.metaKey) { recordInputStage(eventId, 'shared.decision', { owner: 'platform', handled: false }); return false; }

	if (target?.handleKey?.(key)) {
		recordInputStage(eventId, 'shared.decision', { owner: 'focusedTarget', handled: true });
		route.handled();
		return true;
	}

	recordInputStage(eventId, 'shared.decision', { owner: target ? 'focusedTarget' : 'none', handled: false });
	return false;
}
