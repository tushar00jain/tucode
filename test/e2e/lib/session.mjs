// The run itself: one fixture, one app, one frame per step.
//
// **How the app is driven, and why this way.** A run whose stdout is not a tty paints at a fixed
// size and replays whatever stdin gives it (`CLAUDE.md`'s quick start), so the driver is two pipes
// and no pseudoconsole. Keys are written one step at a time rather than as one chunk, and the frame
// is read back between them — which is what makes a gesture that depends on the previous one having
// *finished* assertable: expanding a folder, then reading the children the folder read produced.
//
// Two properties this file exists to hold:
//
// - **A step is settled when the app says so, not when the paint has been quiet for a while.** Each
//   step's keys are followed by `SYNC`, and the app answers it once every key before it has been
//   dispatched *and* the work those keys started has finished painting (`Workbench.whenSettled`).
//   So the harness waits for the thing itself rather than for a stretch of silence, which is what
//   anything that has to tell "working" from "wedged" needs.
//
//   Silence was the rule until this run, and it was wrong in both directions: it spent 250 ms per
//   step doing nothing, and it still read the screen early whenever a keystroke's work outlived the
//   window — a pick's two `sl` invocations take about 800 ms, so the smartlog assertion was reading
//   the frame before the pick and the two filler keystrokes in front of it were a wait in disguise.
//
// - **A child process is the one thing that cannot be asked.** A shell paints when it likes and no
//   `whenSettled` covers it, so a step that drives one says `child: true` and waits for the app's
//   answer *and then* for the pty to write and stop. That is the only place a quiet window
//   survives, and it is two steps of forty-two rather than all of them.
// - **The run has to exit on its own.** `stdin.end()` is the last thing the driver does, and a
//   process that has finished its work and does not exit is a defect.
//   The exit is waited for under a bound and asserted, not assumed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Frames, printFrame } from '../../../bin/read-frame.mjs';
// The app's half of the handshake, from the build this run drives — the sequence has one home, and
// a driver that spawns `out/src/main.js` is already reading the same tree.
import { SYNC } from '../../../out/src/tui/terminal/input.js';

/** The repository root, resolved from this file rather than from the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The bytes a terminal sends for a key — the encoder whose decoder is `CSI_KEYS` and the switch
 * below it in `src/tui/terminal/input.ts`. Both sides answer to the VT/xterm spec rather than to each other,
 * which is the same reason `screen.ts` gives for its own sequences.
 */
export const KEYS = {
	up: '\x1b[A',
	down: '\x1b[B',
	right: '\x1b[C',
	left: '\x1b[D',
	home: '\x1b[H',
	end: '\x1b[F',
	pageUp: '\x1b[5~',
	pageDown: '\x1b[6~',
	enter: '\r',
	tab: '\t',
	// `Shift+Tab` is CSI Z, the one shifted key xterm gives a final byte of its own — `input.ts`
	// decodes it as `tab` carrying `shift`, which `keyboard.ts` maps onto `KeyMod.Shift`.
	shiftTab: '\x1b[Z',
	escape: '\x1b',
	backspace: '\x7f',
	// A control character is the letter it is typed with, with bit 6 cleared — `input.ts`'s decoder
	// read the other way round.
	ctrlW: '\x17',
	// `deleteWordLeft` and `deleteAllLeft` in a text input, which is what `inputBox.ts` answers
	// them with. Neither is a keybinding rule, so neither has a `when` clause to keep it out of a
	// pane — the box is what takes them, and the pane never sees them.
	ctrlU: '\x15',
	// Blockwise visual mode, which is the engine's own `<C-v>` and no keybinding of this fork's —
	// the pane answers `takesKey` for it while vim has the buffer.
	ctrlV: '\x16',
	ctrlB: '\x02',
	// `workbench.action.quickOpen`'s own primary. `workbench.action.showCommands`' own primary is
	// `Ctrl+Shift+P`, which is *this same byte* — which is why the palette is on its secondary, and
	// why there is no `ctrlShiftP` here to write.
	ctrlP: '\x10',
	// A function key unmodified is SS3, which is the spelling `input.ts` decodes first.
	f1: '\x1bOP',
	// A modified key carries its modifiers in the CSI parameter — 1 shift, 2 alt, 4 ctrl, over a
	// base of 1. `Shift+F10` is upstream's own keyboard route to a context menu, and `Ctrl+Down` is
	// its own `search.focus.nextInputBox`.
	shiftF10: '\x1b[21;2~',
	ctrlDown: '\x1b[1;5B',
	ctrlUp: '\x1b[1;5A',
	// `list.scrollRight` and `list.scrollLeft`, upstream's own ids at the key its vertical siblings
	// (`list.scrollUp`/`list.scrollDown`) already use one axis over.
	ctrlRight: '\x1b[1;5C',
	ctrlLeft: '\x1b[1;5D',
	// `paneview.ts:307–309`'s own collapse and expand, shifted: a terminal's focus is the view rather
	// than its header, so the bare arrows are the tree's inside the pane below.
	shiftLeft: '\x1b[1;2D',
	shiftRight: '\x1b[1;2C'
};

/**
 * A mouse report, as a terminal sends one once the app has asked for them: SGR-1006, which is the
 * encoding `screen.ts`'s `DECSET`s request and `input.ts`'s `SGR_MOUSE` decodes. Coordinates are
 * one-based on the wire and zero-based everywhere in this suite, which is the only conversion here.
 */
const report = (button, col, row, final) => `\x1b[<${button};${col + 1};${row + 1}${final}`;

/** A press and its release, which is what a click is on the wire. */
export const click = (col, row) => report(0, col, row, 'M') + report(0, col, row, 'm');

/** One wheel notch down. Bit 6 marks a wheel event and its low bit is the direction. */
export const wheelDown = (col, row) => report(65, col, row, 'M');

/**
 * One wheel notch up with Shift held — bit 2 — which upstream's own `_onMouseWheel` turns into a
 * horizontal scroll rather than a vertical one.
 */
export const shiftWheelUp = (col, row) => report(64 + 4, col, row, 'M');

/** Clears a query box, whatever is in it: one backspace per character. */
export const clear = text => KEYS.backspace.repeat(text.length);

/**
 * Text as a terminal delivers it once the app has asked for bracketed paste — `screen.ts`'s
 * `\x1b[?2004h`, whose brackets are the only thing on this wire that says *pasted, not typed*.
 * Without them the same text arrives as the keystrokes that would have produced it, and every
 * character of it is dispatched as one.
 */
export const paste = text => `\x1b[200~${text}\x1b[201~`;

/**
 * What `tscode.editFile` is pointed at — through **both** `VISUAL` and `EDITOR`, because
 * `editorCommand()` prefers the first and a developer machine commonly exports it (see `drive`).
 *
 * **The executable is a bare name on purpose**: a user's `$EDITOR` is `vim`, not `/usr/bin/vim`, and
 * resolving it is the backend's `find_executable` over the `PATH` the launch carries — which is the
 * whole of the defect this stub is here to catch. It is the runtime running this suite, so it is on
 * `PATH` by construction; `-e` means there is no script path to quote, and `$EDITOR` is split on
 * whitespace rather than by a shell's rules, so no token here may hold a space.
 *
 * The file to edit arrives as the last argument, which `-e` leaves at `process.argv[1]`.
 *
 * **`Z` is the stub's `:q`**, and it is what makes the exit path assertable without an editor binary:
 * every real `$EDITOR` is quit from inside itself, and what the region does with a child that has
 * quit is upstream's `_onProcessExit` — the tab goes when the process does.
 */
const STUB_EDITOR = [
	basename(process.execPath),
	'-e',
	// Raw mode is what a full-screen editor does, and here it is load-bearing: a console line-buffers
	// otherwise, so an `Escape` or a `Tab` with no `Enter` behind it would never reach the child.
	`process.stdin.setRawMode(true);process.stdout.write('EDITOR-OPENED:'+process.argv[1]+'\\r\\n');process.stdin.on('data',d=>{if(d.toString()==='Z'){process.exit(0);}process.stdout.write('EDITOR-SAW:'+JSON.stringify(d.toString())+'\\r\\n');})`
].join(' ');

/** Silence that means a *child process* has stopped painting. Nothing else settles on it. */
const QUIET = 250;

/** How often what has arrived is looked at. A poll interval, not a window anything settles on. */
const POLL = 10;

/**
 * What a step is allowed to take. Boot is the slowest at ~3 s and everything else is well under
 * one, so this is a few times the worst case — near enough to bite, which is the only kind of
 * bound that detects a hang rather than delaying it.
 */
const STEP_TIMEOUT = 15_000;

/** Teardown is a `stopHost()` and a log flush. */
const EXIT_TIMEOUT = 10_000;

// Node 26 probes its experimental global localStorage lazily and reports that no persistence file
// was configured. The TUI deliberately supplies no browser storage, so this one paired diagnostic
// is expected; every other stderr byte remains a failed boot.
export const unexpectedStderr = stderr => stderr.replace(
	/\(node:\d+\) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n?/g,
	''
);

const log = (...parts) => console.log('#', ...parts);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A bound, which is the same wait with one difference that matters: `unref` says it is not itself a
 * reason to keep the process alive. Without it the ten seconds this suite is *allowed* to spend
 * waiting for the app to exit are ten seconds it always spends, because the timer outlives the race
 * it lost.
 */
const bound = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

/**
 * Runs the app once and reads a frame back after each step.
 *
 * @param {string} folder the workspace to open
 * @param {{ cols: number, rows: number }} size the frame size, given to the app and to the emulator
 * @param {{ name: string, keys?: string, child?: boolean, childText?: string, afterSync?: boolean }[]} steps the first is the frame before
 *   any key; `child` marks a step whose paint comes from a process the app cannot be asked about
 * @returns {Promise<{ frames: Record<string, object>, exit: object, stderr: string }>}
 */
export async function drive(fixture, size, steps) {
	const { root: folder, userData } = fixture;
	const frames = new Frames(size);
	const child = spawn(process.execPath, ['--import', './bin/bundler-imports.mjs', 'out/src/main.js', folder], {
		cwd: REPO_ROOT,
		// **`VISUAL` as well as `EDITOR`, and that is not belt-and-braces.** `editorCommand()` reads
		// `env['VISUAL'] || env['EDITOR']`, which is the convention every program that reads either
		// follows, so a developer with `VISUAL=vim` exported — a normal thing to have — had their own
		// vim launched into the region instead of the stub. It painted nothing the suite expects and
		// ignored the stub's `Z`, so `editFileExited` timed out and cancelled all 154 tests behind it.
		// The environment is inherited, so **every variable the app reads has to be answered here**,
		// not just the one the fixture happens to think of.
		// **`TSCODE_USER_DATA_DIR` is the same lesson as `VISUAL` above, one directory up.** Without
		// it a driven run resolves `%APPDATA%\dev.tscode.app\User` — the profile the *developer's*
		// tscode is using, because `file.rs`'s `APP_IDENTIFIER` is shared on purpose so that one
		// settings file and keymap are shared with tscode — and writes a log session directory
		// into it on every boot, beside that app's own. `user_data_dir` has carried this override
		// for exactly that reason since it was written, and nothing passed it.
		env: {
			...process.env,
			TUCODE_COLS: String(size.cols),
			TUCODE_ROWS: String(size.rows),
			EDITOR: STUB_EDITOR,
			VISUAL: STUB_EDITOR,
			TSCODE_USER_DATA_DIR: userData,
			// Fixtures live under the real repository, but must never discover or mutate its Git state.
			GIT_CEILING_DIRECTORIES: dirname(folder),
			// Interactive shell tests must not load the developer's zsh configuration or history.
			ZDOTDIR: userData,
			HISTFILE: resolve(userData, 'shell-history')
		},
		stdio: ['pipe', 'pipe', 'pipe']
	});

	/** What the app has painted since the last frame was read, and when the last of it arrived. */
	let painted = '';
	let paintedAt = 0;
	let stderr = '';
	let exit;

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		painted += chunk;
		paintedAt = Date.now();
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', chunk => { stderr += chunk; });

	const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve(exit = { code, signal })));

	/** Waits for `condition`, and turns the run dying or the bound expiring into the failure. */
	async function waitFor(condition, name, what, deadline) {
		while (!condition()) {
			if (exit) {
				throw new Error(`the run exited (${JSON.stringify(exit)}) during step ${name}\n${stderr}`);
			}
			if (Date.now() > deadline) {
				if (process.env.TUCODE_E2E_DUMP) {
					await frames.write(painted.replaceAll(SYNC, ''));
					printFrame(frames.snapshot(), `${name} (timeout)`);
				}
				throw new Error(`step ${name} painted ${painted.length} bytes and ${what} within ${STEP_TIMEOUT} ms\n${stderr}`);
			}
			await delay(POLL);
		}
	}

	const named = {};
	const timings = {};

	/**
	 * The frame the step finished on.
	 *
	 * The app's answer to `SYNC` is the whole of the wait for an ordinary step: it comes after the
	 * step's keys have been dispatched and after `Workbench.whenSettled`, so the bytes in front of
	 * it are the step's complete paint. A step driving a child process waits for the pty's output
	 * to stop as well, because no one can ask a shell whether it has finished.
	 */
	async function read(step, deadline) {
		await waitFor(() => painted.includes(SYNC), step.name, 'never reported settled', deadline);
		if (step.child) {
			// The workbench being finished says nothing about the child, which has not necessarily
			// written a byte yet — so what is waited for is the child writing *and then* stopping.
			// Quiet alone read the screen before a shell had answered; the app's answer alone reads
			// it before the shell has started.
			//
			// **A shell needs a stricter question, and `prompt` is it.** "Wrote, then paused" is
			// answered by PowerShell's *banner*, which it prints before loading a profile and long
			// before it reads stdin — so the step ended, the next step's keys were written into a
			// child that was not listening, and they were dropped with nothing to say so. What says
			// a shell is ready is its prompt, and a prompt carries the cwd: this run's own fixture
			// path, which no other byte of the step can hold. The pty is 300 columns and the prompt
			// is a quarter of that, so the path arrives unwrapped and a raw-byte match is sound.
			//
			// Its failure mode is the point. A shell that never prompts now times out *on this
			// step*, naming it — where before it dropped the next step's keys and failed an
			// assertion three steps later about a screen that looked merely wrong.
			// A short-lived child can write before the workbench's SYNC reply, so its
			// identifying text is searched across the whole step rather than only in
			// later bytes. A process-exit step has no marker; that one explicitly waits
			// for the close repaint after SYNC.
			// Command dispatch does not retain a keybinding handler's promise. The
			// terminal area tracks the opening during that first turn, so a second
			// settlement request is what waits on the newly tracked launch without
			// injecting a user keystroke or stealing desktop focus.
			child.stdin.write(SYNC);
			// Do not count the settlement protocol's own reply as a child repaint.
			// Otherwise an exit step can finish on the second SYNC token while the
			// editor tab is still on screen.
			const answered = painted.replaceAll(SYNC, '').length;
			const ready = () => step.childText ? painted.includes(step.childText)
				: step.prompt ? painted.includes(folder)
					: step.afterSync ? painted.replaceAll(SYNC, '').length > answered
						: true;
			await waitFor(() => ready() && Date.now() - paintedAt >= QUIET, step.name,
				step.prompt ? 'never printed a prompt in the workspace' : 'never heard from the child', deadline);
		}

		// The paint is a diff per repaint, so feeding the emulator this step's bytes leaves it
		// holding what was on screen when the step finished. The answer itself is not screen
		// content, and is taken out rather than left to an emulator to ignore.
		const bytes = painted;
		painted = '';
		await frames.write(bytes.replaceAll(SYNC, ''));

		return frames.snapshot();
	}

	/** Every step in order, each leaving a frame behind. Separated out so the `catch` below is one. */
	async function replay() {
		for (const step of steps) {
			const started = Date.now();
			// The request goes in behind the step's own keys, so the app dispatches it after them —
			// which is what makes the answer a statement about this step rather than about a chunk.
			child.stdin.write(`${step.keys ?? ''}${SYNC}`);
			named[step.name] = await read(step, started + STEP_TIMEOUT);
			timings[step.name] = Date.now() - started;
			log(`${step.name} ${timings[step.name]} ms`);

			// A failure here is about what a cell holds, so `TUCODE_E2E_DUMP=1` prints every frame the
			// way `bin/read-frame.mjs` prints one — the same reading the assertions are made against.
			if (process.env.TUCODE_E2E_DUMP) {
				printFrame(named[step.name], step.name);
			}
		}

		child.stdin.end();
		const timedOut = await Promise.race([exited.then(() => false), bound(EXIT_TIMEOUT).then(() => true)]);
		if (timedOut) {
			throw new Error(`the run did not exit within ${EXIT_TIMEOUT} ms of stdin closing, which is a defect rather than a slow machine\n${stderr}`);
		}
	}

	// **A step that throws has to take the run with it.** Without this the app — and whatever it
	// spawned — outlives the suite: one failing step left `npm run e2e` waiting on a
	// process nothing was going to end, which is the shape §16.7 calls a defect rather than slow
	// work. By PID, and only this one: the user's editor runs under the same name (§16.8).
	try {
		await replay();
	} catch (error) {
		child.kill();
		throw error;
	} finally {
		// The emulator re-arms an idle timer after every write, so a `Frames` nobody lets go of holds
		// this process open for another fifteen seconds after the last frame. Every snapshot taken
		// above is plain objects and does not depend on it.
		frames.dispose();
	}

	return { frames: named, timings, exit, stderr };
}

/**
 * Registers the `before`/`after` that fill and empty `context`, and the assertions about the run
 * itself. Every suite then reads `context.frames[name]` and does no waiting of its own.
 *
 * @param {{ frames: object, fixture: object, run: object }} context handed to every suite
 * @param {object} options
 * @param {() => { root: string, userData: string, dispose: () => void }} options.createFixture
 * @param {{ cols: number, rows: number }} options.size
 * @param {{ name: string, keys?: string, child?: boolean }[]} options.steps
 */
export function registerSession(context, { createFixture, size, steps }) {
	// The wall clock, in the three parts it has: building the workspace, driving the app, and
	// deleting the workspace again. Reported because most of this suite's time is *not* the driven
	// run, and because the third number
	// is where the leaked ConPTY shows up, as `rmSync` retrying against a directory a dead shell
	// still holds.
	before(async () => {
		const started = Date.now();
		context.fixture = createFixture();
		log(`fixture ${context.fixture.root} — built in ${Date.now() - started} ms`);

		const driving = Date.now();
		context.run = await drive(context.fixture, size, steps);
		context.frames = context.run.frames;
		log(`the driven run took ${Date.now() - driving} ms, over ${steps.length} steps`);
	});

	after(() => {
		const started = Date.now();
		context.fixture?.dispose();
		log(`fixture removed in ${Date.now() - started} ms`);
		// A hook is not covered by `--test-timeout`, so an unbounded `after` is where a wedged run
		// hides — and this is the hook that retries `rmSync` against a directory a dead shell holds.
	}, { timeout: 3 * EXIT_TIMEOUT });

	describe('the run', () => {
		it('exits on its own once stdin closes, with nothing on stderr', () => {
			assert.deepEqual(context.run.exit, { code: 0, signal: null });
			assert.equal(unexpectedStderr(context.run.stderr), '', 'the boot reports on stderr as well as to the log, so anything unexpected here is a failed boot');
		});
	});
}
