// The arrangement: which parts are on screen, where, and what is inside each of them.
//
// This suite exists because layout is the one property of this build that drifted, and it drifted
// precisely because it had no instrument while everything else did — five phases shipped a flat tab
// bar in which the explorer, the search results and an open file were peers, and every suite passed
// the whole time. So what is asserted here is *arrangement*, not content: that there is a side bar
// column with one view container in it, a divider, and an editor area with a tab per open editor.
//
// The numbers a part is measured against are ratios rather than counts wherever upstream's own
// declaration is a ratio, so a change to the frame size is not a change to this file.
//
// Upstream counterpart: none — arrangement is the property this fork had to rebuild, so there is no upstream suite for it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENCODED_FILE, README, REPOSITORIES } from '../lib/fixture.mjs';
import {
	activityEntries, collapsedViews, dividerColumn, editorLines, editorRows, editorTabs, overlayBox, regionLines,
	sideBarLines, sideBarTitle, statusLine, viewHeaders, viewRules
} from '../lib/probes.mjs';
import { themeColour } from '../lib/theme.mjs';

/** What `tab.activeBackground` is in the loaded theme, which is the only mark an active tab carries. */
const ACTIVE_TAB = themeColour('tab.activeBackground');

/** The view containers `views.ts` registers into the side bar, in `order`. */
const CONTAINERS = ['EXPLORER', 'SEARCH', 'SOURCE CONTROL', 'SAPLING'];

const names = frame => editorTabs(frame).map(tab => tab.name);

/** Which side bar row a named view's header is drawn on — only a header is uppercase on its own. */
const headerRow = (frame, name) => sideBarLines(frame).findIndex(line => line.text.trim().endsWith(name));
const active = frame => editorTabs(frame).find(tab => tab.bg === ACTIVE_TAB);

export default function registerLayoutSuite(context) {
	describe('the arrangement', () => {
		it('draws an activity bar, a side bar, a divider and an editor area', () => {
			const frame = context.frames.explorer;
			const divider = dividerColumn(frame);

			assert.notEqual(divider, -1, 'there is no divider column, so the side bar and the editor area are not side by side');

			// A quarter of the frame is what upstream's `SIDEBAR_SIZE.defaultValue` asks for; the bound
			// is a range rather than the formula, so this fails on "the side bar took the screen" and
			// not on a change of one column.
			assert.ok(divider > frame.cols / 8 && divider < frame.cols / 2, `the divider is at column ${divider} of ${frame.cols}`);
			assert.ok(frame.cols - divider > divider, 'the editor area is narrower than the side bar');
		});

		it('keeps the divider in the same column through every pane and every gesture', () => {
			// The failure this catches is a pane painting the whole row, which is what the flat tab bar
			// did: the divider is only a divider if it survives whatever any pane draws.
			//
			// **A frame with something on the floating layer is excluded, and that is the rule rather
			// than an exemption**: an overlay is the one thing in this frontend that may paint across a
			// part, which is what a context view is. A *pane* still may not, and every frame without one
			// is checked.
			const columns = Object.entries(context.frames)
				.filter(([name, frame]) => name !== 'hideSideBar' && name !== 'widerSideBar' && !overlayBox(frame))
				.map(([name, frame]) => [name, dividerColumn(frame)]);

			for (const [name, column] of columns) {
				assert.notEqual(column, -1, `${name} painted over the divider`);
			}

			assert.equal(new Set(columns.map(([, column]) => column)).size, 1, `the divider moved between frames: ${JSON.stringify(columns)}`);
		});

		// Read off a later frame than the boot one: boot paints as each pane finishes opening, and the
		// driver settles on the first 250 ms of quiet, which the Sapling pane's discovery is longer
		// than — so the very first frame can be a workbench that is still assembling itself.
		it('gives the activity bar one numbered entry per view container', () => {
			assert.deepEqual(activityEntries(context.frames.scm).map(entry => entry.text), CONTAINERS.map((_, index) => String(index + 1)));
		});

		it('marks the shown container in the activity bar', () => {
			for (const [index, frame] of [context.frames.explorer, context.frames.polyglot, context.frames.scm, context.frames.sapling].entries()) {
				const bold = activityEntries(frame).filter(entry => entry.bold).map(entry => entry.text);

				assert.deepEqual(bold, [String(index + 1)], `${CONTAINERS[index]} is not the marked entry`);
			}
		});

		it('shows one view container at a time, named in the side bar title', () => {
			for (const [index, frame] of [context.frames.explorer, context.frames.polyglot, context.frames.scm, context.frames.sapling].entries()) {
				assert.ok(sideBarTitle(frame).startsWith(CONTAINERS[index]), `the side bar says ${JSON.stringify(sideBarTitle(frame))}`);
			}
		});

		// `ViewPaneContainer.updateViewHeaders`: a container with one view merges it into the title and
		// hides its header, and a container with more than one gives every view a header of its own.
		it('draws a header per view, and none for a container that merged its only view', () => {
			assert.deepEqual(viewHeaders(context.frames.explorer), []);
			assert.deepEqual(viewHeaders(context.frames.polyglot), []);
			assert.deepEqual(viewHeaders(context.frames.scm), ['CHANGES', 'GRAPH']);
			assert.deepEqual(viewHeaders(context.frames.sapling), ['SMARTLOG', 'COMMIT INFO']);
		});

		// `Pane.updateStyles` puts `1px solid sideBarSectionHeader.border` on the top of every visible
		// header (`paneview.ts:396`), and in this theme that rule is the only thing between two stacked
		// views — `sideBarSectionHeader.background` is the side bar's own colour. A merged view has no
		// header, so it has no rule either.
		it('rules off every view header in the colour the theme gives that border', () => {
			const border = themeColour('sideBarSectionHeader.border');

			assert.deepEqual(viewRules(context.frames.explorer), []);
			assert.deepEqual(viewRules(context.frames.polyglot), []);
			assert.deepEqual(viewRules(context.frames.scm), [border, border]);
			assert.deepEqual(viewRules(context.frames.sapling), [border, border]);
		});

		it('has no editor open before one is asked for', () => {
			assert.deepEqual(names(context.frames.explorer), []);
		});

		it('opens a file into the editor area rather than into the side bar', () => {
			const frame = context.frames.openReadme;

			assert.equal(active(frame)?.name, README.name);
			assert.ok(editorRows(frame).some(row => row.includes(README.line)), `the editor is not showing the file: ${JSON.stringify(editorRows(frame).slice(0, 4))}`);

			// The side bar did not become the file: it is still the explorer, listing the workspace.
			assert.ok(sideBarTitle(frame).startsWith('EXPLORER'));
		});

		// The property a single reader pane could not have, and the reason `EditorGroupModel` is here.
		it('keeps several editors open at once, one tab each', () => {
			assert.deepEqual(names(context.frames.openEncoding), [ENCODED_FILE]);
			assert.deepEqual(names(context.frames.openReadme), [ENCODED_FILE, README.name]);

			const withDiff = names(context.frames.openDiff);
			assert.equal(withDiff.length, 3, `the diff did not open beside the two files: ${JSON.stringify(withDiff)}`);
			assert.deepEqual(withDiff.slice(0, 2), [ENCODED_FILE, README.name], 'opening a diff replaced a file editor');

			// `DiffEditorInput.computeLabels` names a diff after both of its sides unless the caller
			// gave it a title, and `git.openChange` gives it one that names the repository's change.
			assert.ok(withDiff[2].includes(REPOSITORIES[0]) || withDiff[2].includes('staged.txt'), `the diff's tab says ${JSON.stringify(withDiff[2])}`);
		});

		it('walks the strip with Tab and closes with Ctrl+W', () => {
			assert.equal(active(context.frames.nextEditor)?.name, ENCODED_FILE, 'Tab did not wrap round to the first tab');

			const left = names(context.frames.closeEditor);
			assert.equal(left.length, 2, `Ctrl+W left ${JSON.stringify(left)}`);
			assert.ok(!left.includes(ENCODED_FILE), 'Ctrl+W closed something other than the active editor');
		});

		// Items 1–3 of the usability pass, which were one gesture: `Tab` and the digits worked all
		// along and there was no key at all for "put the keyboard back in the side bar", so a user who
		// opened a file was in the editor area with nothing on the status line offering a way out.
		it('moves the keyboard between the side bar and the editor area, with one key both ways', () => {
			// Which of the two rules `0` matched is `editorAreaFocus`, and the status line is built from
			// the rules that currently apply — so what it offers *is* which part has the keyboard.
			assert.match(statusLine(context.frames.nextEditor).text, /0 Side Bar/, 'the editor area offers no way back to the side bar');
			assert.match(statusLine(context.frames.focusSideBar).text, /0 Editor/, '`0` did not move the keyboard out of the editor area');
			assert.match(statusLine(context.frames.focusEditorArea).text, /0 Side Bar/, '`0` did not move it back');

			// And the keys move with it: the strip's own are the editor area's and nothing else's.
			assert.match(statusLine(context.frames.nextEditor).text, /Tab Open Next Editor/);
			assert.doesNotMatch(statusLine(context.frames.focusSideBar).text, /Open Next Editor/);

			// Neither gesture touched the editors themselves, which is what makes it focus and not a
			// close: all three tabs are still open on both sides of the move.
			assert.equal(names(context.frames.focusSideBar).length, 3);
			assert.deepEqual(names(context.frames.focusEditorArea), names(context.frames.nextEditor));
		});

		// `workbench.action.increaseViewSize` / `decreaseViewSize` — upstream's own commands, resizing
		// the part that has the keyboard through `layout.ts`'s `resizePart`. What a terminal has that a
		// grid does not is one divider between exactly two parts, so the two widths are one number.
		it('resizes the side bar, and gives the columns it takes to the editor area', () => {
			const before = dividerColumn(context.frames.pickerCancelled);
			const wider = dividerColumn(context.frames.widerSideBar);

			// `RESIZE_INCREMENT` is 60px of a 1,200px frame, twice, which is a tenth of the columns.
			assert.equal(wider - before, Math.round(context.frames.widerSideBar.cols / 10), `the divider went ${before} → ${wider}`);
			assert.ok(editorLines(context.frames.widerSideBar)[0].cells.length < editorLines(context.frames.pickerCancelled)[0].cells.length,
				'the side bar grew without the editor area shrinking, so the columns came from nowhere');

			assert.equal(dividerColumn(context.frames.defaultSideBar), before, 'the same two increments back did not land where it started');
		});

		// `paneview.ts`: a collapsed pane's size is its header and nothing more, and the rows it gives
		// up go to its siblings — which here is the whole rest of the container.
		it('collapses a view to its header and expands it again', () => {
			assert.deepEqual(collapsedViews(context.frames.pickerCancelled), [], 'a view is collapsed before anything collapsed one');

			const collapsed = context.frames.collapsedView;
			assert.deepEqual(collapsedViews(collapsed), ['CHANGES'], 'the focused view did not collapse');
			// Both headers survive — a collapsed view is not a hidden one — and the second view is what
			// the rows went to, which is the half a twistie that only changed shape would not show.
			assert.deepEqual(viewHeaders(collapsed), ['CHANGES', 'GRAPH']);
			// A collapsed pane's size is `headerSize` and nothing more, so the view below it starts
			// where its own rule does — two rows on from the header, with no body in between.
			assert.equal(headerRow(collapsed, 'GRAPH'), headerRow(collapsed, 'CHANGES') + 2, 'the collapsed view kept rows of its own');
			assert.ok(headerRow(collapsed, 'GRAPH') < headerRow(context.frames.pickerCancelled, 'GRAPH'),
				'the collapsed view\'s rows did not go to the one below it');

			assert.deepEqual(collapsedViews(context.frames.expandedView), []);
			assert.deepEqual(regionLines(context.frames.expandedView), regionLines(context.frames.pickerCancelled),
				'expanding did not put the container back the way it was');
		});

		it('gives the editor area the side bar\'s columns when the side bar is hidden', () => {
			const hidden = context.frames.hideSideBar;

			assert.equal(dividerColumn(hidden), -1, 'the divider survived the side bar');
			// The activity bar stays, as it does in tscode: `Ctrl+B` hides the side bar, not the bar
			// that chooses what is in it.
			assert.deepEqual(activityEntries(hidden).map(entry => entry.text), CONTAINERS.map((_, index) => String(index + 1)));
		});
	});
}
