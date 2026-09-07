/*---------------------------------------------------------------------------------------------
 *  stdin, decoded — the fourth of the four things the cell writer owns (§4).
 *
 *  CSI keys, SGR-1006 mouse reports and bracketed paste, as the VT/xterm spec defines them. ConPTY absorbs the
 *  mode-setting sequences `screen.ts` writes and delivers input in the requested encoding
 *  itself, so the health check is what arrives here, never whether the DECSET reached the host
 *  (§5.3).
 *
 *  Upstream counterpart: none — CSI keys and SGR-1006 mouse reports off stdin; upstream's events reach it from the DOM already decoded.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, toDisposable } from '../../vs/base/common/lifecycle.js';
import type { INormalizedKey } from '../../input/key.js';

/** A normalized key produced by this transport, retaining the exact bytes stdin supplied. */
export interface IKey extends INormalizedKey {
	/**
	 * The bytes the terminal sent for this key, before they were decoded.
	 *
	 * A pane hosting a child process in a pty writes them through unchanged, which is the one
	 * thing a decoded key cannot answer: xterm.js re-encodes a `KeyboardEvent` into a sequence
	 * (`evaluateKeyboardEvent`) because a browser never had the bytes — here they arrived, and
	 * re-deriving them would be §16.1's failure with an encoder on the other side of the wire.
	 */
	readonly sequence: string;
}

export interface IMouse {
	readonly kind: 'down' | 'up' | 'wheelUp' | 'wheelDown';
	/** Zero-based, in screen cells. */
	readonly col: number;
	readonly row: number;
	/**
	 * Whether Shift was held. It is the one modifier anything above this file reads, because
	 * upstream's `AbstractScrollableElement._onMouseWheel` is where a vertical wheel with Shift held
	 * becomes a horizontal one.
	 */
	readonly shift?: boolean;
}

/** `\x1b[<b;x;yM` (press) / `m` (release) — SGR-1006. */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * The brackets a terminal puts round pasted text once `screen.ts` has asked for them with
 * `\x1b[?2004h`. They are the only thing on this wire that says *this was pasted, not typed*, and
 * without them the two are the same bytes: every character of a paste is dispatched as a keystroke,
 * so any character bound to a command runs it.
 *
 * Measured through a ConPTY rather than assumed, because that is what absorbed the mouse `DECSET`s
 * this file's header is about: both the `\x1b[?2004h` on the way out and the brackets on the way
 * back cross Windows' pseudoconsole byte for byte.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * How much of the end of a chunk could be the start of a paste that has not all arrived. A terminal
 * packs what it likes into one read, so the marker can straddle two — and a marker dispatched as
 * keys is the whole defect back.
 *
 * A lone `ESC` is never held: it is the escape key, the one sequence that is complete by being
 * alone. Everything held here begins `ESC [`, which decodes to nothing on its own today.
 */
function pasteStartTail(chunk: string): number {
	for (let length = Math.min(PASTE_START.length - 1, chunk.length); length >= 2; length--) {
		if (PASTE_START.startsWith(chunk.slice(chunk.length - length))) {
			return length;
		}
	}

	return 0;
}

/**
 * "Report when you have finished what my keys started." A private CSI, in the parameter space the
 * spec reserves for exactly this, and answered by `Screen.reportSettled` with the same sequence.
 *
 * **A driven run needs this and an interactive one cannot produce it.** Nothing a terminal sends is
 * a private CSI in this direction — the only things it sends unasked are keys and mouse reports —
 * so a run at a tty never sees one. What it buys is the property §16.7 asks for and a clock
 * cannot give: a driver knows the difference between "still working" and "finished", instead of
 * inferring it from a stretch of silence that a subprocess can be quieter than.
 */
export const SYNC = '\x1b[?7331n';

const CSI_KEYS: Record<string, string> = {
	'\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
	'\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end',
	'\x1b[5~': 'pageUp', '\x1b[6~': 'pageDown', '\x1b[Z': 'shiftTab',
	// The function keys, in both spellings a terminal uses for them: SS3 for F1–F4 unmodified,
	// and the CSI numbers for everything else. A modified F1–F4 arrives in the CSI form too,
	// which is why both rows exist.
	'\x1bOP': 'f1', '\x1bOQ': 'f2', '\x1bOR': 'f3', '\x1bOS': 'f4',
	// The cursor keys in their SS3 spelling, which is what a terminal sends while DECCKM
	// (application cursor mode) is on. Windows' pseudoconsole turns DECCKM on for whatever is
	// drawing on it, and Alacritty answers a wheel over the alternate screen with three of these
	// per notch — so until they were decoded, a wheel notch there arrived as nothing at all.
	'\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
	'\x1bOH': 'home', '\x1bOF': 'end',
	'\x1b[P': 'f1', '\x1b[Q': 'f2', '\x1b[R': 'f3', '\x1b[S': 'f4',
	'\x1b[11~': 'f1', '\x1b[12~': 'f2', '\x1b[13~': 'f3', '\x1b[14~': 'f4', '\x1b[15~': 'f5',
	'\x1b[17~': 'f6', '\x1b[18~': 'f7', '\x1b[19~': 'f8', '\x1b[20~': 'f9', '\x1b[21~': 'f10',
	'\x1b[23~': 'f11', '\x1b[24~': 'f12'
};

/**
 * A modified key, which xterm reports by adding a parameter: `\x1b[1;5C` is `Ctrl+Right` and
 * `\x1b[21;2~` is `Shift+F10`. The modifier is a bitmask over 1 — 1 shift, 2 alt, 4 ctrl — and the
 * unmodified sequence is what is left once it is taken out, so one table answers for both.
 */
const CSI_MODIFIED = /^\x1b\[(\d*);(\d+)([A-Za-z~])$/;

/** Splits a chunk into the individual sequences a terminal packs into one read. */
function* sequences(chunk: string): Iterable<string> {
	let i = 0;
	while (i < chunk.length) {
		if (chunk[i] !== '\x1b') {
			yield chunk[i++];
			continue;
		}

		// SS3 — `ESC O` and one final byte, which is how a terminal spells F1–F4 and, in
		// application-cursor mode, the arrows.
		if (chunk[i + 1] === 'O' && chunk[i + 2]) {
			yield chunk.slice(i, i + 3);
			i += 3;
			continue;
		}

		// A CSI sequence runs to its first final byte; a lone ESC is the escape key.
		const end = chunk.slice(i + 2).search(/[A-Za-z~]/);
		if (chunk[i + 1] !== '[' || end === -1) {
			yield '\x1b';
			i += 1;
			continue;
		}

		yield chunk.slice(i, i + 2 + end + 1);
		i += 2 + end + 1;
	}
}

export class Input extends Disposable {

	private readonly _onKey = this._register(new Emitter<IKey>());
	readonly onKey: Event<IKey> = this._onKey.event;

	private readonly _onMouse = this._register(new Emitter<IMouse>());
	readonly onMouse: Event<IMouse> = this._onMouse.event;

	private readonly _onPaste = this._register(new Emitter<string>());
	/**
	 * Text the user pasted, as one event rather than as its characters. **Nothing that arrives here
	 * is ever a key**, which is the property the whole mechanism exists for: what a paste can do is
	 * what a text input does with text, never what a keybinding does with a keystroke.
	 */
	readonly onPaste: Event<string> = this._onPaste.event;

	/** A paste whose closing bracket is still to come, held until the chunk that carries it. */
	private paste = '';

	private ended = false;

	private readonly _onDidEnd = this._register(new Emitter<void>());
	/** Fires when stdin closes, which for a piped run is the end of the input to replay. */
	readonly onDidEnd: Event<void> = this._onDidEnd.event;

	private readonly _onDidRequestSync = this._register(new Emitter<void>());
	/** Fires on `SYNC`, once every key written before it has been dispatched. */
	readonly onDidRequestSync: Event<void> = this._onDidRequestSync.event;

	/**
	 * `raw` puts a tty into character-at-a-time mode. It is off when nothing is painting to a
	 * tty, because the terminal's mode belongs to whoever is drawing on it.
	 */
	constructor(private readonly stdin: NodeJS.ReadStream, private readonly raw: boolean) {
		super();
	}

	/**
	 * Starts reading. Called once there is something on screen to steer: stdin is buffered until
	 * then, so a keystroke that arrives during boot acts on the pane it was meant for rather than
	 * on an empty one.
	 */
	start(): void {
		const { stdin, raw } = this;

		const onData = (chunk: string) => this.read(chunk);
		const onEnd = () => {
			this.ended = true;
			this._onDidEnd.fire();
		};

		if (raw && stdin.isTTY) {
			stdin.setRawMode(true);
		}
		stdin.setEncoding('utf8');
		stdin.on('data', onData);
		stdin.on('end', onEnd);
		this._register(toDisposable(() => {
			stdin.off('data', onData);
			stdin.off('end', onEnd);
			if (raw && stdin.isTTY) {
				stdin.setRawMode(false);
			}
			stdin.pause();
		}));
	}

	/**
	 * Resolves once everything stdin has to give has been dispatched. A tty has no end, so there
	 * is nothing to wait for — and a short pipe has usually ended before anyone asks, which is
	 * why the answer comes from `ended` rather than from waiting for the event.
	 */
	async replay(): Promise<void> {
		if (!this.stdin.isTTY && !this.ended) {
			await Event.toPromise(this.onDidEnd);
		}
	}

	/**
	 * One read from the terminal, split into the pastes it contains and the keys around them.
	 *
	 * The split happens before `sequences` rather than inside it because a paste is not a sequence:
	 * it is a span of arbitrary bytes between two markers, and every byte inside it — an `ESC`, a
	 * `\r`, a `t` — is text that must never be looked at as a key.
	 */
	private read(chunk: string): void {
		let text = this.paste + chunk;
		this.paste = '';

		for (let start = text.indexOf(PASTE_START); start !== -1; start = text.indexOf(PASTE_START)) {
			const end = text.indexOf(PASTE_END, start + PASTE_START.length);
			if (end === -1) {
				this.keys(text.slice(0, start));
				this.paste = text.slice(start);

				return;
			}

			this.keys(text.slice(0, start));
			this._onPaste.fire(text.slice(start + PASTE_START.length, end));
			text = text.slice(end + PASTE_END.length);
		}

		const tail = pasteStartTail(text);
		this.paste = text.slice(text.length - tail);
		this.keys(text.slice(0, text.length - tail));
	}

	private keys(text: string): void {
		for (const sequence of sequences(text)) {
			this.dispatch(sequence);
		}
	}

	private dispatch(sequence: string): void {
		if (sequence === SYNC) {
			this._onDidRequestSync.fire();
			return;
		}

		const mouse = SGR_MOUSE.exec(sequence);
		if (mouse) {
			const button = Number(mouse[1]);
			const col = Number(mouse[2]) - 1;
			const row = Number(mouse[3]) - 1;
			// Bits 2, 3 and 4 are Shift, Meta and Control. Only Shift is carried, because it is the
			// only one anything above this file reads.
			const shift = !!(button & 4);

			// Bit 6 marks a wheel event, and its low two bits are the direction.
			if (button & 64) {
				this._onMouse.fire({ kind: (button & 1) ? 'wheelDown' : 'wheelUp', col, row, shift });
			} else {
				this._onMouse.fire({ kind: mouse[4] === 'M' ? 'down' : 'up', col, row, shift });
			}

			return;
		}

		const modified = CSI_MODIFIED.exec(sequence);
		if (modified) {
			const named = CSI_KEYS[`\x1b[${modified[1]}${modified[3]}`] ?? CSI_KEYS[`\x1b[${modified[3]}`];
			const mask = Number(modified[2]) - 1;
			if (named) {
				this._onKey.fire({ name: named, shift: !!(mask & 1), alt: !!(mask & 2), ctrl: !!(mask & 4), sequence });
			}

			return;
		}

		const named = CSI_KEYS[sequence];
		if (named) {
			this._onKey.fire({ name: named, sequence });
			return;
		}

		switch (sequence) {
			case '\r': case '\n': return this._onKey.fire({ name: 'enter', sequence });
			case '\t': return this._onKey.fire({ name: 'tab', sequence });
			case '\x1b': return this._onKey.fire({ name: 'escape', sequence });
			case '\x7f': case '\b': return this._onKey.fire({ name: 'backspace', sequence });
		}

		if (sequence.length === 1 && sequence < ' ') {
			// A control character is the letter it is typed with, with bit 6 cleared.
			return this._onKey.fire({ name: 'char', ctrl: true, char: String.fromCharCode(sequence.charCodeAt(0) + 96), sequence });
		}

		if (sequence.length === 1) {
			this._onKey.fire({ name: 'char', char: sequence, sequence });
		}
	}
}
