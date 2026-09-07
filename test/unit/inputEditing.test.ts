/*---------------------------------------------------------------------------------------------
 *  Where `Ctrl+W` and `Ctrl+U` delete back to, against a table worked by hand.
 *
 *  **This is the assertion the boundary exists for.** Every box reads these two offsets, and
 *  the discriminating case is the one the explorer's `/` box put in front of it: readline's rule —
 *  the other plausible answer, and the one a hand-rolled version reaches for — deletes back to
 *  whitespace, which takes `src/vs/workbench/` out of a box holding a path in one keystroke.
 *  Upstream's `USUAL_WORD_SEPARATORS` takes one segment. Every expectation below is derived from
 *  `_doFindPreviousWordOnLine`'s three arms rather than from this module's own output.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineStartBefore, wordStartBefore } from '../../src/vs/workbench/browser/tauri/inputEditing.js';

describe('inputEditing · the word before the caret', () => {
	// A path is separators, which is the whole reason the boundary had to be upstream's: each
	// press takes one segment, and the separator run in front of it on the next.
	it('takes one path segment at a time, where a whitespace rule would take the path', () => {
		assert.equal(wordStartBefore('src/vs/workbench', 16), 7, 'one press should leave `src/vs/`');
		assert.equal(wordStartBefore('src/vs/workbench/', 17), 16, 'a trailing separator goes on its own');
		assert.equal(wordStartBefore('src/vs/', 7), 6);
		assert.equal(wordStartBefore('src/vs', 6), 4);
	});

	it('takes a word, and then the whitespace with the word in front of it', () => {
		assert.equal(wordStartBefore('foo bar', 7), 4);
		assert.equal(wordStartBefore('foo ', 4), 0, 'the run of whitespace is not a word of its own');
		assert.equal(wordStartBefore('foo', 3), 0);
	});

	it('reads the caret rather than the end of the value', () => {
		assert.equal(wordStartBefore('alpha beta', 5), 0);
		assert.equal(wordStartBefore('alpha beta', 6), 0, 'the space belongs to the word in front of it');
		assert.equal(wordStartBefore('alpha beta', 8), 6);
	});

	it('never leaves the line the caret is on', () => {
		assert.equal(wordStartBefore('first\nsecond', 12), 6);
		assert.equal(wordStartBefore('first\n', 6), 6, 'an empty line has nothing in front of the caret');
	});

	it('answers a caret with nothing before it', () => {
		assert.equal(wordStartBefore('', 0), 0);
		assert.equal(wordStartBefore('abc', 0), 0);
	});
});

describe('inputEditing · the line before the caret', () => {
	it('is the start of the value in a box with one line, which is every box the terminal has', () => {
		assert.equal(lineStartBefore('', 0), 0);
		assert.equal(lineStartBefore('one/two', 7), 0);
		assert.equal(lineStartBefore('one/two', 3), 0);
	});

	it('is the character after the newline in front of the caret', () => {
		assert.equal(lineStartBefore('first\nsecond', 12), 6);
		assert.equal(lineStartBefore('first\nsecond', 6), 6, 'a caret at the line start deletes nothing');
		assert.equal(lineStartBefore('first\nsecond', 5), 0, 'a caret on the newline is still on the first line');
	});
});
