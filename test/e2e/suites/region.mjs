// The embedded region: a child process in a pty, painted into the editor area's rectangle.
//
// What this suite is about is the *composition* — a real child running inside a frame the workbench
// still owns — so every assertion is a pair: something of the child's is on screen, and something of
// tucode's that the child could have painted over is still there.
//
// The child is whatever `getDefaultSystemShell` answers on the machine the suite runs on, so nothing
// here names a shell or a prompt format. What it names is the workspace path (the cwd the region was
// given), the text the shell was told to echo, and the tab the editor area drew for it.
//
// Upstream counterpart: none — a terminal is a widget in a window upstream, so there is no suite that reads one back as cells.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENCODED_FILE, README } from '../lib/fixture.mjs';
import { activeTab, activityEntries, dividerColumn, editorRows, editorTabs, statusLine } from '../lib/probes.mjs';
import { themeColour } from '../lib/theme.mjs';

/** `tab.activeBackground` in the loaded theme, which is the only mark an active tab carries. */
const ACTIVE_TAB = themeColour('tab.activeBackground');

/** What the shell was told to say, which is the string only the *child* could have put on screen. */
const ECHOED = 'quit-is-not-quit';

/** Everything the region painted, as one string — the shell's prompt wraps and its rows do not. */
const regionText = frame => editorRows(frame).join('\n');

export default function registerRegionSuite(context) {
	describe('the embedded region', () => {

		it('opens the shell as a tab in the editor area, named after the executable', () => {
			// The *active* tab rather than the last one: `EditorGroupModel` inserts a new editor to the
			// right of the active one, which is `openPositioning`'s default and not the end of the strip.
			const shell = activeTab(context.frames.terminalEditor, ACTIVE_TAB);

			assert.ok(shell, 'no tab is active after `T`, so nothing was opened');
			// The label is the executable the backend discovered, so the only portable claim about it
			// is that it is a path to something — which is more than the empty string a failed launch
			// would leave, and different from every file tab in this fixture.
			assert.match(shell.name, /[\\/]/, `the active tab is "${shell.name}", which is not an executable path`);
		});

		it('runs the child in the workspace, and paints what it wrote', () => {
			const text = regionText(context.frames.terminalEcho);

			assert.ok(text.length > 0, 'the region painted nothing, so the child produced no output or none of it was read back');
			assert.ok(text.includes(context.fixture.root), `the region does not show the workspace path, so the cwd did not reach the pty:\n${text}`);
		});

		it('sends a keystroke to the child rather than to the workbench', () => {
			// `q` is `tscode.quit` everywhere else in this frontend. Three of them are typed here, and
			// what comes back is the shell's own echo of the whole word — which cannot happen unless
			// the bytes went to the pty.
			const text = regionText(context.frames.terminalEcho);

			assert.ok(text.split('\n').some(row => row.trim() === ECHOED), `the child never echoed "${ECHOED}":\n${text}`);
		});

		it('keeps drawing the workbench around the child', () => {
			// The failure this catches is the region painting the whole row, which is what a child in a
			// pty of the wrong width would do — and it is the same failure the flat tab bar was.
			for (const name of ['terminalEditor', 'terminalEcho', 'terminalLive']) {
				const frame = context.frames[name];

				assert.notEqual(dividerColumn(frame), -1, `${name} painted over the divider`);
				assert.ok(activityEntries(frame).length > 0, `${name} painted over the activity bar`);
			}
		});

		it('names only the keys that still reach the workbench while the child has the keyboard', () => {
			const attached = statusLine(context.frames.terminalEcho).text;

			assert.match(attached, /Ctrl\+W Close Editor/, `the escape gesture is not on the status line: ${attached}`);
			// `Q Quit` is on it in every other frame of this run; offering it here would be a lie,
			// because `commandsToSkipShell` does not hold `tscode.quit` and the child gets the key.
			assert.doesNotMatch(attached, /Q Quit/, `the status line offers a key the child swallows: ${attached}`);
		});

		// `tscode.editFile`, which is the usability pass's item 8 — and the defect was one argument: the
		// launch carried no environment for `find_executable`, so a `$EDITOR` that is a bare command
		// name (which is what every `$EDITOR` is) resolved to nothing. The child then "exited 0" having
		// painted nothing, because the launch error was written to an emulator that was read before it
		// had parsed it. Both halves are asserted here: the child ran, and it says which file it was
		// given.
		it('opens the file in $EDITOR, resolving a bare executable name off PATH', () => {
			const text = regionText(context.frames.editFile);

			assert.match(text, /EDITOR-OPENED:/, `$EDITOR painted nothing: ${JSON.stringify(text)}`);
			assert.match(text, new RegExp(`EDITOR-OPENED:.*${README.name}`), `$EDITOR was not given the open file: ${JSON.stringify(text)}`);
		});

		it('sends the keys an editor needs to the child rather than to the workbench', () => {
			// `q` is `tscode.quit`, `Escape` leaves an input and `Tab` walks the editor strip in every
			// other frame of this run. A real editor needs all three, so all three go to the child —
			// which is `commandsToSkipShell` deciding it, not a mode. The stub echoes what it read, and
			// the chunk boundaries are the pty's, so the payloads are joined before they are compared.
			const chunks = [...regionText(context.frames.editFileKeys).matchAll(/EDITOR-SAW:"([^"]*)"/g)].map(match => match[1]);

			assert.equal(chunks.join(''), 'iqq\\u001b\\t', `the child read ${JSON.stringify(chunks)}`);
		});

		it('closes the editor region back to the file it was editing', () => {
			assert.deepEqual(editorTabs(context.frames.editFileClosed).map(tab => tab.name), [ENCODED_FILE, README.name]);
			assert.ok(!regionText(context.frames.editFileClosed).includes('EDITOR-OPENED'), 'the closed region is still on screen');
		});

		it('edits a second time without keeping the first edit\'s region', () => {
			// The strip is the whole claim: three tabs while the child runs, and the third is the
			// region — so a second edit in the same session is a second *process*, never a second
			// retained region stacked on the first.
			assert.equal(editorTabs(context.frames.editFileAgain).length, 3);
			assert.match(regionText(context.frames.editFileAgain), /EDITOR-OPENED:/);
		});

		it('closes the tab when the child quits on its own', () => {
			// Upstream's `_onProcessExit` disposes a terminal whose process exited and that has no
			// `waitOnExit`, and disposing a terminal *editor* closes its tab. Without it a session's
			// edits leave one dead region each, holding an emulator buffer nothing will read again.
			assert.deepEqual(editorTabs(context.frames.editFileExited).map(tab => tab.name), [ENCODED_FILE, README.name]);
			assert.ok(!regionText(context.frames.editFileExited).includes('EDITOR-OPENED'), 'the exited region is still on screen');
		});

		it('closes the tab and the child together', () => {
			const before = editorTabs(context.frames.terminalEcho).length;
			const after = editorTabs(context.frames.terminalClosed);

			assert.equal(after.length, before - 1, 'Ctrl+W did not close the terminal editor');
			assert.ok(!regionText(context.frames.terminalClosed).includes(ECHOED), 'the closed region is still on screen');
		});
	});
}
