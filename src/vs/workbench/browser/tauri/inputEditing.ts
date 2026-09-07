/*---------------------------------------------------------------------------------------------
 *  What `Ctrl+W` and `Ctrl+U` erase from a text box, declared once.
 *
 *  The two keys are one interaction — *how far back does the deletion go* — and what this module
 *  answers is the **offset**, never the deletion, so it names no box and touches no DOM. The box
 *  here is an `<input>`, the range is deleted through the browser's own editing command so the
 *  widget around it still hears `input`, and the call site is one expression over the offset. It
 *  lives beside `keymap.ts` and stays portable for the same reason that table does: the unit
 *  runner reads it from a plain `node` process.
 *
 *  **The boundary is upstream's own and that is the part that had to be right**, not the key:
 *  `USUAL_WORD_SEPARATORS` classified by upstream's own `WordCharacterClassifier`, which is what
 *  `Ctrl+Backspace` moves by in a Monaco editor. Readline's whitespace rule would take
 *  `src/vs/workbench/` out of a box holding a path in one keystroke, and the box these keys exist
 *  for is the explorer's `/`.
 *
 *  `wordStart` is **rung 3, and the step down is recorded because rung 1 was measured**.
 *  `WordOperations.moveWordLeft` is public and takes an `ICursorSimpleModel` a one-line box can
 *  satisfy, but `cursorWordOperations.ts` reaches `cursorCommon.ts:15`, which imports
 *  `ILanguageConfigurationService` as a value for one parameter type — and that file's parameter
 *  decorators are what `--experimental-transform-types` cannot parse. It builds fine; what it
 *  costs is the unit runner:
 *
 *      SyntaxError: Invalid or unexpected token
 *        at languageConfigurationRegistry.ts:41   @IConfigurationService
 *
 *  **A word boundary no unit runner can load is a boundary asserted nowhere**, and `inputEditing.test.ts`
 *  is the only place this one is asserted against a table worked by hand — an e2e keystroke reads
 *  one case through a running window. The adapter is the other half of the price: `moveWordLeft`
 *  wants an `ICursorSimpleModel`, so rung 1 also means copying five `pieceTreeTextBuffer.ts` and
 *  `textModel.ts` bodies down to give a one-line box the shape of a document.
 *
 *  So the loop below is `_doFindPreviousWordOnLine`'s, copied body-first, with everything a
 *  delete-to-the-start does not read deleted: the word's *end* — `_findEndOfWord` — and the
 *  `wordType`/`nextCharClass` pair on the result.
 *
 *  Upstream counterpart: none — a browser decides what a keystroke does to an `<input>`, so no
 *  upstream file does this. `coreCommands.ts`'s `EditorOrNativeTextInputCommand` is the shape
 *  around one, and `keymap.contribution.ts` is where that shape is answered.
 *--------------------------------------------------------------------------------------------*/

import { getMapForWordSeparators, WordCharacterClass } from '../../../editor/common/core/wordCharacterClassifier.js';
import { USUAL_WORD_SEPARATORS } from '../../../editor/common/core/wordHelper.js';

/** `USUAL_WORD_SEPARATORS` with no Intl locales, which is `getWordAtText`'s own default map. */
const WORD_SEPARATORS = getMapForWordSeparators(USUAL_WORD_SEPARATORS, []);

/** `cursorWordOperations.ts`'s own three, which the loop below is the reader of. */
const enum WordType {
	None = 0,
	Regular = 1,
	Separator = 2
}

/** Where the word before the end of `line` starts, or `0` for a line with no word in it. */
function wordStart(line: string): number {
	let wordType = WordType.None;
	const previousIntlWord = WORD_SEPARATORS.findPrevIntlWordBeforeOrAtOffset(line, line.length - 1);

	for (let chIndex = line.length - 1; chIndex >= 0; chIndex--) {
		const chCode = line.charCodeAt(chIndex);
		const chClass = WORD_SEPARATORS.get(chCode);

		if (previousIntlWord && chIndex === previousIntlWord.index) {
			return previousIntlWord.index;
		}

		if (chClass === WordCharacterClass.Regular) {
			if (wordType === WordType.Separator) {
				return chIndex + 1;
			}
			wordType = WordType.Regular;
		} else if (chClass === WordCharacterClass.WordSeparator) {
			if (wordType === WordType.Regular) {
				return chIndex + 1;
			}
			wordType = WordType.Separator;
		} else if (chClass === WordCharacterClass.Whitespace) {
			if (wordType !== WordType.None) {
				return chIndex + 1;
			}
		}
	}

	return 0;
}

/**
 * Where the line the caret is on begins — `Ctrl+U`'s answer, and the offset every other is from.
 * A single-line box always answers `0`.
 */
export function lineStartBefore(value: string, caret: number): number {
	return value.lastIndexOf('\n', caret - 1) + 1;
}

/**
 * Where the word before the caret begins — `Ctrl+W`'s answer, and what `deleteWordLeft` at
 * `WordNavigationType.WordStart` deletes back to in an editor.
 *
 * The line is truncated at the caret rather than passed whole with a column, because that is the
 * same question: `_doFindPreviousWordOnLine` walks back from the caret and never reads what is in
 * front of it. Its `whitespaceHeuristics` arm — delete a run of trailing whitespace on its own —
 * is not taken, because it needs a `DeleteWordContext` carrying the auto-closing-pair
 * configuration a box outside an editor has none of.
 */
export function wordStartBefore(value: string, caret: number): number {
	const lineStart = lineStartBefore(value, caret);

	return lineStart + wordStart(value.slice(lineStart, caret));
}
