// What an embedded region paints: the emulator's cells, read back as spans.
//
// The oracle is `@xterm/headless` itself — the test writes the bytes a child would write and
// asserts on what `cells.ts` makes of the buffer, so nothing here re-states how a cell ends up the
// colour it is. The colour values are xterm's published 256-colour table, worked out from the
// index rather than pasted back from this code's own output.
//
// Upstream counterpart: none — tests `tui/terminal/cells.ts`, which stands in for the renderer xterm.js has in a browser rather than for a tscode file.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import xtermHeadless from '@xterm/headless';

import { Color } from '../../src/vs/base/common/color.js';
import { regionLines, viewportText } from '../../src/tui/terminal/cells.js';

import type { IRegionTheme } from '../../src/tui/terminal/cells.js';
import type { ILine } from '../../src/tui/terminal/screen.js';

const FOREGROUND = Color.fromHex('#c0c0c0');
const BACKGROUND = Color.fromHex('#101010');

/** Sixteen distinguishable colours, so a wrong index is a wrong assertion rather than a near miss. */
const ANSI = Array.from({ length: 16 }, (_, index) => Color.fromHex(`#${index.toString(16).repeat(6)}`));

const THEME: IRegionTheme = { foreground: FOREGROUND, background: BACKGROUND, ansi: ANSI };

const COLS = 20;
const ROWS = 4;

/** A terminal holding `bytes`, read back as the region would read it. */
async function paint(bytes: string, cursor = false): Promise<ILine[]> {
	const terminal = new xtermHeadless.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
	try {
		await new Promise<void>(resolve => terminal.write(bytes, resolve));

		return regionLines(terminal.buffer.active, COLS, ROWS, THEME, cursor);
	} finally {
		terminal.dispose();
	}
}

async function logical(bytes: string, cols = 5, rows = 5): Promise<{ readonly value: string; readonly cursorOffset: number }> {
	const terminal = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
	try {
		await new Promise<void>(resolve => terminal.write(bytes, resolve));
		return viewportText(terminal.buffer.active, rows);
	} finally {
		terminal.dispose();
	}
}

/** The text of a row, which is every span's text in order. */
const textOf = (line: ILine) => line.map(span => span.text).join('');

describe('the embedded region\'s cells', () => {

	it('reads a plain row back as one span in the theme\'s own colours', async () => {
		const [first] = await paint('hello');

		assert.equal(first.length, 1);
		assert.equal(first[0].text, `hello${' '.repeat(COLS - 5)}`);
		assert.equal(first[0].fg, FOREGROUND);
		assert.equal(first[0].bg, BACKGROUND);
	});

	it('gives every row the region\'s full width, written or not', async () => {
		const lines = await paint('hi');

		assert.equal(lines.length, ROWS);
		assert.equal(textOf(lines[0]), `hi${' '.repeat(COLS - 2)}`);
		for (const line of lines.slice(1)) {
			assert.equal(textOf(line), ' '.repeat(COLS));
		}
	});

	it('resolves the first sixteen palette indices through the theme', async () => {
		// `\x1b[31m` is index 1 and `\x1b[94m` is index 12 — bright blue, which is the second ladder
		// rather than a second table.
		const [first] = await paint('\x1b[31mred\x1b[0m \x1b[94mblue');

		// Four spans, not three: the cells past `blue` were never written, so they carry the default
		// foreground rather than the one the child was last using.
		assert.deepEqual(first.map(span => [span.text, span.fg]), [
			['red', ANSI[1]],
			[' ', FOREGROUND],
			['blue', ANSI[12]],
			[' '.repeat(COLS - 8), FOREGROUND]
		]);
	});

	it('resolves the 6×6×6 cube and the grey ramp above it', async () => {
		// 196 is the cube's pure red (#ff0000) and 232 is the darkest grey (#080808) — xterm's own
		// values, and the two that tell a right ladder from an off-by-one.
		const [first] = await paint('\x1b[38;5;196mA\x1b[38;5;232mB');

		assert.equal(first[0].fg?.toString(), Color.fromHex('#ff0000').toString());
		assert.equal(first[1].fg?.toString(), Color.fromHex('#080808').toString());
	});

	it('keeps a 24-bit colour the child chose, because there is nothing to map it onto', async () => {
		const [first] = await paint('\x1b[38;2;18;52;86mX');

		assert.equal(first[0].fg?.toString(), Color.fromHex('#123456').toString());
	});

	it('carries the attributes a span can hold', async () => {
		const [first] = await paint('\x1b[1;3;4;9;2mstyled');

		assert.deepEqual(
			{ bold: first[0].bold, italic: first[0].italic, underline: first[0].underline, strikethrough: first[0].strikethrough, dim: first[0].dim },
			{ bold: true, italic: true, underline: true, strikethrough: true, dim: true });
	});

	it('draws an inverse cell the other way round', async () => {
		const [first] = await paint('\x1b[7minverse');

		assert.equal(first[0].fg, BACKGROUND);
		assert.equal(first[0].bg, FOREGROUND);
	});

	it('draws the cursor cell inverted, and only when the region has the keyboard', async () => {
		const focused = await paint('ab\x1b[1;1H', true);
		const unfocused = await paint('ab\x1b[1;1H', false);

		// The cursor is back on `a`, so that one cell is inverted and `b` is not.
		assert.deepEqual(focused[0].map(span => [span.text, span.bg]), [['a', FOREGROUND], [`b${' '.repeat(COLS - 2)}`, BACKGROUND]]);
		assert.equal(unfocused[0].length, 1);
	});

	it('takes a wide character once and counts it as the two columns it is', async () => {
		const [first] = await paint('日本');

		// Two wide characters are four columns, so the row is 18 characters and 20 columns wide —
		// the second cell of each pair carries no character of its own and is not read twice.
		assert.equal(textOf(first), `日本${' '.repeat(COLS - 4)}`);
	});

	it('projects one or many soft wraps as one logical line', async () => {
		assert.deepEqual(await logical('abcdefgh'), { value: 'abcdefgh', cursorOffset: 8 });
		assert.deepEqual(await logical('abcdefghijkl'), { value: 'abcdefghijkl', cursorOffset: 12 });
	});

	it('retains hard line boundaries and interior blank hard lines', async () => {
		assert.deepEqual(await logical('abc\r\ndef'), { value: 'abc\ndef', cursorOffset: 7 });
		assert.deepEqual(await logical('a\r\n\r\nb'), { value: 'a\n\nb', cursorOffset: 4 });
	});

	it('retains spaces at a soft wrap and removes a wide-character wrap placeholder', async () => {
		assert.deepEqual(await logical('abc  d'), { value: 'abc  d', cursorOffset: 6 });
		assert.deepEqual(await logical('abc日', 4), { value: 'abc日', cursorOffset: 4 });
	});

	it('maps first, hard and wrapped row cursors into UTF-16 accessibility offsets', async () => {
		assert.deepEqual(await logical('ab'), { value: 'ab', cursorOffset: 2 });
		assert.deepEqual(await logical('abc\r\nde'), { value: 'abc\nde', cursorOffset: 6 });
		assert.deepEqual(await logical('abcdefg'), { value: 'abcdefg', cursorOffset: 7 });
		const wide = await logical('日😀', 5);
		assert.equal(wide.value, '日😀');
		assert.equal(wide.cursorOffset, wide.value.length);
		assert.ok(wide.cursorOffset <= wide.value.length);
	});

	it('projects xterm scrollback from viewportY and leaves the live cursor below a paged-up viewport', async () => {
		const terminal = new xtermHeadless.Terminal({ cols: 12, rows: 3, allowProposedApi: true });
		try {
			await new Promise<void>(resolve => terminal.write('one\r\ntwo\r\nthree\r\nfour\r\nfive', resolve));
			assert.equal(terminal.buffer.active.baseY, 2);
			assert.equal(terminal.buffer.active.viewportY, 2);
			terminal.scrollPages(-1);
			assert.equal(terminal.buffer.active.viewportY, 0);
			assert.deepEqual(regionLines(terminal.buffer.active, 12, 3, THEME, true).map(textOf).map(value => value.trimEnd()),
				['one', 'two', 'three']);
			assert.deepEqual(viewportText(terminal.buffer.active, 3), { value: 'one\ntwo\nthree', cursorOffset: 13 });
			assert.ok(regionLines(terminal.buffer.active, 12, 3, THEME, true).flat().every(span => span.bg === BACKGROUND),
				'the live bottom-screen cursor was painted over a historical viewport row');
			terminal.scrollPages(1);
			assert.deepEqual(regionLines(terminal.buffer.active, 12, 3, THEME, false).map(textOf).map(value => value.trimEnd()),
				['three', 'four', 'five']);
		} finally { terminal.dispose(); }
	});
});
