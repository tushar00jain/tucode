// The floating layer: a row's actions, a confirmation, and a picker — plus the status bar under them.
//
// Each of these is a *surface* rather than a pane, so the assertions are about what is drawn over the
// workbench and what it holds: the actions are `MenuService`'s answer for the focused row, the
// confirmation is `AbstractDialogHandler`'s buttons, and the picks are `RepositoryPicker`'s. None of
// the three is a table this suite or the frontend keeps.
//
// Upstream counterpart: none — tscode reaches all three with a pointer, so its own suites assert on a DOM node rather than on the rows a floating layer covered.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QUICK_OPEN_FILE, REPOSITORIES } from '../lib/fixture.mjs';
import { editorRows, editorTabs, overlayBox, selectedRow, sideBarLines, sideBarTitle, statusLine, withoutCaret } from '../lib/probes.mjs';
import { themeColourOver } from '../lib/theme.mjs';

/** What a selected list row is drawn in — the colour a click's only visible effect lands as. */
const SELECTED_BACKGROUND = themeColourOver('list.activeSelectionBackground', 'sideBar.background');

/** The box, asserted — every test below is about something on the floating layer. */
function box(frame, name) {
	const overlay = overlayBox(frame);
	assert.ok(overlay, `no overlay on the ${name} frame`);

	return overlay;
}

/** What the box says, row by row — the caret off, since it is where focus is and not what it holds. */
const labels = overlay => overlay.rows.map(row => withoutCaret(row.text.trim())).filter(text => text.length > 0);

export default function registerInteractionSuite(context) {
	describe('the floating layer', () => {
		it('offers the focused row its own actions on Shift+F10', () => {
			const menu = box(context.frames.contextMenu, 'contextMenu');
			const actions = labels(menu);

			// A staged change: what `git.contribution.ts` declares for `MenuId.SCMResourceContext`
			// inside the index group, minus the inline ones `collectContextMenuActions` drops.
			assert.ok(actions.includes('Open Changes'), `the menu holds ${JSON.stringify(actions)}`);
			assert.ok(actions.includes('Unstage Changes'), `the menu holds ${JSON.stringify(actions)}`);
			assert.ok(!actions.includes('Stage Changes'), 'a staged change cannot be staged again');
		});

		it('closes on Escape, giving the rows it covered back', () => {
			assert.equal(overlayBox(context.frames.menuClosed), null);

			// The rows the box was over are the pane's again: the resources it hid are back, and no
			// cell of it survives anywhere. A layer that painted into the pane rather than over it
			// fails here rather than three frames later.
			const lines = sideBarLines(context.frames.menuClosed).map(line => line.text);
			assert.ok(lines.some(text => text.includes('tracked.txt')), `the rows the menu covered: ${JSON.stringify(lines)}`);
			assert.ok(!lines.some(text => /[┌┐└┘]/.test(text)), 'a corner of the menu survived it');
		});

		it('offers Discard Changes on a working-tree row, which A1 could not bind to a key', () => {
			const actions = labels(box(context.frames.discardMenu, 'discardMenu'));

			assert.ok(actions.includes('Discard Changes'), `the menu holds ${JSON.stringify(actions)}`);
			assert.ok(actions.includes('Stage Changes'), `the menu holds ${JSON.stringify(actions)}`);
		});

		it('asks before it throws work away, and does not throw it away when the answer is no', () => {
			const prompt = labels(box(context.frames.discardPrompt, 'discardPrompt'));

			assert.ok(prompt.some(line => line.includes('discard changes in tracked.txt')), `the prompt says ${JSON.stringify(prompt)}`);
			assert.ok(prompt.includes('Discard Changes'), `the primary button: ${JSON.stringify(prompt)}`);
			assert.ok(prompt.includes('Cancel'), `the cancel button: ${JSON.stringify(prompt)}`);

			// Escaping is `cancelId`, so the file is still there and still modified — which is the
			// discriminating half: a confirmation that ran the command anyway would empty the row.
			assert.equal(overlayBox(context.frames.discardCancelled), null);
			assert.ok(sideBarLines(context.frames.discardCancelled).some(line => line.text.includes('tracked.txt M')),
				'tracked.txt is no longer a modified row after the discard was declined');
		});

		// **The confirmed half, and it is about the frame rather than about git.** Answering the same
		// question yes ran `git.clean`, which changed a file on disk, which evicted the model made
		// from it — and the editor drawing that model then threw `Model is disposed!` out of every
		// `renderRow`, so out of every `Workbench.paint`. An `Emitter` gives a listener's exception
		// to `onUnexpectedError`, so the app went on taking keys with a frame that never changed
		// again: the worst shape this app has, because the changes are gone and the screen says
		// nothing. So what is asserted is that the *next* frames are alive, not only that the row went.
		it('keeps painting after a destructive command has run', () => {
			assert.equal(overlayBox(context.frames.discardDone), null, 'the confirmation is still up after it was answered');

			// Word by word, because `untracked.txt` is still a row and holds the name as a substring.
			const after = sideBarLines(context.frames.discardDone).map(line => line.text);
			assert.ok(!after.some(text => text.split(/\s+/).includes('tracked.txt')), `tracked.txt survived the discard: ${JSON.stringify(after)}`);

			// The discriminating half: a frozen frame would still hold the *previous* step's rows,
			// which is what every later assertion in this run would then be reading. The repository
			// picker opening over it is a paint that could only have happened afterwards.
			const picker = labels(box(context.frames.repositoryPicker, 'repositoryPicker'));
			assert.ok(picker.length > 0, 'nothing painted after the discard');
		});

		it('asks which repository through a quick pick, and filters it as it is typed', () => {
			const picker = box(context.frames.repositoryPicker, 'repositoryPicker');
			const rows = labels(picker);

			assert.ok(rows.some(row => row.includes('Select the active repository')), `the picker says ${JSON.stringify(rows)}`);
			assert.ok(rows.some(row => row.startsWith('Auto')), `upstream's own first pick is missing: ${JSON.stringify(rows)}`);
			for (const repository of REPOSITORIES) {
				assert.ok(rows.some(row => row.startsWith(repository)), `${repository} is not offered: ${JSON.stringify(rows)}`);
			}

			// Typing filters through `matchesFuzzyIconAware`, so `gam` leaves one repository.
			const filtered = labels(box(context.frames.pickerFiltered, 'pickerFiltered'));
			assert.ok(filtered.some(row => row.startsWith('gamma')), `filtered to ${JSON.stringify(filtered)}`);
			for (const repository of REPOSITORIES.filter(name => name !== 'gamma')) {
				assert.ok(!filtered.some(row => row.startsWith(repository)), `${repository} survived the filter: ${JSON.stringify(filtered)}`);
			}

			assert.equal(overlayBox(context.frames.pickerCancelled), null);
		});

		it('is where the keyboard is, so the status line says what its keys are', () => {
			assert.match(statusLine(context.frames.contextMenu).text, /Enter Run · Escape Close/);
			assert.match(statusLine(context.frames.repositoryPicker).text, /Enter Select · Escape Cancel/);
		});
	});

	// The usability pass's item 7, which turned out not to be a defect at all: `Workbench.handleMouse`
	// routes per part exactly as phase G left it, through the pipe *and* through a real ConPTY. What
	// it had was no instrument, and — until item 5 was fixed — no visible answer either, because the
	// only thing a click on a row changes is the cursor row's colour and that colour was white on
	// white. These are the instrument.
	describe('the mouse', () => {
		it('routes a click on the activity bar to the container that entry names', () => {
			assert.ok(sideBarTitle(context.frames.mouseExplorer).startsWith('EXPLORER'), `the first entry showed ${sideBarTitle(context.frames.mouseExplorer)}`);
			assert.ok(sideBarTitle(context.frames.mouseSourceControl).startsWith('SOURCE CONTROL'), `the third entry showed ${sideBarTitle(context.frames.mouseSourceControl)}`);
		});

		it('moves the cursor to the row a click landed on', () => {
			// Row 3 of the side bar: the title is 0, `CHANGES` is the view's header, and the click was
			// two rows into the list. A click routed to the wrong part, or off by the header, lands
			// somewhere else and this says which row it did land on.
			assert.equal(selectedRow(context.frames.mouseRow, SELECTED_BACKGROUND).row, 3);
		});

		// **What a wheel notch cannot be asserted to do here is scroll**, and that is the fixture
		// rather than the routing: nothing this workspace produces is longer than the 90 rows the run
		// paints, so every pane's scroll position is clamped at zero and a notch has nowhere to go.
		// (It was read back scrolling in a 30-row run, and through a real ConPTY — see `§14.3`.) What
		// *is* discriminating at this size is the decode: `input.ts` reads bit 6 of the button as the
		// wheel flag, so a report that lost it would arrive as a press and drag the cursor to the row
		// under the pointer.
		it('reads a wheel notch as a wheel rather than as a press on the row under it', () => {
			assert.equal(selectedRow(context.frames.mouseWheel, SELECTED_BACKGROUND).row, 3, 'the wheel moved the cursor, so it was decoded as a click');
			assert.deepEqual(
				sideBarLines(context.frames.mouseWheel).map(line => line.text),
				sideBarLines(context.frames.mouseRow).map(line => line.text));
		});
	});

	// Pasted text, which is the one input that must not reach the keybinding resolver. Until
	// `screen.ts` asked for bracketed paste there was nothing to tell it from typed text, and a
	// paste beginning `t` opened a shell and wrote the rest of the clipboard into it.
	// The other half of this pair is in `search.mjs`: an
	// input that *does* have focus still takes one.
	describe('a paste', () => {
		it('does nothing at all where nothing is taking text, whatever is in it', () => {
			assert.deepEqual(
				context.frames.pasteIgnored.lines.map(line => line.text),
				context.frames.explorer.lines.map(line => line.text));
		});

		it('opens no editor, which is what every character of it was bound to do', () => {
			assert.deepEqual(editorTabs(context.frames.pasteIgnored), []);
		});
	});

	// Quick access, which is a second registry beside `IQuickInputService` and needs a provider of
	// its own — without one `quickAccess` throws saying so. These are about the two gestures it
	// gives: every command upstream offers in its palette, and the workspace's files by name.
	describe('quick access', () => {
		it('opens the command palette on F1, listing commands with the keys that run them', () => {
			const palette = box(context.frames.commandPalette, 'commandPalette');
			const rows = labels(palette);

			// The filter box holds the provider's prefix, which is what `QuickAccessController` puts
			// there and what `filterValue` then keeps out of the matching.
			assert.equal(rows[0], '>', `the palette's filter box reads ${JSON.stringify(rows[0])}`);

			// Upstream's own `Action2`s, reached through `MenuId.CommandPalette` — and the second is
			// drawn with the key `lookupKeybinding` resolved for it, which is the whole point of a
			// palette in a UI whose keys are otherwise only on the status line.
			assert.ok(rows.some(row => row === 'Clear Command History'), `the palette holds ${JSON.stringify(rows)}`);
			assert.ok(rows.some(row => /^Go to File\.\.\.\s+(?:Ctrl\+P|⌃\s+P)$/.test(row)), `no keybinding column: ${JSON.stringify(rows)}`);
		});

		it('filters through the commands provider, not through the box', () => {
			// `AbstractCommandsQuickAccessProvider` turns the box's own matching off and filters for
			// itself with `matchesBaseContiguousSubString | matchesWords` — so `clear com` matches
			// two separate words of one label, which the box's fuzzy filter alone would also have to
			// see through the `>` prefix it never receives.
			const rows = labels(box(context.frames.paletteFiltered, 'paletteFiltered'));

			assert.equal(rows[0], '>clear com', `the filter box reads ${JSON.stringify(rows[0])}`);
			assert.deepEqual(rows.slice(1), ['Clear Command History'], `filtered to ${JSON.stringify(rows)}`);
		});

		it('runs the command it accepted, which is the thing a palette is for', () => {
			// `workbench.action.clearCommandHistory` is bound to no key in this fork, so the only way
			// to this frame is the palette having dispatched it: what it does is ask first, through
			// the same `IDialogService.confirm` the discard flow above uses.
			const prompt = labels(box(context.frames.paletteRan, 'paletteRan'));

			assert.ok(prompt.some(line => line.includes('clear the history of recently used commands')),
				`the palette ran nothing: ${JSON.stringify(prompt)}`);
			assert.ok(prompt.includes('Cancel'), `the confirmation's buttons: ${JSON.stringify(prompt)}`);
			assert.equal(overlayBox(context.frames.paletteCancelled), null, 'Escape did not close it');
		});

		it('opens the file picker on Ctrl+P, with each file\'s folder beside its name', () => {
			const picker = box(context.frames.quickOpen, 'quickOpen');

			// An empty query is no search: upstream's `getFilePicks` returns nothing for a query with
			// no normalized form, so the box opens on its placeholder alone.
			assert.deepEqual(labels(picker), ['Search files by name'], `the picker holds ${JSON.stringify(labels(picker))}`);

			const rows = labels(box(context.frames.quickOpenFiltered, 'quickOpenFiltered'));
			assert.equal(rows[0], QUICK_OPEN_FILE.name, `the filter box reads ${JSON.stringify(rows[0])}`);
			assert.ok(rows.slice(1).some(row => new RegExp(`^${QUICK_OPEN_FILE.name}\\s+${QUICK_OPEN_FILE.folder}$`).test(row)),
				`${QUICK_OPEN_FILE.name} is not offered out of ${QUICK_OPEN_FILE.folder}: ${JSON.stringify(rows)}`);
		});

		it('opens the file it accepted as an editor', () => {
			const frame = context.frames.quickOpenOpened;

			assert.equal(overlayBox(frame), null, 'the picker is still up');
			assert.ok(editorTabs(frame).some(tab => tab.name === QUICK_OPEN_FILE.name),
				`the strip holds ${JSON.stringify(editorTabs(frame).map(tab => tab.name))}`);
			// The file's own text, so this is the editor having read it rather than a tab with a name
			// on it — and the settle handshake is what makes that assertable in the accepting step.
			assert.ok(editorRows(frame).some(row => row.includes(QUICK_OPEN_FILE.line)),
				`the editor shows ${JSON.stringify(editorRows(frame).slice(0, 3))}`);
		});
	});

	describe('the keys overlay', () => {
		it('shows every key that applies, including the ones the status line has no room for', () => {
			const rows = labels(box(context.frames.keysOverlay, 'keysOverlay'));

			// The `tabs` scope, which is on no status line by design and was therefore undiscoverable:
			// the digits that switch containers, `Shift+Tab`, and hiding the side bar.
			assert.ok(rows.some(row => /^Ctrl\+B\s+Toggle Primary Side Bar/.test(row)), `the overlay holds ${JSON.stringify(rows)}`);
			assert.ok(rows.some(row => /^Shift\+Tab\s/.test(row)), `the overlay holds ${JSON.stringify(rows)}`);
			// And the pane's own, so the list is the focused part's rather than a fixed table.
			assert.ok(rows.some(row => /^V\s+List\/Tree/.test(row)), `the source control keys are missing: ${JSON.stringify(rows)}`);

			assert.equal(overlayBox(context.frames.keysClosed), null, 'Escape did not close it');
		});

		it('is the last thing on the status line, so a row that runs out of room keeps the way in', () => {
			// The row is built back-to-front for this reason: what does not fit is dropped from the
			// *middle*, never the pointer at the end. A frame with an overlay says the overlay's keys
			// instead, and a frame whose child process has the keyboard says only what still reaches it.
			for (const [name, frame] of Object.entries(context.frames)) {
				const text = statusLine(frame).text.trimEnd();
				// An overlay says its own keys; a child process holding the keyboard says only what
				// still reaches the workbench; a **vim buffer** holding it is the same state by the
				// same mechanism (`Pane.editing`, §19.5); and a text input holding it takes every
				// rule scoped out of `inputFocus` with it, which is what `Escape Stop Editing` is
				// the marker of.
				if (overlayBox(frame) || text.includes('keys go to the process') || text.includes('vim:') || text.includes('Stop Editing')) {
					continue;
				}

				assert.ok(text.endsWith('Shift+/ Keys'), `${name} ends with ${JSON.stringify(text.slice(-40))}`);
				assert.ok(text.length <= frame.cols, `${name} is ${text.length} columns of a ${frame.cols}-column frame`);
			}
		});
	});

	describe('the status bar', () => {
		it('carries the active repository, before the keys the workbench answers', () => {
			// Two entries, and their order is `StatusbarViewModel`'s: `status.scm.provider` is
			// positioned *relative to* `status.scm.0` and to its left, which is what
			// `SCMActiveRepositoryController` asks for and nothing here decides. `alpha` is the
			// provider's name; `main` is `TauriGitSCMProvider.buildStatusBarCommands`' branch, with
			// the `*` it adds for a repository that has changes.
			assert.match(statusLine(context.frames.scm).text, /^\s*alpha\s+\S+\*\s+↑↓→← move/);
		});

		// The explorer's own key comes before the workbench's, which is `keyEntries`' scope order —
		// and it is the only place `workbench.files.action.collapseExplorerFolders` announces itself,
		// since upstream reaches it from a title-bar icon a terminal does not draw.
		it('carries it whatever pane has focus, and names the focused pane\'s own keys first', () => {
			const text = statusLine(context.frames.explorer).text;
			assert.match(text, /^\s*alpha\s+\S+\*\s+↑↓→← move · \/ Filter · C Collapse Folders in Explorer/);
			assert.ok(text.indexOf(' · Q Quit') > text.indexOf('C Collapse Folders in Explorer'),
				`the Explorer action must precede global actions: ${JSON.stringify(text)}`);
		});

		// The navigation a pane inherits names the keys `Pane.handleKey` answers, and `←`/`→` are not
		// among them: they are the *tree's* collapse and expand, which the two rows above have and the
		// commit-info drawer — a flat list — does not. Offering them there sent the user looking for a
		// horizontal scroll that is on `Ctrl`+`←→`, and which the same row names.
		it('names `←→` only where a row folds, and the scroll key where it does not', () => {
			const drawer = statusLine(context.frames.commitInfo).text;
			assert.ok(drawer.includes('↑↓ move'), `the drawer's keys are ${JSON.stringify(drawer)}`);
			assert.ok(!drawer.includes('↑↓→←'), `the drawer offers a fold it does not have: ${JSON.stringify(drawer)}`);
			assert.ok(drawer.includes('Scroll Right'), `the drawer does not name the key that scrolls it: ${JSON.stringify(drawer)}`);
		});
	});
}
