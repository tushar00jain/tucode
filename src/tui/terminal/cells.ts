/*---------------------------------------------------------------------------------------------
 *  An emulator's cells, read back as the spans a row of the frame is made of.
 *
 *  This is the one part of an embedded region that has no upstream form at all. In a browser
 *  xterm.js owns a canvas and paints its own buffer; here the buffer has to be read out per cell
 *  and handed to `screen.ts`, which is what already knows how to turn spans into bytes. Nothing in
 *  tscode ever asks an xterm what it looks like.
 *
 *  It is a module of its own so it can be tested without a pty behind it: everything here is a
 *  function of a buffer and a palette.
 *
 *  Upstream counterpart: none — a browser lets xterm.js paint its own canvas, so nothing upstream ever reads a cell back.
 *--------------------------------------------------------------------------------------------*/

import type { IBufferCell } from '@xterm/headless';

import { Color, RGBA } from '../../vs/base/common/color.js';
// Type-only, and it has to stay that way: this module is unit-tested under Node's type stripping,
// which cannot load `screen.ts`'s own import closure.
import type { ILine, ISpan } from './screen.js';

/**
 * How the child's output is coloured, and the answer to "the child paints its own theme".
 *
 * A cell names a colour in one of three ways. *Default* is the theme's `terminal.foreground` and
 * `terminal.background`, so a child that says nothing is drawn in tucode's colours. A *palette*
 * index below sixteen is `terminal.ansiRed` and its fifteen siblings — so `\x1b[31m` is the red the
 * rest of this frontend draws in, which is what makes a shell in the editor area look like it
 * belongs there rather than like a window someone pasted in. Only a cell naming an *RGB* triple
 * escapes: a child running its own true-colour theme has picked exact values, and there is nothing
 * to map them onto.
 */
export interface IRegionTheme {
	readonly foreground: Color | undefined;
	readonly background: Color | undefined;
	/** `terminal.ansiBlack` … `terminal.ansiBrightWhite`, by palette index. */
	readonly ansi: readonly (Color | undefined)[];
}

/**
 * The 6×6×6 cube behind palette indices 16–231 and the 24-step grey ramp behind 232–255, which is
 * xterm's own table — `DEFAULT_ANSI_COLORS` builds it from the same two ladders. The first sixteen
 * are not here: those are the theme's, and `cellColour` reads them off it.
 *
 * The reference for this is the xterm spec rather than tscode, for the reason `screen.ts` gives for
 * its SGR sequences: it is the terminal's own wire protocol, on the other side of the wire.
 */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

export function paletteColour(index: number, theme: IRegionTheme): Color | undefined {
	if (index < theme.ansi.length) {
		return theme.ansi[index];
	}

	if (index >= 232) {
		const grey = 8 + (index - 232) * 10;

		return new Color(new RGBA(grey, grey, grey));
	}

	const offset = index - 16;

	return new Color(new RGBA(CUBE_STEPS[Math.floor(offset / 36) % 6], CUBE_STEPS[Math.floor(offset / 6) % 6], CUBE_STEPS[offset % 6]));
}

function cellColour(cell: IBufferCell, ground: 'Fg' | 'Bg', theme: IRegionTheme): Color | undefined {
	if (ground === 'Fg' ? cell.isFgDefault() : cell.isBgDefault()) {
		return ground === 'Fg' ? theme.foreground : theme.background;
	}

	const value = ground === 'Fg' ? cell.getFgColor() : cell.getBgColor();
	if (ground === 'Fg' ? cell.isFgRGB() : cell.isBgRGB()) {
		return new Color(new RGBA((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff));
	}

	return paletteColour(value, theme);
}

/** One cell's style, which is what a run of cells has to share to be one span. */
type ICellStyle = Omit<ISpan, 'text'>;

/** What a cell the emulator has never written is drawn as. */
const BLANK: ICellStyle = { bold: false, dim: false, italic: false, underline: false, strikethrough: false };

function sameStyle(a: ICellStyle, b: ICellStyle): boolean {
	return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
		&& a.italic === b.italic && a.underline === b.underline && a.strikethrough === b.strikethrough;
}

function styleOf(cell: IBufferCell, theme: IRegionTheme, cursor: boolean): ICellStyle {
	const fg = cellColour(cell, 'Fg', theme);
	const bg = cellColour(cell, 'Bg', theme);
	// `\x1b[7m` and the cursor cell are the same instruction to a renderer: draw this one the other
	// way round. This frontend hides the terminal's own cursor for the whole frame (`screen.ts`), so
	// an inverted cell is the only cursor a region can have.
	const inverse = !!cell.isInverse() !== cursor;

	return {
		fg: inverse ? bg : fg,
		bg: inverse ? fg : bg,
		bold: !!cell.isBold(),
		dim: !!cell.isDim(),
		italic: !!cell.isItalic(),
		underline: !!cell.isUnderline(),
		strikethrough: !!cell.isStrikethrough()
	};
}

/** What `regionLines` reads a row out of — `IBufferLine`, named by the one method it uses. */
export interface ICellLine {
	getCell(x: number): IBufferCell | undefined;
}

export interface IBufferReader {
	readonly baseY: number;
	readonly viewportY: number;
	readonly cursorX: number;
	readonly cursorY: number;
	getLine(y: number): ICellLine | undefined;
}

interface ITextCellLine extends ICellLine {
	readonly isWrapped: boolean;
	readonly length: number;
	translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface ITextBufferReader extends Omit<IBufferReader, 'getLine'> {
	getLine(y: number): ITextCellLine | undefined;
}

export interface IViewportText {
	readonly value: string;
	readonly cursorOffset: number;
}

/**
 * The active viewport as logical text rather than painted rows. xterm marks a physical row as
 * `isWrapped` when it continues the row before it, so the separator belongs to the next row: no
 * separator for a soft wrap and one newline for a real line boundary.
 */
export function viewportText(buffer: ITextBufferReader, rows: number): IViewportText {
	let value = '';
	const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
	let cursorOffset: number | undefined = cursorRow < 0 ? 0 : undefined;

	for (let row = 0; row < rows; row++) {
		const line = buffer.getLine(buffer.viewportY + row);
		const next = row + 1 < rows ? buffer.getLine(buffer.viewportY + row + 1) : undefined;
		const nextWrapped = next?.isWrapped === true;
		let segment = line?.translateToString(!nextWrapped) ?? '';

		// xterm leaves one null cell at the end when a double-width character wraps. Its search
		// projection removes that placeholder before joining the continuation; it is layout, not text.
		if (line && nextWrapped && next) {
			const last = line.getCell(line.length - 1);
			if (last?.getCode() === 0 && last.getWidth() === 1 && next.getCell(0)?.getWidth() === 2) {
				segment = segment.slice(0, -1);
			}
		}

		if (row === cursorRow) {
			cursorOffset = value.length + (line?.translateToString(false, 0, buffer.cursorX).length ?? 0);
		}

		value += segment;
		if (row + 1 < rows && !nextWrapped) {
			value += '\n';
		}
	}

	value = value.trimEnd();
	return { value, cursorOffset: Math.min(value.length, cursorOffset ?? value.length) };
}

/** One buffer row, as the fewest spans its cells can be said in. */
function line(row: ICellLine | undefined, cols: number, theme: IRegionTheme, cursorColumn: number): ILine {
	const spans: ISpan[] = [];
	let run: ICellStyle | undefined;
	let text = '';

	for (let column = 0; column < cols; column++) {
		const cell = row?.getCell(column);
		// The second cell of a wide character has width 0 and no chars of its own: the character
		// arrived with the first, and `spanWidth` already counts it as the two columns it is.
		if (cell && cell.getWidth() === 0) {
			continue;
		}

		const style = cell ? styleOf(cell, theme, column === cursorColumn) : { ...BLANK, bg: theme.background };
		const chars = cell?.getChars() || ' ';

		if (run && sameStyle(run, style)) {
			text += chars;
			continue;
		}

		if (run) {
			spans.push({ ...run, text });
		}
		run = style;
		text = chars;
	}

	if (run) {
		spans.push({ ...run, text });
	}

	return spans;
}

/**
 * The emulator's current viewport as `rows` lines. `viewportY` is xterm's one authoritative
 * scroll position; `baseY` remains where the live cursor screen begins while the user pages back.
 */
export function regionLines(buffer: IBufferReader, cols: number, rows: number, theme: IRegionTheme, cursor: boolean): ILine[] {
	const lines: ILine[] = [];
	const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;

	for (let row = 0; row < rows; row++) {
		lines.push(line(buffer.getLine(buffer.viewportY + row), cols, theme, cursor && row === cursorRow ? buffer.cursorX : -1));
	}

	return lines;
}
