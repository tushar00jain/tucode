/*---------------------------------------------------------------------------------------------
 *  A decoded key as the `KeyCode` half of the event upstream's keybinding stack dispatches, and
 *  the seam that says which of a command's bindings a surface *prints*.
 *
 *  `WorkbenchKeybindingService` dispatches an `IKeyboardEvent` — a `KeyCode` plus the modifier
 *  flags, which `keybinding.ts` declares in `common/` and which has nothing DOM about it beyond
 *  the name. This is the translation from an `IKey` into that, and it decides nothing: the
 *  resolution, the labels and the dispatch strings are the resolved keybinding's.
 *
 *  The wire's answers — a layout that cannot be seen, and the chords a terminal cannot carry — are
 *  next door in `terminalKeyboard.ts`.
 *
 *  One thing survives from the terminal that was never about the wire: **which key a character
 *  came off is a fact about a layout**, and `?` naming `Shift+Slash` is read out of upstream's own
 *  `EN_US_WIN_LAYOUT` rather than derived. A character no layout column accounts for has no
 *  `KeyCode`, which is not a failure — it is a key no rule can name, so it belongs to whatever has
 *  focus.
 *
 *  What a terminal cannot tell us, stated rather than guessed at:
 *
 *  - **No scan code**, so `IKeyboardEvent.code` is empty. `mightProducePrintableCharacter` reads
 *    it and therefore answers false for everything; nothing in this frontend asks.
 *  - **No Meta**, which never reaches the application at all.
 *  - **Modifiers only on the keys that have an escape sequence.** A terminal reports them in the
 *    CSI parameter — `\x1b[1;5C` is `Ctrl+Right`, `\x1b[21;2~` is `Shift+F10` — so an arrow, a
 *    page key or a function key carries all three, and a letter carries only `Ctrl`. `Alt+X` on a
 *    letter arrives as ESC then X, which is two keys.
 *  - **Shift is inferred from the character, because that is all a terminal sends.** A letter says
 *    it by being uppercase. Everything else says it by being the *shifted* character its key
 *    produces — `?` is Shift and `/`, `!` is Shift and `1`.
 *
 *  Upstream counterpart: src/vs/base/browser/keyboardEvent.ts
 *--------------------------------------------------------------------------------------------*/

import { ResolvedKeybinding } from '../../vs/base/common/keybindings.js';
import { EVENT_KEY_CODE_MAP, KeyCode, KeyCodeUtils } from '../../vs/base/common/keyCodes.js';
import { IKeyboardEvent, IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { KeymapInfo } from '../../vs/workbench/services/keybinding/common/keymapInfo.js';
import { EN_US_WIN_LAYOUT } from '../../vs/workbench/services/keybinding/browser/keyboardLayouts/en.win.js';
import { IKey } from '../terminal/input.js';

/** `input.ts`'s named keys, as the `KeyCode`s a keybinding rule is declared in. */
const NAMED: Record<string, KeyCode> = {
	up: KeyCode.UpArrow,
	down: KeyCode.DownArrow,
	left: KeyCode.LeftArrow,
	right: KeyCode.RightArrow,
	home: KeyCode.Home,
	end: KeyCode.End,
	pageUp: KeyCode.PageUp,
	pageDown: KeyCode.PageDown,
	enter: KeyCode.Enter,
	tab: KeyCode.Tab,
	shiftTab: KeyCode.Tab,
	escape: KeyCode.Escape,
	backspace: KeyCode.Backspace,
	f1: KeyCode.F1, f2: KeyCode.F2, f3: KeyCode.F3, f4: KeyCode.F4,
	f5: KeyCode.F5, f6: KeyCode.F6, f7: KeyCode.F7, f8: KeyCode.F8,
	f9: KeyCode.F9, f10: KeyCode.F10, f11: KeyCode.F11, f12: KeyCode.F12
};

/**
 * Every character a US keyboard produces with Shift held, and the key that produced it — `?` from
 * `/`, `!` from `1`, `:` from `;`.
 *
 * A terminal sends the character and nothing else, so this is the only way a rule written as
 * `Shift+Slash` can ever match: the layout says which key that character came off. The data is
 * upstream's `EN_US_WIN_LAYOUT` read through upstream's own `KeymapInfo`, which is what deserializes
 * a mapping's `value`/`withShift` columns — nothing here decides which character is which key.
 *
 * Letters are already answered by `KeyCodeUtils.fromString` and never reach this.
 */
const SHIFTED = (() => {
	const layout = new KeymapInfo(EN_US_WIN_LAYOUT.layout, EN_US_WIN_LAYOUT.secondaryLayouts, EN_US_WIN_LAYOUT.mapping);
	const shifted = new Map<string, KeyCode>();

	for (const { value, withShift } of Object.values(layout.mapping)) {
		const keyCode = value ? KeyCodeUtils.fromString(value.toUpperCase()) : KeyCode.Unknown;
		if (withShift && withShift !== value && keyCode !== KeyCode.Unknown && !shifted.has(withShift)) {
			shifted.set(withShift, keyCode);
		}
	}

	return shifted;
})();

/**
 * A decoded keystroke as the event the keybinding service dispatches, or `undefined` for a key that
 * has no `KeyCode` — anything the decoder passed through as text and no layout accounts for. A key
 * with no answer is not a failure: it is a key no rule can name, so it belongs to whatever has focus.
 *
 * `KeyCodeUtils.fromString` is upstream's own table, so `/` is `KeyCode.Slash` and `1` is
 * `KeyCode.Digit1` by the same mapping a `keybindings.json` entry is read with.
 */
export function toKeyboardEvent(key: IKey): IKeyboardEvent | undefined {
	const named = NAMED[key.name];
	const unshifted = named ?? (key.char ? KeyCodeUtils.fromString(key.char.toUpperCase()) : KeyCode.Unknown);
	const shifted = unshifted === KeyCode.Unknown && key.char ? SHIFTED.get(key.char) : undefined;
	const keyCode = key.keyCode ?? shifted ?? unshifted;

	if (keyCode === KeyCode.Unknown) {
		return undefined;
	}

	return {
		_standardKeyboardEventBrand: true,
		ctrlKey: !!key.ctrl,
		// An uppercase letter is the shift a terminal reports as itself on a *letter*, and a shifted
		// character is the shift it reports on every other key; a key with an escape sequence carries
		// its modifiers in the sequence, and `Shift+Tab` has a sequence of its own, which `input.ts`
		// decodes under a name of its own.
		shiftKey: !!key.shift || key.name === 'shiftTab' || shifted !== undefined || (!!key.char && key.char !== key.char.toLowerCase()),
		altKey: !!key.alt,
		metaKey: !!key.meta,
		altGraphKey: false,
		keyCode,
		code: key.code ?? ''
	};
}

/**
 * Recreate the browser event that a terminal cannot supply. This is transport translation only:
 * VS Code's keybinding service and focused DOM widget still decide what the key does.
 */
export function toBrowserKeyboardEvent(key: IKey): KeyboardEvent | undefined {
	const translated = toKeyboardEvent(key);
	if (!translated) { return undefined; }
	const browserKeyCode = Object.keys(EVENT_KEY_CODE_MAP).map(Number)
		.find(code => EVENT_KEY_CODE_MAP[code] === translated.keyCode);
	if (browserKeyCode === undefined) { return undefined; }

	const browserKey: Record<string, string> = {
		up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
		home: 'Home', end: 'End', pageUp: 'PageUp', pageDown: 'PageDown',
		enter: 'Enter', tab: 'Tab', shiftTab: 'Tab', escape: 'Escape', backspace: 'Backspace'
	};
	return new KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		key: key.char ?? browserKey[key.name] ?? KeyCodeUtils.toString(translated.keyCode),
		code: translated.code,
		ctrlKey: translated.ctrlKey,
		shiftKey: translated.shiftKey,
		altKey: translated.altKey,
		metaKey: translated.metaKey,
		keyCode: browserKeyCode
	} as KeyboardEventInit & { keyCode: number });
}

/**
 * Which of a command's bindings a surface *names*, given the one `lookupKeybinding` answered with.
 *
 * The question only has a second answer where the frontend cannot carry every chord, so the
 * default here is upstream's own: the primary is what runs the command, so it is what a hint and a
 * keystroke must agree on. A terminal installs `deliverableKeybinding` over it — see
 * `terminalKeyboard.ts` — because `workbench.action.showCommands` is `Ctrl+Shift+P` with `F1`
 * behind it, and only the second of those reaches a pty.
 */
export type KeybindingNamer = (keybindingService: IKeybindingService, commandId: string, primary: ResolvedKeybinding | undefined) => ResolvedKeybinding | undefined;

let namer: KeybindingNamer = (_keybindingService, _commandId, primary) => primary;

export function setKeybindingNamer(fn: KeybindingNamer): void {
	namer = fn;
}

/**
 * The binding to print for a command. Every surface that *shows* a key asks this — the status
 * line, the keys overlay, a context menu's row and the command palette's keybinding column — so
 * there is one answer to which key a command is offered by rather than four.
 *
 * The primary still decides *whether* the command applies, because that is the part the context
 * check is about; this only chooses which of its bindings is printed.
 */
export function namedKeybinding(keybindingService: IKeybindingService, commandId: string, primary: ResolvedKeybinding | undefined): ResolvedKeybinding | undefined {
	return namer(keybindingService, commandId, primary);
}
