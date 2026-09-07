/*---------------------------------------------------------------------------------------------
 *  Platform-neutral Quick Input key ownership.
 *--------------------------------------------------------------------------------------------*/

import { isTextEditingCommand } from './input/editValue.js';

export interface IDecodedInputKey {
	readonly name: string;
	readonly char?: string;
	readonly sequence?: string;
	readonly ctrl?: boolean;
	readonly alt?: boolean;
	readonly meta?: boolean;
}

export interface IQuickInputKeyAction {
	readonly outcome: 'accepted' | 'cancelled' | 'none';
	readonly run: () => void;
}

/** Shared classification used by every frontend; adapters only deliver the decoded key record. */
export function captureQuickInputKey<K extends IDecodedInputKey>(
	input: { handleKey(key: K): boolean }, key: K
): IQuickInputKeyAction | undefined {
	if (isTextEditingCommand(key)) { return { outcome: 'none', run: () => { input.handleKey(key); } }; }
	if (key.ctrl || key.alt || key.meta || key.name === 'char') { return undefined; }
	switch (key.name) {
		case 'escape': return { outcome: 'cancelled', run: () => { input.handleKey(key); } };
		case 'enter': return { outcome: 'accepted', run: () => { input.handleKey(key); } };
		case 'up': case 'down': case 'pageUp': case 'pageDown': case 'home': case 'end':
			return { outcome: 'none', run: () => { input.handleKey(key); } };
		default: return undefined;
	}
}

export interface IQuickInputPointerTarget {
	setFocus(index: number): void;
	accept(): void;
}

/** Shared pointer semantics for a provider result row; native lists emit only the row index. */
export function dispatchQuickInputRowActivation(target: IQuickInputPointerTarget, index: number): void {
	target.setFocus(index);
	target.accept();
}
