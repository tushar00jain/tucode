/*---------------------------------------------------------------------------------------------
 * Normalized input translated into the engine's key vocabulary, without loading the engine.
 *--------------------------------------------------------------------------------------------*/

import type { INormalizedKey as IKey } from '../input/key.js';

const NAMED: Readonly<Record<string, string>> = Object.freeze({
	escape: 'Esc', enter: 'CR', tab: 'Tab', backspace: 'BS', delete: 'Del', left: 'Left', right: 'Right',
	up: 'Up', down: 'Down', home: 'Home', end: 'End', pageUp: 'PageUp', pageDown: 'PageDown'
});

/** A decoded shared key as CodeMirror Vim spells it, or undefined when the engine cannot. */
export function vimKeyName(key: IKey): string | undefined {
	const named = NAMED[key.name];
	if (named) { return key.ctrl ? `<C-${named}>` : `<${named}>`; }
	if (key.name !== 'char' || key.char === undefined) { return undefined; }
	if (key.ctrl) { return `<C-${key.char.toLowerCase()}>`; }
	return key.char === ' ' ? '<Space>' : key.char.length === 1 && key.char >= ' ' ? key.char : undefined;
}
