// In-app editing: the vim engine, on the frames it paints and on the file it writes.
//
// The other half of the evidence is `lib/vimDriver.mjs`, which drives the engine over a
// `TextModel` directly and reads 33 results back out of it. This suite asserts the two things that
// one cannot: that the app **paints** the edit, and that `:w` **reaches the disk**. Both matter for
// the same reason `§17` gives — a renderer that paints nothing throws nothing, and a save that is
// never made looks exactly like a save that was.
//
// Upstream counterpart: none — tscode has no vim mode, so there is no upstream suite for one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { README, VIM_MARK } from '../lib/fixture.mjs';
import { editorLines, statusLine } from '../lib/probes.mjs';
import { themeColour, themeColourOver } from '../lib/theme.mjs';

/** The editor area's rows as plain text, with the gutter and the trailing pad taken off. */
const text = frame => editorLines(frame).map(line => line.text.trimEnd());

/** The native tab strip is the only row above the file; the duplicate path header was removed. */
const HEADER_ROWS = 1;

/** The row a model line is drawn on. None of the README's first lines is long enough to wrap. */
function fileRow(frame, line) {
	const row = editorLines(frame)[HEADER_ROWS + line - 1];
	assert.equal(row.text.trim().split(/\s+/)[0], String(line), `row ${line} of the file is ${JSON.stringify(row.text.trimEnd())}`);

	return row;
}

/** How many of a row's cells are drawn in one background, which is the whole of what a layer is. */
const cellsDrawnIn = (row, background) => row.cells.filter(cell => cell.bg === background).length;

/**
 * The selection is stated with an alpha in this theme and a cell has no alpha, so the pane
 * flattens it — onto the editor's own background, since no row a selection is asserted on below is
 * the one the cursor is putting the active-line highlight under. The caret's colour is opaque and
 * is therefore itself wherever it lands.
 */
const SELECTION = themeColourOver('editor.selectionBackground', 'editor.background');
const CARET = themeColour('editorCursor.foreground');

/** The README's first line as the steps above leave it: `A` appended the marker to it. */
const EDITED_LINE_LENGTH = README.line.length + VIM_MARK.length;

export default function registerVimSuite(context) {
	describe('in-app editing', () => {
		it('turns vim mode on over the file the editor area is showing', () => {
			const rows = text(context.frames.vimOn);

			assert.ok(rows.some(row => row.includes(README.line)),
				`the buffer should still be on screen with vim mode on — got ${JSON.stringify(rows.slice(0, 3))}`);
			assert.ok(!rows.some(row => row.includes(VIM_MARK)),
				'nothing is typed yet');
		});

		it('says which mode the buffer is in, where the shell pane says the keys are its own', () => {
			// `Pane.editing` is the mechanism both use, so the status line drops the workbench's
			// keys for the same reason in both cases — and the mode is the one thing vim's own
			// status line has that a reader cannot infer from the frame.
			assert.match(statusLine(context.frames.vimOn).text, /vim: normal/,
				`the status line reads ${JSON.stringify(statusLine(context.frames.vimOn).text.trimEnd())}`);
			assert.match(statusLine(context.frames.vimTyped).text, /vim: normal/,
				'`Escape` left insert mode');
		});

		it('paints what insert mode typed, in the row it was typed into', () => {
			const rows = text(context.frames.vimTyped);
			const edited = rows.find(row => row.includes(README.line));

			assert.ok(edited?.endsWith(VIM_MARK),
				`\`A\` appends at the end of the line, so the marker belongs at the end of it — got ${JSON.stringify(edited)}`);
		});

		it('writes the file on `:w`, which is the only thing the frames cannot say', () => {
			const path = join(context.fixture.root, README.name);
			const onDisk = readFileSync(path, 'utf8');

			assert.ok(onDisk.includes(VIM_MARK),
				`the edit should have reached the disk — the file holds ${JSON.stringify(onDisk)}`);
		});

		it('gives the caret a cell on a line that has none of its own', () => {
			const row = fileRow(context.frames.vimEmptyRow, 2);

			assert.equal(row.text.trim(), '2', 'the README\'s second line is empty, so the row is its gutter and nothing else');
			assert.equal(cellsDrawnIn(row, CARET), 1,
				'the caret is a cell, and a row that contributes no characters has to be padded one for it to land on');
		});

		it('paints a charwise selection across the lines it spans, the empty one included', () => {
			const frame = context.frames.vimVisual;

			assert.equal(cellsDrawnIn(fileRow(frame, 1), SELECTION), EDITED_LINE_LENGTH + 1,
				'the whole first line, plus the cell its line break is in');
			assert.equal(cellsDrawnIn(fileRow(frame, 2), SELECTION), 1,
				'the empty line is one cell wide when something is drawn on it');
		});

		it('paints a linewise selection as whole lines', () => {
			const frame = context.frames.vimVisualLine;

			assert.equal(cellsDrawnIn(fileRow(frame, 1), SELECTION), EDITED_LINE_LENGTH + 1);
			assert.equal(cellsDrawnIn(fileRow(frame, 2), SELECTION), 1);
		});

		it('paints a blockwise selection as a rectangle, clipped to each line', () => {
			const frame = context.frames.vimVisualBlock;

			// `ll` from column one is three columns, on every line the block covers.
			assert.equal(cellsDrawnIn(fileRow(frame, 1), SELECTION), 3,
				'a block is a column range rather than the rest of the line');
			assert.equal(cellsDrawnIn(fileRow(frame, 2), SELECTION), 0,
				'and it has nothing to cover on a line with no columns, which is what tells it from `V`');
		});

		it('hands the keys back to the workbench on `:q`', () => {
			assert.match(statusLine(context.frames.vimOff).text, /\bVim\b/,
				'with vim off the pane names its own keys again, and `Vim` is the way back in');
		});
	});
}
