/*---------------------------------------------------------------------------------------------
 *  The keyboard behavior imposed by a terminal wire.
 *
 *  `keyboard.ts` beside this maps a decoded key to the `KeyCode` the keybinding service dispatches
 *  on. What is here is the two answers a wire imposes: a layout
 *  nothing in this process can see, and the fact that **a terminal cannot carry every chord**.
 *
 *  **Nothing imports this except the terminal's own entry point.** That is the switch: importing
 *  it runs the `setKeybindingNamer` below, so the surfaces that print a key print the one a
 *  terminal can send. There is no runtime flag; the import is the registration.
 *
 *  Upstream counterpart: src/vs/workbench/services/keybinding/browser/keyboardLayoutService.ts
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../vs/base/common/event.js';
import { ResolvedKeybinding } from '../../vs/base/common/keybindings.js';
import { OperatingSystem } from '../../vs/base/common/platform.js';
import { IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { IKeyboardLayoutInfo, IKeyboardLayoutService, IKeyboardMapping } from '../../vs/platform/keyboardLayout/common/keyboardLayout.js';
import { IKeyboardMapper } from '../../vs/platform/keyboardLayout/common/keyboardMapper.js';
import { FallbackKeyboardMapper } from '../../vs/workbench/services/keybinding/common/fallbackKeyboardMapper.js';
import { setKeybindingNamer } from './keyboard.js';

/**
 * Whether a terminal can send this chord at all.
 *
 * Three of these are walls this build hit one at a time, a phase apart, and each was found by
 * trying: `Alt`+letter arrives as `ESC` then the letter, which is two keys (`§7`); a terminal has
 * no `Ctrl`+digit on the wire at all (`§6`); and shift+ctrl+letter is byte-identical to
 * ctrl+letter, which is what makes upstream's `Ctrl+Shift+P` unreachable and `F1` the palette's key
 * (`§6.4`). Meta never reaches an application.
 *
 * A named key — an arrow, a function key, a page key — carries its modifiers in the CSI parameter,
 * so it is deliverable whatever they are, which is what A2's decoder made true. The one exception
 * this does not model is `Ctrl+Enter`, which is the same byte as `Enter` and is recorded in `§11`.
 */
export function isDeliverable(keybinding: ResolvedKeybinding): boolean {
	return keybinding.getChords().every(chord => {
		if (chord.altKey || chord.metaKey) {
			return false;
		}

		// A `keyLabel` of one character is a key that arrives *as* that character, so the only
		// modifier a terminal has for it is the control byte, and only a letter has one.
		const character = chord.keyLabel?.length === 1 ? chord.keyLabel : undefined;

		return !character || !chord.ctrlKey || (!chord.shiftKey && /[a-z]/i.test(character));
	});
}

/**
 * The binding to *name* for a command: its primary, or — when a terminal cannot send that — the
 * first of its bindings that it can.
 *
 * `lookupKeybinding` answers with the primary, and an upstream command's primary can be a chord no
 * terminal produces: `workbench.action.showCommands` is `Ctrl+Shift+P` with `F1` behind it. So
 * every surface that *shows* a key asks `namedKeybinding` instead — the status line, the keys
 * overlay, a context menu's row and the command palette's keybinding column — and there is one
 * answer to which key a command is offered by rather than four.
 *
 * The primary still decides *whether* the command applies, because that is the part the context
 * check is about; this only chooses which of its bindings is printed.
 */
export function deliverableKeybinding(keybindingService: IKeybindingService, commandId: string, primary: ResolvedKeybinding | undefined): ResolvedKeybinding | undefined {
	return primary && !isDeliverable(primary)
		? keybindingService.lookupKeybindings(commandId).find(isDeliverable) ?? primary
		: primary;
}

setKeybindingNamer(deliverableKeybinding);

/**
 * The keyboard layout, for a program that cannot see one.
 *
 * Every answer here is "unknown", and each is the truth rather than a stand-in — a pty delivers
 * the character the user's layout already produced, so there is no mapping left to apply and
 * nothing to validate a mapping against. `getKeyboardMapper` is the one member with real work
 * behind it, and the work is upstream's: `FallbackKeyboardMapper` dispatches on `KeyCode` rather
 * than on scan code, which is not a compromise here but the only correct choice — the scan code
 * that produced a character is not on the wire at all, and an unknowable layout is the state
 * upstream wrote that mapper for too.
 */
export class TerminalKeyboardLayoutService implements IKeyboardLayoutService {

	declare readonly _serviceBrand: undefined;
	readonly terminalWire = true;

	readonly onDidChangeKeyboardLayout = Event.None;

	// A pty has Ctrl and no Meta on every host. Resolve `CtrlCmd` as Ctrl even
	// on macOS; using the host OS there turns every portable terminal chord
	// (`Ctrl+W`, `Ctrl+B`, …) into an impossible Command chord.
	private readonly mapper = new FallbackKeyboardMapper(false, OperatingSystem.Linux);

	getRawKeyboardMapping(): IKeyboardMapping | null {
		return null;
	}

	getCurrentKeyboardLayout(): IKeyboardLayoutInfo | null {
		return null;
	}

	getAllKeyboardLayouts(): IKeyboardLayoutInfo[] {
		return [];
	}

	getKeyboardMapper(): IKeyboardMapper {
		return this.mapper;
	}

	validateCurrentKeyboardMapping(): void {
		// There is no mapping to have gone stale.
	}
}
