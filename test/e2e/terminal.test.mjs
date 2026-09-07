// The end-to-end suite for the integrated terminal. One temp directory, one app,
// one launch — the same binary the editor suite drives, opened with no workspace
// so nothing but the terminal is under test.
//
// Run it with `npm run e2e:terminal` against a freshly built app; the harness
// refuses to run against a binary older than the sources it was built from.

import { createTerminalFixture, TERMINAL_PROFILE } from './lib/fixture.mjs';
import { registerSession } from './lib/session.mjs';
import { waitForElement } from './lib/wait.mjs';
import registerTerminalSuite from './suites/terminal.mjs';

/** The key `terminal.integrated.profiles` and `defaultProfile` are read under. */
const PLATFORM_KEY = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'osx' : 'linux');

/**
 * The four settings the suite needs, none of them the default:
 *
 * - `cwd`, because this window has no workspace and a terminal would otherwise
 *   start in the user's home directory rather than anywhere the run owns.
 * - `gpuAcceleration`, because xterm's WebGL renderer draws the buffer to a canvas
 *   and disposes the DOM rows. The rows are what a probe can read.
 * - `enablePersistentSessions`, because this port records no scrollback
 *   (`TerminalSerializer`), so a revived terminal is a fresh shell either way — and
 *   leaving it on means the boot below decides how many terminals exist.
 * - `profiles`, so the dropdown has a profile of the run's own to offer. It names no
 *   default profile, so which shell the window boots with is still the system's.
 */
const settings = cwd => ({
	'terminal.integrated.cwd': cwd,
	'terminal.integrated.gpuAcceleration': 'off',
	'terminal.integrated.enablePersistentSessions': false,
	[`terminal.integrated.profiles.${PLATFORM_KEY}`]: { [TERMINAL_PROFILE.name]: { path: TERMINAL_PROFILE.path } },
	'telemetry.telemetryLevel': 'off'
});

const context = { app: undefined, page: undefined, fixture: undefined };

registerSession(context, {
	binary: 'tscode',
	// One past the editor entry point's, so the two sessions never contend for one port — and off
	// the same `TSCODE_E2E_PORT`, so moving one run off another machine-mate's ports moves both.
	port: Number(process.env.TSCODE_E2E_PORT ?? 9432) + 1,
	createFixture: createTerminalFixture,
	open: async (app, fixture) => {
		// The settings file is the run's own, so it can be written before any boot;
		// the clear is still a boot apart from it because it drops the workbench's
		// persisted storage, which the reload is what rebuilds.
		await app.clearWorkbenchState();
		await app.reload();
		await app.writeUserSettings(settings(fixture.root));
		await app.reload();
		// Nothing opens the panel at boot, so the suite opens it with upstream's own chord —
		// which is a row of `keymap.ts` now, and so survives the keyboard takeover. It used to
		// land on nothing and every step after it read a panel that was never there; the
		// palette stood in until the row existed.
		await app.page.keyboard.press('Control+Backquote');
		await waitForElement(app.page, '.pane-body.integrated-terminal', {
			state: 'visible',
			what: 'Ctrl+` never opened the panel on a terminal view'
		});
	}
});

registerTerminalSuite(context);
