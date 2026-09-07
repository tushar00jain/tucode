/*---------------------------------------------------------------------------------------------
 *  The text input, once: what a keystroke does to a value, and what a box looks like holding it.
 *
 *  Four boxes want this — the search pane's four, the source control commit message, the quick
 *  input's filter, and the two filter rows after it. Before this file each had its own `case 'char'`
 *  and its own caret, and the three were not the same: one hid its placeholder while it had the
 *  keyboard, one drew its caret in the placeholder's colour, and none of them could delete more than
 *  one character at a time.
 *
 *  **There is no widget here, and that is the shape rather than a shortfall.** Upstream's `InputBox`
 *  is a DOM `<input>` with a history navigator, a validation popup and a `ContextView` around it,
 *  and what a terminal box needs out of it is the two things a browser gives an `<input>` for free.
 *  Both are stateless, so both are functions over a value the caller already owns: the search pane
 *  keeps its query on `IPatternInfo`, the commit box keeps it on `ISCMInput`, and the quick input
 *  keeps it behind a setter that fires an event. A class holding the value would have had to be
 *  threaded through all three — and a divergence with no upstream counterpart is the code most
 *  likely to conflict on the next merge from tscode, so it meets those files at one call each.
 *
 *  **None of the boxes has a cursor position, so neither does this.** All four append at the end and
 *  delete from it, and `←`/`→` already belong to the tree in three of the four panes. The caret
 *  therefore marks *focus* rather than a position, which is what every one of them was already
 *  drawing it for.
 *
 *  `Ctrl+W`'s boundary is upstream's own — `USUAL_WORD_SEPARATORS` classified by upstream's own
 *  `WordCharacterClassifier`, which is what `Ctrl+Backspace` moves by in a Monaco editor. That
 *  matters for the explorer filter it exists for: a path is separators, and readline's whitespace
 *  rule would swallow `src/tui/workbench/` whole.
 *
 *  `wordStart` below is **rung 3, and the step down is recorded because rung 1 was tried**:
 *  `WordOperations.moveWordLeft` is public and takes an `ICursorSimpleModel` a one-line box can
 *  satisfy, but `cursorWordOperations.ts` reaches `languageConfigurationRegistry.ts` for one
 *  parameter type, and that file's parameter decorators are what `--experimental-transform-types`
 *  cannot strip (§13.4) — so importing it makes this function untestable by the unit runner,
 *  which is the only place a word boundary can be asserted against a table worked by hand. What is
 *  here is `_doFindPreviousWordOnLine`'s loop with everything but the start offset deleted.
 *
 *  Upstream counterpart: none — a browser decides what a keystroke does to an `<input>`, so there is no upstream file that does; `base/browser/ui/inputbox/inputBox.ts` is the widget around one.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { localize } from '../../vs/nls.js';
import { ISpan } from '../terminal/screen.js';

/** Where the keys are going. `.monaco-inputbox` has a real caret; a grid of cells has this. */
export const CARET = '▏';

/**
 * The two editing keys no keybinding rule declares, for a pane's `hint` to name. They are arms of
 * `editValue` rather than commands for the reason `backspace` is: a rule would have to be scoped to
 * `inputFocus`, and every other key in this fork is scoped *out* of it.
 */
export const INPUT_EDITING_HINT = localize('tscode.inputEditingHint', "Ctrl+W delete word · Ctrl+U clear");

/** What a box is drawn in: its text, what it says while it is empty, and whatever is behind both. */
export interface IInputStyle {
	readonly fg: Color | undefined;
	readonly placeholderFg: Color | undefined;
	readonly bg?: Color | undefined;
	readonly actionId?: string;
}

/**
 * The box: what it holds, or its placeholder while it holds nothing, and the caret while it is the
 * thing taking keys.
 *
 * **A placeholder shows whether or not the box has the keyboard**, which is what a browser does with
 * the `placeholder` attribute and what two of the three call sites already did. The search pane was
 * the odd one out, and a focused empty box there read as a box with nothing in it and no name.
 */
export function inputSpans(value: string, placeholder: string, focused: boolean, style: IInputStyle): ISpan[] {
	const spans: ISpan[] = [];
	const text = value || placeholder;

	if (text) {
		spans.push({ text, actionId: style.actionId, fg: value ? style.fg : style.placeholderFg, bg: style.bg });
	}

	if (focused) {
		spans.push({ text: CARET, actionId: style.actionId, fg: style.fg, bg: style.bg });
	}

	return spans;
}
