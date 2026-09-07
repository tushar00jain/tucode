// A painted frame, read back per cell for regression checks.
//
// A run whose stdout is not a tty paints at a fixed size (`TUCODE_COLS`/`TUCODE_ROWS`, default
// 100×30) and replays whatever stdin has, so the whole frontend is drivable with two pipes:
//
//   printf '\033[B\033[B\033[C' > keys.bin
//   node --import ./bin/bundler-imports.mjs out/src/main.js < keys.bin > frame.bin
//   node bin/read-frame.mjs frame.bin
//
// The emulator is `@xterm/headless`, so what comes back is what a terminal would show —
// including each row's colour as an RGB triple, which is the only way to assert on a theme.
//
// `Frames` is that emulator as a class, because `test/e2e/` needs several readings out of one run
// rather than one reading out of a file: the paint is a *diff* per repaint, so the emulator's state
// after a prefix of the stream is what was on screen at that point in the run.
//
// Upstream counterpart: none — reads a painted frame back as rows and RGB; tscode has a window to look at.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import xterm from '@xterm/headless';

/** The size a run with no tty paints at, which `main.ts` reads from the same two variables. */
export const FRAME_SIZE = {
	cols: Number(process.env.TUCODE_COLS ?? 100),
	rows: Number(process.env.TUCODE_ROWS ?? 30)
};

/** What a cell that was never painted answers, so a reading is never `undefined`. */
const BLANK_CELL = { ch: ' ', fg: 'default', bg: 'default', bold: false, dim: false, strikethrough: false };

/** A cell's colour as `rrggbb`, `default`, or `pN` for a palette index. */
export function cellColour(cell, ground) {
	if (!cell) {
		return 'default';
	}
	if (cell[`is${ground}RGB`]()) {
		return cell[`get${ground}Color`]().toString(16).padStart(6, '0');
	}

	return cell[`is${ground}Default`]() ? 'default' : `p${cell[`get${ground}Color`]()}`;
}

/** One row: the text a terminal would show, and every cell's colour and attributes. */
function readLine(buffer, y, cols) {
	const line = buffer.getLine(y);
	const cells = [];

	for (let x = 0; x < cols; x++) {
		const cell = line?.getCell(x);
		cells.push(cell === undefined ? BLANK_CELL : {
			ch: cell.getChars() || ' ',
			fg: cellColour(cell, 'Fg'),
			bg: cellColour(cell, 'Bg'),
			bold: !!cell.isBold(),
			dim: !!cell.isDim(),
			strikethrough: !!cell.isStrikethrough()
		});
	}

	// Trimmed here rather than by `translateToString`, which only drops cells that were never
	// written — and every row is padded to the full width in the last span's style (`screen.ts`).
	return { text: (line?.translateToString(true) ?? '').replace(/ +$/, ''), cells };
}

/** A painted stream, replayed into a terminal emulator and readable at any point in it. */
export class Frames {

	#terminal;

	constructor({ cols, rows } = FRAME_SIZE) {
		this.cols = cols;
		this.rows = rows;
		this.#terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true });
	}

	/** Feeds the next bytes the run wrote. Resolves once the emulator has applied them. */
	write(bytes) {
		return new Promise(resolve => this.#terminal.write(bytes, resolve));
	}

	/** What is on screen now, copied — so a later `write` cannot change a reading already taken. */
	snapshot() {
		const buffer = this.#terminal.buffer.active;
		const lines = [];
		for (let y = 0; y < this.rows; y++) {
			lines.push(readLine(buffer, y, this.cols));
		}

		return { cols: this.cols, rows: this.rows, lines };
	}

	/**
	 * Lets the emulator go. A snapshot is plain objects, so nothing read from it depends on this —
	 * but xterm keeps an idle timer of its own and re-arms it after every write, so a `Frames` that
	 * is never disposed holds a Node process open for up to fifteen seconds after its last byte.
	 */
	dispose() {
		this.#terminal.dispose();
	}
}

/** A frame as this file's CLI prints it: every row, with the colour of its third cell. */
export function printFrame(frame, label) {
	if (label) {
		console.log(`--- ${label}`);
	}

	for (const [y, line] of frame.lines.entries()) {
		// Column 2 rather than 0: a row's first cells are its indent, which carries no colour.
		const cell = line.cells[2];
		console.log(`${String(y).padStart(2)} fg=${cell.fg} bg=${cell.bg} |${line.text}`);
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const [file, cols = FRAME_SIZE.cols, rows = FRAME_SIZE.rows] = process.argv.slice(2);
	if (!file) {
		console.error('usage: node bin/read-frame.mjs <frame.bin> [cols] [rows]');
		process.exit(1);
	}

	const frames = new Frames({ cols: Number(cols), rows: Number(rows) });
	await frames.write(readFileSync(file, 'utf8'));
	printFrame(frames.snapshot());
}
