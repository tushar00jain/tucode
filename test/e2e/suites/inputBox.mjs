// The one text input's editing keys, against a table worked by hand.
//
// **`editValue` is a pure function and this is not a frame assertion**, which puts it in the wrong
// suite for one reason: `test/unit` runs under `--experimental-transform-types`, and the classifier
// this reaches — upstream's own `WordCharacterClassifier` — comes through `base/common/process.ts`,
// whose line 6 imports a type without the `type` keyword. Type stripping leaves the binding in the
// module graph and the link fails. So it runs where the *compiled* tree is already the thing under
// test: `npm run e2e` builds first, which is the same reason `lib/theme.mjs` reads `out/`.
//
// What is asserted is the boundary, because that is the whole of why `Ctrl+W` exists here. The
// explorer filter it was built for prefills a path, and a path has no whitespace in it — so
// readline's `unix-word-rubout` answers the empty string for every row below, which is what
// `Ctrl+U` already does and would make one of the two keys pointless. The expected values are read
// off `USUAL_WORD_SEPARATORS`, not off a run.
//
// Upstream counterpart: none — a browser decides what a keystroke does to an `<input>`, so tscode has no such suite.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { editTextField, editValue, isTextEditingCommand } from '../../../out/src/input/editValue.js';
import { CARET, inputSpans } from '../../../out/src/tui/workbench/inputBox.js';

const typed = char => ({ name: 'char', char, sequence: char });
const control = char => ({ name: 'char', ctrl: true, char, sequence: '' });
const named = name => ({ name, sequence: '' });

const CTRL_W = control('w');
const CTRL_U = control('u');

const PLAIN_STYLE = { fg: undefined, placeholderFg: undefined };

export default function registerInputBoxSuite() {
	describe('input box', () => {
		it('appends a character and takes one off with backspace', () => {
			assert.equal(editValue(typed('x'), 'ab'), 'abx');
			assert.equal(editValue(named('backspace'), 'ab'), 'a');
			// Backspace in an empty box is nothing to delete rather than a failure.
			assert.equal(editValue(named('backspace'), ''), '');
		});

		it('appends committed text rather than the modifier-stripped key character', () => {
			assert.equal(editValue({ name: 'char', char: 'e', alt: true, sequence: '' }, 'caf'), undefined,
				'a dead-key prefix has not committed text');
			assert.equal(editValue({ name: 'char', char: 'e', sequence: 'é' }, 'caf'), 'café');
			assert.equal(editValue({ name: 'char', char: '2', alt: true, sequence: '™' }, ''), '™');
			assert.equal(editValue({ name: 'char', char: 'x', sequence: 'かな' }, 'a'), 'aかな',
				'a committed input-method sequence is not truncated to one codepoint');
		});

		// `undefined` rather than the value unchanged: it is what puts the key back where it came
		// from, which is how `Ctrl+C` still quits out of a picker and `↑` still moves a cursor.
		it('leaves every key that is not the box\'s alone', () => {
			assert.equal(editValue(named('down'), 'ab'), undefined);
			assert.equal(editValue(named('enter'), 'ab'), undefined);
			assert.equal(editValue(control('c'), 'ab'), undefined);
			assert.equal(editValue(control('a'), 'ab'), undefined);
		});

		// Two presses per segment, which is `deleteWordLeft`'s own answer at `WordStart`: the
		// separator is a word of its own, and then the name in front of it.
		it('takes a path apart one segment at a time on Ctrl+W', () => {
			const steps = ['src/tui/workbench/', 'src/tui/workbench', 'src/tui/', 'src/tui', 'src/', 'src', ''];

			for (let at = 0; at < steps.length - 1; at++) {
				assert.equal(editValue(CTRL_W, steps[at]), steps[at + 1]);
			}
			// And it stops there rather than throwing at an empty box.
			assert.equal(editValue(CTRL_W, ''), '');
		});

		it('takes the last word off a phrase on Ctrl+W', () => {
			assert.equal(editValue(CTRL_W, 'hello world'), 'hello ');
			assert.equal(editValue(CTRL_W, 'hello '), '');
			// A hyphen is a separator too, so a needle comes apart the way a path does.
			assert.equal(editValue(CTRL_W, 'needle-sibling'), 'needle-');
		});

		it('clears the whole box on Ctrl+U, however deep it is', () => {
			assert.equal(editValue(CTRL_U, 'src/tui/workbench/'), '');
			assert.equal(editValue(CTRL_U, 'one'), '');
			assert.equal(editValue(CTRL_U, ''), '');
		});

		it('edits an immutable value and selection without stealing global shortcuts', () => {
			assert.deepEqual(editTextField(CTRL_W, { value: 'workspace/one/two', selection: [17, 17] }),
				{ value: 'workspace/one/', selection: [14, 14], handled: true });
			assert.deepEqual(editTextField(CTRL_W, { value: 'before selected after', selection: [7, 15] }),
				{ value: 'before  after', selection: [7, 7], handled: true });
			assert.deepEqual(editTextField(named('left'), { value: 'abc', selection: [2, 2] }),
				{ value: 'abc', selection: [1, 1], handled: true });
			assert.deepEqual(editTextField(named('delete'), { value: 'abc', selection: [1, 1] }),
				{ value: 'ac', selection: [1, 1], handled: true });
			assert.equal(isTextEditingCommand(CTRL_W), true);
			assert.equal(isTextEditingCommand(control('c')), false);
		});

		it('draws the value, and the placeholder while there is none', () => {
			const text = (...args) => inputSpans(...args).map(span => span.text);

			assert.deepEqual(text('typed', 'a name', false, PLAIN_STYLE), ['typed']);
			assert.deepEqual(text('', 'a name', false, PLAIN_STYLE), ['a name']);
			// The placeholder stays while the box has the keyboard, which is what a browser does
			// with the `placeholder` attribute and what two of the three boxes already did.
			assert.deepEqual(text('', 'a name', true, PLAIN_STYLE), ['a name', CARET]);
			// A box with neither is the caret alone rather than an empty span.
			assert.deepEqual(text('', '', true, PLAIN_STYLE), [CARET]);
			assert.deepEqual(text('', '', false, PLAIN_STYLE), []);
		});
	});
}
