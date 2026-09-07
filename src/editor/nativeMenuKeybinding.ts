import type { ResolvedKeybinding } from '../vs/base/common/keybindings.js';
import type { IMenuProjectionKey } from '../workbench/menuProjection.js';

// AppKit's character codes for the non-printing keys in VS Code's native accelerator format.
const nativeCharacters: Readonly<Record<string, string>> = {
	Space: ' ', Tab: '\t', Enter: '\r', Escape: '\x1b', Backspace: '\x08', Delete: '\x7f',
	Up: '\uf700', Down: '\uf701', Left: '\uf702', Right: '\uf703',
	Insert: '\uf727', Home: '\uf729', End: '\uf72b', PageUp: '\uf72c', PageDown: '\uf72d',
	Plus: '+'
};

/** Translate the resolved VS Code binding to AppKit presentation; never resolve commands here. */
export function nativeMenuKeybinding(binding: ResolvedKeybinding | undefined): IMenuProjectionKey | undefined {
	const label = binding?.getLabel() ?? undefined;
	if (!binding || !label) { return undefined; }
	const accelerator = binding.getElectronAccelerator();
	// Like VS Code's native menus, retain chords and other non-native bindings as title text.
	if (!accelerator) { return { characters: '', modifiers: 0, label }; }
	const key = accelerator.replace(/^(?:(?:Ctrl|Shift|Alt|Cmd)\+)+/, '');
	const functionKey = /^F([1-9]|[12]\d|3[0-5])$/.exec(key);
	const characters = nativeCharacters[key] ?? (functionKey ? String.fromCharCode(0xf703 + Number(functionKey[1]))
		: [...key].length === 1 ? key.toLowerCase() : '');
	const chord = binding.getChords()[0];
	const modifiers = (chord.shiftKey ? 1 << 17 : 0) | (chord.ctrlKey ? 1 << 18 : 0)
		| (chord.altKey ? 1 << 19 : 0) | (chord.metaKey ? 1 << 20 : 0);
	return { characters, modifiers, label };
}
