/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A keybinding number, written the way a person reads it — decoded by upstream rather than by
 * masking the number ourselves.
 *
 * Two things read `keymap.ts` for a human: the drift gate, which prints a chord inside a finding,
 * and the keyboard page, which prints all of them. A second speller would let the two disagree
 * about what `2084` is called — exactly the kind of difference nobody thinks to check.
 */
import { KeyCodeUtils } from '../src/vs/base/common/keyCodes.js';
import { decodeKeybinding } from '../src/vs/base/common/keybindings.js';
import { OperatingSystem } from '../src/vs/base/common/platform.js';

/**
 * Pinned, not detected. This port ships Windows, so `CtrlCmd` is ctrl, and so is every label the
 * drift gate measures against. A label built under a different assumption would read as drift on
 * every chord.
 */
const OS = OperatingSystem.Windows;

/** `_simpleAsString`'s modifier order, which is the order every label upstream draws is built in. */
const MODIFIERS = [['ctrlKey', 'Ctrl'], ['shiftKey', 'Shift'], ['altKey', 'Alt'], ['metaKey', 'Meta']];

/**
 * @param {number} binding a chord-encoded binding, as `IKeymapRow.keys` holds them
 * @returns {string} e.g. `Ctrl+K Ctrl+S`, or `?<number>` when the number decodes to nothing
 */
export function chordLabel(binding) {
	const decoded = decodeKeybinding(binding, OS);

	return decoded?.chords.map(chord => [
		...MODIFIERS.filter(([field]) => chord[field]).map(([, name]) => name),
		KeyCodeUtils.toString(chord.keyCode)
	].join('+')).join(' ') ?? `?${binding}`;
}
