// The terminal: the view, a real shell behind it, the profiles the launch dropdown
// offers, find over the buffer, split, kill, the tab list, the decorations shell
// integration produces, and the panel's own ``Ctrl+` ``.
//
// The order is the panel's own: `tabs.showActions` hides the split and kill
// actions once there is more than one group, so both run while the window still
// holds the one terminal it booted with, the `+` that makes a second follows, and
// the toggle — the only step that takes the view off screen — is last.
//
// **The four find steps are driven by their keys**, not through the palette: each
// is a chord the keyboard takeover had dropped, so pressing it is what proves the
// thing that was reported rather than the way around it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TERMINAL_NEEDLES, TERMINAL_PROFILE } from '../lib/fixture.mjs';
import { focusTerminal, killTerminal, newTerminal, runTerminalCommand, selectTerminalLine, splitTerminal, terminalFind, terminalFindClose, terminalFindStep, terminalGeometry, terminalProfileMenu, terminalSnapshot, toggleTerminalPanel } from '../lib/probes.mjs';
import { waitFor } from '../lib/wait.mjs';

/** The shells `getDefaultSystemShell` and profile detection can land on. */
const SHELL = /^(pwsh|powershell|cmd|bash|sh|zsh|fish)(\.exe)?$/i;

/**
 * The needle on a line of its own. `echo <needle>` puts the needle in the buffer
 * twice — once as the command the shell echoes back, once as its output — and only
 * the second is evidence that the shell ran anything.
 */
const echoed = (pane, needle) => pane.lines.filter(line => line.trim() === needle).length;

const written = pane => pane.lines.filter(Boolean);

const command = needle => `echo ${needle}`;

export default function registerTerminalSuite(context) {
	describe('terminal', () => {
		it('renders the terminal view and spawns a shell', async () => {
			const view = await terminalSnapshot(context.page);
			assert.equal(view.panes.length, 1, `expected one terminal on screen, saw ${JSON.stringify(view.groups)}`);
			assert.ok(view.panes[0].rendered, 'the terminal has no buffer in the DOM');

			// The DOM only proves a terminal was drawn; the operating system is what
			// says there is a shell behind it.
			const owned = context.app.descendants();
			const shells = owned.filter(entry => SHELL.test(entry.name));
			assert.ok(shells.length > 0, `the app owns no shell process; it owns ${JSON.stringify(owned.map(entry => entry.name))}`);
		});

		it('offers the configured profile in the launch dropdown', async () => {
			const actions = await terminalProfileMenu(context.page);
			// The three the menu always carries, so a menu read that found the wrong one — or
			// none — fails as itself rather than as a missing profile.
			assert.ok(actions.includes('New Terminal'), `this is not the launch profile dropdown: ${JSON.stringify(actions)}`);

			// The run's profile has an environment variable where a path goes, and detection
			// validates the executable behind that path before a profile is available at all.
			// So the name is only here if the variable was resolved on the way to detection.
			assert.ok(
				actions.includes(TERMINAL_PROFILE.name),
				`the dropdown offers no ${JSON.stringify(TERMINAL_PROFILE.name)}, so the profile configured as ${JSON.stringify(TERMINAL_PROFILE.path)} was never detected: ${JSON.stringify(actions)}`
			);
		});

		it('puts a typed command\'s output in the buffer', async () => {
			const needle = TERMINAL_NEEDLES.first;
			const after = await runTerminalCommand(context.page, command(needle));
			assert.equal(after.panes.length, 1, 'running a command changed how many terminals are on screen');
			assert.equal(echoed(after.panes[0], needle), 1, `no output line ${JSON.stringify(needle)} in ${JSON.stringify(written(after.panes[0]))}`);
		});

		it('decorates a completed command through shell integration', async () => {
			const needle = TERMINAL_NEEDLES.shellIntegration;
			const after = await runTerminalCommand(context.page, command(needle));
			assert.equal(echoed(after.panes[0], needle), 1, 'the command whose decoration is under test never ran');
			// `DecorationAddon` marks a finished command from the sequences the
			// shell-integration script emits, so a decoration exists only if the script
			// was injected, ran, and its sequences reached the capability store.
			assert.ok(
				after.panes[0].decorations.length > 0,
				`no command decoration after a command completed, so shell integration is not active: ${JSON.stringify(written(after.panes[0]))}`
			);
			assert.ok(
				after.panes[0].decorations.some(className => /codicon-terminal-decoration-/.test(className)),
				`the decorations carry no command outcome: ${JSON.stringify(after.panes[0].decorations)}`
			);
		});

		it('finds a needle in the buffer, counts the matches and steps between them', async () => {
			const needle = TERMINAL_NEEDLES.find;
			// `echo <needle>` leaves the needle in the buffer exactly twice — the command
			// the shell echoed back, and its output — and the needle is this test's alone,
			// so two is the whole scrollback's count and not just the viewport's.
			const after = await runTerminalCommand(context.page, command(needle));
			assert.equal(echoed(after.panes[0], needle), 1, `the command whose matches are under test never ran: ${JSON.stringify(written(after.panes[0]))}`);

			const found = await terminalFind(context.page, needle);
			// The count is `@xterm/addon-search`'s own, reported through
			// `IXtermTerminal.findResult`, so a widget that merely opened cannot produce it.
			assert.equal(found.count, 2, `the find widget answers ${JSON.stringify(found.label)} for a needle the buffer holds twice`);
			// And the highlights are the decorations that same addon drew over the buffer.
			// A match cut across two screen rows is drawn as two of them, so this is a
			// floor rather than an equality.
			assert.ok(found.highlights >= found.count, `the search addon drew ${found.highlights} highlights for ${found.count} matches: ${JSON.stringify(found.decorations)}`);
			assert.ok(found.active >= 1, `no match is the active one, so the search stepped to nothing: ${JSON.stringify(found.decorations)}`);

			const stepped = await terminalFindStep(context.page, 'next');
			assert.equal(stepped.count, 2, `stepping changed how many matches the buffer holds: ${JSON.stringify(stepped.label)}`);
			assert.equal(stepped.index, found.index === 1 ? 2 : 1, `Find Next went from match ${found.index} to ${stepped.index} of ${stepped.count}`);
			assert.ok(stepped.active >= 1, 'the step left no active match');

			// A needle nothing typed into the shell: what the widget reports is a fact
			// about the buffer, so a term that is not in it has to read as none.
			const absent = await terminalFind(context.page, TERMINAL_NEEDLES.findAbsent);
			assert.equal(absent.count, 0, `the find widget answers ${JSON.stringify(absent.label)} for a needle nothing ever typed`);
			assert.equal(absent.highlights, 0, `the search addon left ${absent.highlights} highlights for a term with no matches`);

			assert.equal((await terminalFindClose(context.page)).visible, false);
		});

		it('splits a terminal into two panes of one group', async () => {
			const before = await terminalSnapshot(context.page);
			assert.equal(before.groups.length, 1, 'the split runs against the single group the window booted with');

			const split = await splitTerminal(context.page);
			assert.equal(split.groups.length, 1, 'the split made a new group rather than a new pane');
			assert.equal(split.panes.length, 2, `the split group holds ${split.panes.length} panes`);

			const needle = TERMINAL_NEEDLES.split;
			const after = await runTerminalCommand(context.page, command(needle), { pane: 1 });
			assert.equal(echoed(after.panes[1], needle), 1, `the new pane produced no ${JSON.stringify(needle)}: ${JSON.stringify(written(after.panes[1]))}`);
			assert.equal(echoed(after.panes[0], needle), 0, 'both panes of the split are showing the same buffer');
		});

		it('kills the terminal that is active and leaves the other', async () => {
			// Typing into a pane makes it the active one, and the active one is what
			// `Kill Terminal` takes.
			const needle = TERMINAL_NEEDLES.killed;
			const before = await runTerminalCommand(context.page, command(needle), { pane: 0 });
			assert.equal(before.panes.length, 2, 'the kill runs against the pair the split left');
			assert.equal(echoed(before.panes[0], needle), 1, 'the pane the kill must take never ran its command');

			const after = await killTerminal(context.page);
			assert.equal(after.panes.length, 1, `kill left ${after.panes.length} of 2 panes`);
			assert.equal(echoed(after.panes[0], needle), 0, 'the killed pane is the one still on screen');
			assert.equal(echoed(after.panes[0], TERMINAL_NEEDLES.split), 1, `the surviving pane is neither of the two: ${JSON.stringify(written(after.panes[0]))}`);
		});

		it('creates a second terminal from the + action and lists both', async () => {
			const created = await newTerminal(context.page);
			assert.equal(created.groups.length, 2, 'the + action put the new terminal in the existing group rather than its own');
			assert.equal(created.panes.length, 1, 'the new group shows one terminal, and the other group is hidden behind it');

			const needle = TERMINAL_NEEDLES.second;
			const after = await runTerminalCommand(context.page, command(needle));
			assert.equal(echoed(after.panes[0], needle), 1, `the second terminal produced no ${JSON.stringify(needle)}: ${JSON.stringify(written(after.panes[0]))}`);
			// Its own shell: nothing the first terminal ran can answer for it.
			assert.equal(echoed(after.panes[0], TERMINAL_NEEDLES.first), 0, 'the second terminal is showing the first terminal\'s output');

			// The tab list appears at the second terminal — `tabs.hideCondition` is
			// `singleTerminal` — so this is also what proves there are two.
			assert.equal(after.tabs.length, 2, `the tab list shows ${JSON.stringify(after.tabs.map(tab => tab.label))}`);
			assert.equal(after.tabs.filter(tab => tab.active).length, 1, `exactly one tab is the active one: ${JSON.stringify(after.tabs)}`);
		});

		// **The keys the panel had lost to its own shell.** `copySelection`, `copyAndClearSelection`
		// and `paste` are all in `commandsToSkipShell`, so while their rules were dropped the
		// workbench never saw the chord, xterm kept it, and the shell ate it.
		//
		// The copy is what this step drives, and the *clearing* is the whole reading: with a
		// selection, bare `Ctrl+C` is `copyAndClearSelection` and the selection goes; without one,
		// upstream's own guard leaves the chord to the shell as the interrupt it always was.
		it('copies a selection on Ctrl+C, and leaves the chord to the shell without one', async () => {
			const needle = TERMINAL_NEEDLES.clipboard;
			const before = await runTerminalCommand(context.page, command(needle));
			assert.equal(echoed(before.panes[0], needle), 1, `the command whose output is copied never ran: ${JSON.stringify(written(before.panes[0]))}`);

			// The output line, which the shell wrote on a row of its own.
			const selected = await selectTerminalLine(context.page, needle);
			assert.ok(selected.selected > 0, 'the drag selected nothing, so there is nothing for Ctrl+C to take');

			await context.page.keyboard.press('Control+c');
			await terminalGeometry(context.page, state => state.selected === 0, { what: '`Ctrl+C` never cleared the selection it copied' });

			// The other side of the same key, without which this would pass on a `Ctrl+C` the
			// workbench swallows whole: with nothing selected the guard fails, xterm keeps the chord
			// and the shell answers it by interrupting the line that was being typed.
			const typed = TERMINAL_NEEDLES.interrupt;
			// The last line the shell has written to, which is the prompt the user is standing at —
			// an interrupt leaves what it took behind in the scrollback and opens a *new* prompt, so
			// "the buffer no longer holds it" would be true of nothing.
			const atPrompt = async () => (await terminalSnapshot(context.page)).panes[0].lines.filter(Boolean).at(-1).includes(typed);
			await context.page.keyboard.type(typed);
			await waitFor(async () => await atPrompt() || undefined, { what: `the shell to echo ${JSON.stringify(typed)} at the prompt` });

			await context.page.keyboard.press('Control+c');
			await waitFor(async () => await atPrompt() ? undefined : true,
				{ what: '`Ctrl+C` with no selection never reached the shell, so the typed line is still at the prompt' });
		});

		// **The other half of the clipboard, and the only surface in this frontend with a paste
		// key.** Everywhere else the user can type, the browser pastes into the focused editable by
		// itself; a terminal has no editable, so `Ctrl+V` is claimed and the paste is performed by a
		// command — `pastePwsh` where a PowerShell shell is running, `paste` otherwise, both of
		// which upstream registers on this chord.
		//
		// The needle is never typed, so a prompt holding it can only have been pasted there — and
		// nothing is run, because what is under test is the clipboard reaching the line editor
		// rather than the shell reaching a command. The read behind it is `launchApp`'s granted
		// permission: without one WebView2 leaves `readText` hanging, which is `TODO.md`'s entry
		// and not something this step can assert around.
		it('pastes the clipboard at the prompt on Ctrl+V', async () => {
			const needle = TERMINAL_NEEDLES.paste;
			await focusTerminal(context.page);
			await context.page.evaluate(text => navigator.clipboard.writeText(text), needle);

			await context.page.keyboard.press('Control+v');
			await waitFor(async () => (await terminalSnapshot(context.page)).panes[0].lines.filter(Boolean).at(-1).includes(needle) || undefined,
				{ what: `\`Ctrl+V\` never put ${JSON.stringify(needle)} at the prompt` });

			// Leave the prompt as it was found: an unrun line would otherwise be the first thing
			// every later step's own command is appended to.
			await context.page.keyboard.press('Control+c');
		});

		// The other half of what `commandsToSkipShell` names and the takeover had dropped: paging the
		// buffer.
		//
		// **What is read is the rendered rows, not a scroll offset.** xterm draws the viewport
		// through its own scrollable element rather than by moving a `scrollTop`, so the honest
		// question about a page key is which lines are on screen — and a line the shell has pushed
		// out of view coming back is exactly what a page up is for.
		it('pages the buffer on Shift+PageUp and comes back on Shift+PageDown', async () => {
			const page = context.page;
			const needle = TERMINAL_NEEDLES.scroll;
			const onScreen = state => state.panes[0].lines.some(line => line.includes(needle));
			const shown = await runTerminalCommand(page, command(needle));
			assert.ok(onScreen(shown), `the line to be paged back to was never written: ${JSON.stringify(written(shown.panes[0]))}`);

			// Empty prompts until it has gone: how many rows the pane holds is the window's business
			// and not this step's, so the buffer is pushed until it says so rather than by a count.
			await focusTerminal(page);
			const pushed = await waitFor(async () => {
				for (let line = 0; line < 5; line++) {
					await page.keyboard.press('Enter');
				}
				const state = await terminalSnapshot(page);

				return onScreen(state) ? undefined : state;
			}, { what: `empty prompts to push ${JSON.stringify(needle)} out of view` });
			assert.ok(pushed.panes[0].lines.length > 1, 'the pane holds no rows at all');

			await page.keyboard.press('Shift+PageUp');
			await waitFor(async () => onScreen(await terminalSnapshot(page)) ? true : undefined,
				{ what: '`Shift+PageUp` never paged back to the line the prompts pushed out of view' });

			await page.keyboard.press('Shift+PageDown');
			await waitFor(async () => onScreen(await terminalSnapshot(page)) ? undefined : true,
				{ what: '`Shift+PageDown` never paged back down' });
		});

		// The groups the `+` action just made a second of, stepped with upstream's own chords — the
		// last pair `commandsToSkipShell` names and the takeover had dropped, so `Ctrl+PageDown` in
		// a terminal reached neither the workbench nor the shell.
		it('steps between terminal groups on Ctrl+PageDown and Ctrl+PageUp', async () => {
			const page = context.page;
			const activeTab = state => state.tabs.findIndex(tab => tab.active);
			const before = await terminalSnapshot(page);
			assert.equal(before.tabs.length, 2, `the step runs against the two groups the + action left: ${JSON.stringify(before.tabs)}`);

			const start = activeTab(before);
			const steppedTo = async (chord, holds, what) => {
				await focusTerminal(page);
				await page.keyboard.press(chord);

				return waitFor(async () => {
					const state = await terminalSnapshot(page);
					return holds(activeTab(state)) ? state : undefined;
				}, { what });
			};

			const next = await steppedTo('Control+PageDown', index => index !== start, '`Ctrl+PageDown` never moved the active terminal group');
			assert.notEqual(activeTab(next), start, 'the active group did not move');
			await steppedTo('Control+PageUp', index => index === start, '`Ctrl+PageUp` never went back to the group `Ctrl+PageDown` came from');
		});

		// Last, because it is the only step that takes the panel off screen, and every step above
		// reads the view it would have taken with it.
		it('puts the panel away and brings it back on Ctrl+`', async () => {
			const before = await terminalSnapshot(context.page);

			const gone = await toggleTerminalPanel(context.page, { expect: 'gone' });
			assert.equal(gone.present, false, 'the panel is still on screen');

			const back = await toggleTerminalPanel(context.page, { expect: 'back' });
			assert.equal(back.groups.length, before.groups.length, 'the terminals did not survive the panel closing');
			assert.ok(back.panes.every(pane => pane.rendered), 'a terminal came back with no buffer in the DOM');
		});
	});
}
