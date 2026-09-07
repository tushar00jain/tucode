/*---------------------------------------------------------------------------------------------
 * Frontend-neutral scalar text input editing.
 *--------------------------------------------------------------------------------------------*/

import { getMapForWordSeparators, WordCharacterClass } from '../vs/editor/common/core/wordCharacterClassifier.js';
import { USUAL_WORD_SEPARATORS } from '../vs/editor/common/core/wordHelper.js';
import type { INormalizedKey } from './key.js';

export type IEditValueKey = INormalizedKey;

export interface ITextEditState {
	readonly value: string;
	/** Ordered UTF-16 offsets. A collapsed range is the caret. */
	readonly selection: readonly [number, number];
}

export interface ITextEditResult extends ITextEditState {
	readonly handled: true;
}

const WORD_SEPARATORS = getMapForWordSeparators(USUAL_WORD_SEPARATORS, []);

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

function range(selection: readonly [number, number], length: number): readonly [number, number] {
	const first = Math.max(0, Math.min(length, Number.isSafeInteger(selection[0]) ? selection[0] : length));
	const second = Math.max(0, Math.min(length, Number.isSafeInteger(selection[1]) ? selection[1] : first));
	return first <= second ? [first, second] : [second, first];
}

function result(value: string, start: number, end = start): ITextEditResult {
	return Object.freeze({ value, selection: Object.freeze([start, end] as [number, number]), handled: true as const });
}

/**
 * The sole neutral text-field edit transition. Window systems may offer decoded editing commands
 * here, but committed text (including IME/dead-key output) continues through their text-input
 * protocol and is never intercepted by native command selectors.
 */
export function editTextField(key: IEditValueKey, state: ITextEditState): ITextEditResult | undefined {
	const value = state.value;
	const [start, end] = range(state.selection, value.length);
	const selected = end > start;
	const replace = (from: number, to: number, text = '') => result(
		value.slice(0, from) + text + value.slice(to), from + text.length
	);

	if (!key.ctrl && !key.alt && !key.meta) {
		switch (key.name) {
			case 'backspace': return selected ? replace(start, end) : replace(Math.max(0, start - 1), start);
			case 'delete': return selected ? replace(start, end) : replace(start, Math.min(value.length, start + 1));
			case 'home': return result(value, 0);
			case 'end': return result(value, value.length);
			case 'left': return result(value, key.shift ? start : selected ? start : Math.max(0, start - 1), key.shift ? end : undefined);
			case 'right': return result(value, key.shift ? start : selected ? end : Math.min(value.length, end + 1), key.shift ? Math.min(value.length, end + 1) : undefined);
		}
	}

	if (key.name === 'char' && key.char !== undefined && !key.ctrl && !key.meta) {
		return key.sequence ? replace(start, end, key.sequence) : undefined;
	}

	if (key.name !== 'char' || !key.ctrl || key.alt || key.meta) { return undefined; }
	switch (key.char?.toLowerCase()) {
		case 'u': return selected ? replace(start, end) : replace(0, start);
		case 'w': return selected ? replace(start, end) : replace(wordStart(value.slice(0, start)), start);
		default: return undefined;
	}
}

/** True only for decoded commands that a focused scalar text control, not a global keybinding, owns. */
export function isTextEditingCommand(key: IEditValueKey): boolean {
	if (key.ctrl || key.alt || key.meta) {
		return key.name === 'char' && !!key.ctrl && !key.alt && !key.meta && ['u', 'w'].includes(key.char?.toLowerCase() ?? '');
	}
	return ['backspace', 'delete', 'home', 'end', 'left', 'right'].includes(key.name);
}

const enum WordType {
	None = 0,
	Regular = 1,
	Separator = 2
}

/** The sole implementation of scalar input editing, shared by every frontend. */
export function editValue(key: IEditValueKey, value: string): string | undefined {
	return editTextField(key, { value, selection: [value.length, value.length] })?.value;
}
