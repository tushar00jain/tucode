/*---------------------------------------------------------------------------------------------
 *  The paint, and only the paint (§4).
 *
 *  A line is a list of styled spans; the screen turns each into one row of SGR bytes, compares
 *  it against the row it painted last time, and writes only the rows that changed. Everything
 *  above this file decides *what* the rows say; nothing here knows about files, repositories or
 *  trees.
 *
 *  The escape sequences are the terminal's own wire protocol, so their reference is the
 *  VT/xterm spec rather than tscode, which is why writing them is not §16.1's failure (§4).
 *
 *  One deferral is on purpose: this diff is line-level and has no scroll-region
 *  optimisation. If byte volume ever matters, the implementation to port is blessed's
 *  `Screen.prototype.render`. Do not invent a cell diff.
 *
 *  Upstream counterpart: none — the terminal's own wire protocol (SGR, cursor and screen sequences), whose reference is the VT/xterm spec rather than tscode.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, toDisposable } from '../../vs/base/common/lifecycle.js';
import { isFullWidthCharacter } from '../../vs/base/common/strings.js';
import { SYNC } from './input.js';
import { blend } from '../../render/colors.js';
export { blend } from '../../render/colors.js';

export interface ISpan {
	readonly text: string;
	/** Stable semantic action represented by this painted span. */
	readonly actionId?: string;
	/** Spoken semantics when styling alone carries state; never changes the painted text. */
	readonly accessibleLabel?: string;
	readonly fg?: Color;
	readonly bg?: Color;
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
}

/** One terminal row. The last span's style is what pads the row out to the full width. */
export type ILine = readonly ISpan[];

/**
 * Something with a width to lay out against: the screen, or the part of the frame a pane was given.
 * A pane that wraps its text asks this rather than the terminal, so an editor beside a sidebar
 * wraps to the editor.
 */
export interface IViewport {
	readonly cols: number;
}

/**
 * Alternate screen, cursor, SGR-1006 mouse reporting, and bracketed paste.
 *
 * `?2004h` is what makes pasted text distinguishable from typed text: without it a terminal sends a
 * paste as the keystrokes that would have produced it, and `input.ts` has nothing to tell the two
 * apart with. It is asked for here rather than by whoever wants a paste, because the terminal's
 * modes belong to whoever is drawing on it — the same reason every other mode on this line is here.
 */
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h';
const LEAVE = '\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l';
const RESET = '\x1b[0m';

/** The width a span's text occupies, which is not its length once it holds CJK. */
export function spanWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += isFullWidthCharacter(ch.codePointAt(0)!) ? 2 : 1;
	}

	return width;
}

/**
 * Cuts `text` to at most `width` columns, by the same accounting.
 *
 * A control character is drawn as a space. Nothing above this file may move the cursor — a newline
 * in a span (an `IStatusbarEntry.tooltip`, a dialog's `detail`) would scroll the frame and shift
 * every row after it, which reads from outside as a pane painting in the wrong place. In a browser
 * the same string is whitespace in an element; here it has to be made whitespace on the way out.
 */
export function truncate(text: string, width: number): string {
	let taken = 0;
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		const w = isFullWidthCharacter(code) ? 2 : 1;
		if (taken + w > width) {
			break;
		}
		taken += w;
		out += code < 0x20 || code === 0x7f ? ' ' : ch;
	}

	return out;
}

/**
 * A vertical strip of the frame: how wide it is, the lines that fill it, and what fills the room
 * they do not reach.
 *
 * This is what a workbench with parts side by side needs and a single full-width pane did not.
 * Upstream expresses it as a grid of `Part`s over a `SplitView`; a terminal row is one line of
 * cells, so the composition is here — the same arrangement, one row at a time.
 */
export interface IColumn {
	readonly width: number;
	readonly lines: readonly ILine[];
	/** The background of a row this column's lines are shorter than, or do not reach at all. */
	readonly background?: Color;
}

/**
 * A translucent colour flattened onto what it is drawn over. `Color.blend` is upstream's own
 * compositor, and an opaque colour blended onto anything is itself — so this is only ever the
 * nullable form of that call, and a caller with nothing behind it gets what it had.
 */
/**
 * A span's two colours as one cell can hold them.
 *
 * **A cell has no alpha, so the composite a browser does per pixel happens on the way out.**
 * Upstream states both halves of every pair — `list.activeSelectionBackground` with its
 * `Foreground`, a find-match background with the text over it — and states most of those
 * backgrounds *with* an alpha, because a GUI composites them onto the part behind. Taking the
 * colour and dropping the alpha resolves one half of the pair and not the other: the shipped
 * theme's `#FFFFFF22` became white, and its deliberately light `list.activeSelectionForeground`
 * became white on white.
 *
 * So a colour is composited here, where the part behind it is known: the background onto the strip
 * it is drawn in, the foreground onto the background it sits on. Blending composes, so a colour
 * `dom/paint.ts` has already merged onto a translucent one arrives with the combined alpha and is
 * finished against the part — the same stack a browser walks.
 */
function composite(span: ISpan, background: Color | undefined): ISpan {
	const bg = blend(span.bg, background);
	const fg = blend(span.fg, bg ?? background);

	return bg === span.bg && fg === span.fg ? span : { ...span, bg, fg };
}

/** One line, cut or padded to exactly `width` columns, in the colours a cell can hold. */
function fit(line: ILine, width: number, background: Color | undefined): ISpan[] {
	const spans: ISpan[] = [];
	let taken = 0;

	for (const span of line) {
		if (taken >= width) {
			break;
		}
		const text = truncate(span.text, width - taken);
		if (!text) {
			continue;
		}
		spans.push(composite(text === span.text ? span : { ...span, text }, background));
		taken += spanWidth(text);
	}

	if (taken < width) {
		spans.push({ text: ' '.repeat(width - taken), bg: background });
	}

	return spans;
}

/** `text` with its first `columns` columns removed, by the same accounting as `truncate`. */
function drop(text: string, columns: number): string {
	let skipped = 0;
	let out = '';
	for (const ch of text) {
		if (skipped >= columns) {
			out += ch;
			continue;
		}
		skipped += isFullWidthCharacter(ch.codePointAt(0)!) ? 2 : 1;
	}

	return out;
}

/** The columns a whole line occupies, by the same accounting as `spanWidth`. */
export function lineWidth(line: ILine): number {
	let width = 0;
	for (const span of line) {
		width += spanWidth(span.text);
	}

	return width;
}

/**
 * The columns `[from, to)` of a line, as spans. It is what the floating layer cuts a row into and
 * what a horizontally scrolled pane drops its hidden columns with — the same operation either way,
 * so there is one of it.
 */
export function cut(line: ILine, from: number, to: number): ISpan[] {
	const spans: ISpan[] = [];
	let at = 0;

	for (const span of line) {
		const width = spanWidth(span.text);
		const start = at;
		at += width;

		if (start >= to || at <= from) {
			continue;
		}

		const text = truncate(drop(span.text, Math.max(0, from - start)), to - Math.max(start, from));
		if (text) {
			spans.push(text === span.text ? span : { ...span, text });
		}
	}

	return spans;
}

/**
 * `lines` drawn over `frame` at `top`/`left`, each cut or padded to `width` — the floating layer a
 * context view is in a browser. What it covers it covers exactly: a row outside the rectangle is
 * the line it already was, so `Screen.paint` still writes only the rows that changed.
 */
export function over(frame: readonly ILine[], lines: readonly ILine[], top: number, left: number, width: number, background: Color | undefined): ILine[] {
	const painted = [...frame];

	for (const [index, line] of lines.entries()) {
		const row = top + index;
		if (row < 0 || row >= painted.length) {
			continue;
		}

		painted[row] = [
			...cut(painted[row], 0, left),
			...fit(line, width, background),
			...cut(painted[row], left + width, Number.MAX_SAFE_INTEGER)
		];
	}

	return painted;
}

/**
 * The columns side by side, `rows` rows tall — every row exactly as wide as the columns add up to,
 * so a short line in one part cannot leak the part beside it.
 */
export function columns(strips: readonly IColumn[], rows: number): ILine[] {
	const frame: ILine[] = [];

	for (let row = 0; row < rows; row++) {
		const line: ISpan[] = [];
		for (const strip of strips) {
			line.push(...fit(strip.lines[row] ?? [], strip.width, strip.background));
		}
		frame.push(line);
	}

	return frame;
}

function style({ fg, bg, bold, dim, italic, underline, strikethrough }: ISpan): string {
	let out = RESET;
	if (fg) {
		out += `\x1b[38;2;${fg.rgba.r};${fg.rgba.g};${fg.rgba.b}m`;
	}
	if (bg) {
		out += `\x1b[48;2;${bg.rgba.r};${bg.rgba.g};${bg.rgba.b}m`;
	}
	if (bold) {
		out += '\x1b[1m';
	}
	if (dim) {
		out += '\x1b[2m';
	}
	// A theme's TextMate rules carry `italic` and `underline` beside `bold`, so a token that has
	// either is drawn with it — the two SGR attributes every terminal this runs in supports.
	if (italic) {
		out += '\x1b[3m';
	}
	if (underline) {
		out += '\x1b[4m';
	}
	if (strikethrough) {
		out += '\x1b[9m';
	}

	return out;
}

/** A line as the bytes for one row, padded to `cols` in the last span's style. */
function encode(line: ILine, cols: number): string {
	let out = '';
	let width = 0;
	let last: ISpan | undefined;

	for (const span of line) {
		if (width >= cols) {
			break;
		}
		const text = truncate(span.text, cols - width);
		if (!text) {
			continue;
		}
		out += style(span) + text;
		width += spanWidth(text);
		last = span;
	}

	if (width < cols) {
		out += (last ? style(last) : RESET) + ' '.repeat(cols - width);
	}

	return out + RESET;
}

/**
 * The terminal, as somewhere to put lines.
 *
 * `out` is not required to be a tty: a boot whose stdout is a pipe cannot host an interactive
 * UI, and `main.ts` paints one frame to it instead — which is also how this is tested, by
 * reading the bytes back through a headless terminal emulator.
 */
export class Screen extends Disposable {

	private painted: string[] = [];
	private readonly _onDidResize = this._register(new Emitter<void>());
	readonly onDidResize: Event<void> = this._onDidResize.event;

	readonly interactive: boolean;
	cols: number;
	rows: number;

	constructor(private readonly out: NodeJS.WriteStream, fallback: { cols: number; rows: number }) {
		super();

		this.interactive = !!out.isTTY;
		this.cols = out.columns ?? fallback.cols;
		this.rows = out.rows ?? fallback.rows;

		if (this.interactive) {
			const onResize = () => {
				this.cols = out.columns;
				this.rows = out.rows;
				this.painted = [];
				this._onDidResize.fire();
			};
			out.on('resize', onResize);
			this._register(toDisposable(() => out.off('resize', onResize)));
		}
	}

	begin(): void {
		if (this.interactive) {
			this.out.write(ENTER);
		}
	}

	end(): void {
		if (this.interactive) {
			this.out.write(LEAVE);
		}
	}

	/**
	 * Answers a `SYNC` request, after the paint the request was waiting for. The same sequence in
	 * the other direction, which is what makes it a handshake rather than two conventions; an
	 * emulator ignores it, because a private CSI it has no handler for is what it is.
	 */
	reportSettled(): void {
		this.out.write(SYNC);
	}

	paint(lines: readonly ILine[]): void {
		let out = '';

		for (let row = 0; row < this.rows; row++) {
			const encoded = row < lines.length ? encode(lines[row], this.cols) : encode([], this.cols);
			if (encoded === this.painted[row]) {
				continue;
			}
			this.painted[row] = encoded;
			out += `\x1b[${row + 1};1H${encoded}`;
		}

		if (out) {
			this.out.write(out);
		}
	}
}
