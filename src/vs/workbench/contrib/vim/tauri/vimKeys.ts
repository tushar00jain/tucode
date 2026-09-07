/*---------------------------------------------------------------------------------------------
 *  A Monaco key event as the name the vim engine spells keys with.
 *
 *  Neither half of this is derived. The first is `monacoToCmKey` in
 *  `src/vendor/monaco-vim/cm_adapter.ts`, reached as the adapter's `keyName` static, which turns
 *  an `IKeyboardEvent` into CodeMirror 5's key name (`'x'`, `Ctrl-a`, `Shift-Tab`, `Esc`). The
 *  second is `cmKeyToVimKey`, **copied verbatim** — its two tables included — from the vendored
 *  engine's own sibling package, `packages/cm5-vim/index.js:71-105` at the revision
 *  `../../../../../vendor/codemirror-vim/README.md` pins, which is how CodeMirror 5 itself feeds
 *  this engine. Its `// TODO` is upstream's and is left where it is, like the rest of a copy.
 *
 *  The join between them is the one thing that is ours, and it is three lines: `cmKeyToVimKey`
 *  answers `false` for a bare printable character, because in CodeMirror 5 a literal reaches the
 *  engine through the keymap's own character bindings rather than through this function. There is
 *  no CodeMirror 5 here, so a bare character is passed through as itself — which is what the vim
 *  spelling of `x` is.
 *
 *  Upstream counterpart: none — no VS Code file translates a key event for a vim engine.
 *--------------------------------------------------------------------------------------------*/

import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import CMAdapter from '../../../../../vendor/monaco-vim/cm_adapter.js';

const modifiers: Record<string, string> = { Shift: 'S', Ctrl: 'C', Alt: 'A', Cmd: 'D', Mod: 'A', CapsLock: '' };
const specialKeys: Record<string, string> = { Enter: 'CR', Backspace: 'BS', Delete: 'Del', Insert: 'Ins' };

function cmKeyToVimKey(key: string): string | false {
	if (key.charAt(0) === '\'') {
		// Keypress character binding of format "'a'"
		return key.charAt(1);
	}
	const pieces = key.split(/-(?!$)/);
	const lastPiece = pieces[pieces.length - 1];
	if (pieces.length === 1 && pieces[0].length === 1) {
		// No-modifier bindings use literal character bindings above. Skip.
		return false;
	} else if (pieces.length === 2 && pieces[0] === 'Shift' && lastPiece.length === 1) {
		// Ignore Shift+char bindings as they should be handled by literal character.
		return false;
	}
	let hasCharacter = false;
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i];
		if (piece in modifiers) { pieces[i] = modifiers[piece]; }
		else { hasCharacter = true; }
		if (piece in specialKeys) { pieces[i] = specialKeys[piece]; }
	}
	if (!hasCharacter) {
		// Vim does not support modifier only keys.
		return false;
	}
	// TODO: Current bindings expect the character to be lower case, but
	// it looks like vim key notation uses upper case.
	if (/^[A-Z]$/.test(lastPiece)) {
		pieces[pieces.length - 1] = lastPiece.toLowerCase();
	}

	return '<' + pieces.join('-') + '>';
}

/** The engine's name for this key, or `undefined` for one it cannot spell. */
export function vimKeyName(event: IKeyboardEvent): string | undefined {
	const cmKey = (CMAdapter as unknown as { keyName(e: IKeyboardEvent): string }).keyName(event);

	if (!cmKey) {
		return undefined;
	}
	if (cmKey.length === 1) {
		return cmKey;
	}

	return cmKeyToVimKey(cmKey) || undefined;
}
