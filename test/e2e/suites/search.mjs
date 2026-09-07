// Text search: what the query found, where, and what `preview()` decided to show of it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ENCODED_FILE, LONG_LINE, NEEDLES, OPEN_MATCHES, OTHER_POLYGLOT, POLYGLOT_FILES, REPLACED_FILE, REPLACEMENT, SIBLING_FILES, TS_GLOB, TS_POLYGLOT } from '../lib/fixture.mjs';
import { colourOf, editorLines, editorTabs, searchView, selectedRow, sideBarLines, statusLine } from '../lib/probes.mjs';
import { themeColour, themeColourOver } from '../lib/theme.mjs';

/** The row the keyboard is on, which is the only place a cursor exists as data. */
const SELECTED_BACKGROUND = themeColourOver('list.activeSelectionBackground', 'sideBar.background');

/**
 * What `.findInFileMatch` is drawn in: `editor.findMatchHighlightBackground`, which is translucent
 * in the theme, composited onto the `sideBar.background` a match row sits on. The two ids and their
 * order are the assertion; the blend is `Color.blend`'s, as it is in the pane.
 */
const FIND_MATCH_HIGHLIGHT = themeColourOver('editor.findMatchHighlightBackground', 'sideBar.background');

/**
 * A `FindInput` toggle draws itself in `inputOption.activeBackground` while it is checked — which
 * the theme states with an alpha, because the toggle is inside `.monaco-inputbox` and a GUI
 * composites it onto that box. A cell has no alpha, so `screen.ts` does the composite on the way
 * out; before it did, the toggle came out as the flat `#3994BC` the alpha was never applied to.
 */
const TOGGLE_ON = themeColourOver('inputOption.activeBackground', 'input.background');
const TOGGLE_OFF = themeColour('input.background');

/**
 * What an empty box says and what it says it in. `SearchWidget` gives the replace box a
 * `placeholder`, and a browser draws that whether or not the box has focus — which is what
 * `inputSpans` does since the four boxes were made one, and what this pane alone did not.
 */
const REPLACE_PLACEHOLDER = 'Replace';
const PLACEHOLDER_FOREGROUND = themeColour('input.placeholderForeground');

/** `buildResultCountMessage`'s two numbers, without depending on the sentence around them. */
function counts(view) {
	const message = /^(\d+) results? in (\d+) files?/.exec(view.message);
	assert.ok(message, `no result count in ${JSON.stringify(view.message)}`);

	return { results: Number(message[1]), files: Number(message[2]) };
}

const fileRows = view => view.rows.filter(row => row.collapsible);
const names = view => fileRows(view).map(row => row.name).sort();

/**
 * The editor row the caret is on: `TextFileEditorPane.renderRow` draws the focused row in
 * `editor.lineHighlightBackground` over `editor.background` and every other row in the background
 * alone, which is the whole of what a terminal shows of a caret in a pane that is not in vim mode.
 */
const ACTIVE_LINE = themeColourOver('editor.lineHighlightBackground', 'editor.background');

function caretRow(frame) {
	const painted = editorLines(frame).slice(1).filter(line => line.cells[0].bg === ACTIVE_LINE);
	assert.equal(painted.length, 1, `${painted.length} editor rows are drawn in ${ACTIVE_LINE}: ${JSON.stringify(editorLines(frame).slice(1, 8).map(line => line.text.trim()))}`);

	// The row is drawn with its line number in the gutter, which is the editor's and not the match's.
	const row = /^\s*\d+\s+(.*)$/.exec(painted[0].text.trimEnd());
	assert.ok(row, `the caret's row has no line number: ${JSON.stringify(painted[0].text)}`);

	return row[1];
}

/** The tab strip's names, which is what says whether an open made a tab or brought one forward. */
const tabNames = frame => editorTabs(frame).map(tab => tab.name);

export default function registerSearchSuite(context) {
	describe('search', () => {
		// The pane opens in navigation rather than in its box, so every single-character key works on
		// the first keystroke — and with nothing searched for there is nothing to navigate, which
		// leaves the status line the only thing saying how to start.
		it('opens in navigation, opens the box on `I`, and takes the keys back on Escape', () => {
			const opened = searchView(context.frames.searchOpened);
			assert.equal(opened.caret, false, 'the query box took the keyboard as the pane opened');
			assert.equal(opened.query, '');
			assert.match(statusLine(context.frames.searchOpened).text, /I search/,
				`the status line does not say how to start: ${JSON.stringify(statusLine(context.frames.searchOpened).text.trimEnd())}`);

			// Discriminating, and it is the pair: `c` is `toggleSearchCaseSensitive`, so the toggle
			// moved *and* the query stayed empty. A box with the keyboard would have typed a `c`.
			const toggled = searchView(context.frames.searchToggledOnOpen);
			assert.equal(toggled.toggles.Aa, TOGGLE_ON, '`c` did not reach the pane');
			assert.equal(toggled.query, '');

			// The digits are the same case one scope out, and the pane comes back as it opened.
			const reopened = searchView(context.frames.searchReopened);
			assert.equal(reopened.toggles.Aa, TOGGLE_OFF);
			assert.equal(reopened.caret, false, 'the pane came back with the box holding the keyboard');

			// `I` is `tscode.editInput`: the box takes the keyboard, and what is typed reaches it.
			assert.equal(searchView(context.frames.polyglot).caret, true, '`I` did not open the query box');
			assert.equal(searchView(context.frames.polyglot).query, NEEDLES.polyglot);

			// And `Escape` puts them back: `h` is `workbench.action.replaceInFiles`, a pane command
			// pressed directly behind it while the query box held the keyboard.
			assert.notEqual(searchView(context.frames.replaceBox, { details: true, replace: true }).replace, undefined,
				'`Escape` did not give the single-character keys back');
		});

		it('reports the files, folders and per-file counts of a known string', () => {
			const view = searchView(context.frames.polyglot);

			assert.equal(view.query, NEEDLES.polyglot);
			assert.deepEqual(counts(view), { results: POLYGLOT_FILES.length, files: POLYGLOT_FILES.length });
			assert.deepEqual(
				fileRows(view).map(row => ({ name: row.name, folder: row.folder, count: row.count })).sort((a, b) => a.name.localeCompare(b.name)),
				POLYGLOT_FILES.map(file => ({ ...file, count: 1 }))
			);
		});

		it('takes a pasted query, and answers it as though it had been typed', () => {
			const pasted = searchView(context.frames.pastedQuery);
			const typed = searchView(context.frames.sibling);

			assert.equal(pasted.query, NEEDLES.sibling);
			assert.deepEqual(names(pasted), names(typed));
			assert.deepEqual(counts(pasted), counts(typed));
		});

		// The two editing keys the query box gained when the four boxes became one. Neither is a
		// keybinding rule — they are arms of `inputBox.ts` the way `backspace` is — so what this
		// says is that a key carrying `Ctrl` reaches a box that has the keyboard at all.
		it('deletes a word on Ctrl+W and the whole query on Ctrl+U', () => {
			// `needle-sibling` is the query that tells the two apart: `Ctrl+W` stops at the hyphen.
			assert.equal(searchView(context.frames.wordDeleted).query, 'needle-');
			assert.equal(searchView(context.frames.boxCleared).query, '');
			// The box still has the keyboard afterwards, which a key that fell through to the pane
			// would have taken away — and the query typed back into it finds what it found before.
			assert.equal(searchView(context.frames.boxCleared).caret, true);
			assert.deepEqual(names(searchView(context.frames.queryRestored)), names(searchView(context.frames.sibling)));
		});

		it('honours the sibling `when` clause in `files.exclude`, and replaces the previous results', () => {
			const view = searchView(context.frames.sibling);

			assert.deepEqual(names(view), SIBLING_FILES.visible);
			for (const hidden of SIBLING_FILES.hidden) {
				assert.ok(!names(view).includes(hidden), `${hidden} should be hidden by its .ts sibling`);
			}

			// The query before this one matched three other files, none of which may survive it.
			for (const superseded of POLYGLOT_FILES) {
				assert.ok(!names(view).includes(superseded.name), `${superseded.name} survived the next query`);
			}
		});

		it('elides the preview of a long line, and highlights the match inside it', () => {
			const view = searchView(context.frames.longLine);
			assert.deepEqual(counts(view), { results: 1, files: 1 });
			assert.deepEqual(fileRows(view).map(row => ({ name: row.name, folder: row.folder })), [{ name: LONG_LINE.file, folder: LONG_LINE.folder }]);

			const [match] = view.rows.filter(row => !row.collapsible);
			assert.ok(LONG_LINE.length > 1000, 'the fixture line is not long enough to force elision');
			assert.ok(match.preview.startsWith('…'), `\`preview()\`'s own lcut is missing from ${JSON.stringify(match.preview.slice(0, 40))}`);
			assert.ok(!match.preview.includes(LONG_LINE.head), 'the preview starts at the beginning of the line rather than near the match');

			// The elision is what puts the match on screen at all: `lcut` keeps 26 characters of what
			// came before it, so an unelided row would have it 600-odd columns off to the right.
			const column = match.preview.indexOf(NEEDLES.longLine);
			assert.ok(column >= 0 && column < 40, `the match is at column ${column} of ${JSON.stringify(match.preview.slice(0, 60))}`);

			assert.equal(colourOf(match, NEEDLES.longLine).bg, FIND_MATCH_HIGHLIGHT);
		});

		// The row above is the one thing in this fixture wider than the part it is drawn in, so it is
		// where the side bar's horizontal axis can be asserted at all. It is read raw rather than
		// through `searchView`, because a scrolled row has had its indent and its twistie cut off the
		// left — which is the point, and is exactly what the tree probe's shape parse would reject.
		it('scrolls the side bar sideways with the key and with the wheel', () => {
			const rows = frame => sideBarLines(frame).map(line => line.text);
			const before = rows(context.frames.longLine);
			// The match row rather than the query box, which also holds the needle and — being a
			// header — deliberately does not scroll: `preview()`'s own `lcut` is what tells them apart.
			const at = before.findIndex(text => text.includes('…') && text.includes(NEEDLES.longLine));
			assert.notEqual(at, -1, `no elided match row holds the needle: ${JSON.stringify(before)}`);

			// The precondition, stated so that a fixture which stopped producing an over-wide row
			// fails as itself rather than as "the scroll did nothing": the row has to reach the
			// right-hand edge of the side bar, or there is nothing off it to scroll to. The side bar
			// is a quarter of a 300-column frame, and the probe trims the padding off a short row.
			const width = Math.max(...before.map(text => text.length));
			assert.ok(before[at].length >= width, `the match row is not the widest in the side bar: ${JSON.stringify(before[at])}`);

			// Four presses of `Ctrl+Right`, three cells each — `Pane.WHEEL_STEP`, which is one wheel
			// notch on whichever axis the gesture names.
			const right = rows(context.frames.scrolledRight)[at];
			assert.ok(right.startsWith(before[at].slice(12)), `the row did not move 12 columns: ${JSON.stringify([before[at], right])}`);
			// The discriminating half: the row is not merely shorter, it reaches further into the line
			// than the unscrolled row could. A pane that cut without scrolling would fail here.
			assert.ok(right.length > before[at].length - 12, `nothing new came into view: ${JSON.stringify(right)}`);

			// And two notches of `Shift`+wheel back the other way, which is six of the twelve.
			const back = rows(context.frames.scrolledBack)[at];
			assert.ok(back.startsWith(before[at].slice(6)), `the wheel did not take six columns back: ${JSON.stringify([before[at], back])}`);
		});

		it('reads a file in a non-UTF-8 encoding', () => {
			const view = searchView(context.frames.encoded);

			assert.deepEqual(names(view), [ENCODED_FILE]);
		});

		// `IPatternInfo.isCaseSensitive` reaching `QueryBuilder` — the query already carried the
		// field and nothing could set it before phase C. The needle is uppercase in the fixture and
		// the query is typed lowercase, so the toggle is the whole difference between three files
		// and none: an option that never left the pane would leave both frames at three.
		it('matches case only when the case toggle is on', () => {
			const insensitive = searchView(context.frames.lowercase);
			assert.equal(insensitive.query, NEEDLES.polyglot.toLowerCase());
			assert.equal(insensitive.toggles.Aa, TOGGLE_OFF);
			assert.deepEqual(names(insensitive), POLYGLOT_FILES.map(file => file.name).sort());

			const sensitive = searchView(context.frames.caseSensitive);
			assert.equal(sensitive.toggles.Aa, TOGGLE_ON, 'the case toggle is not drawn as checked');
			assert.deepEqual(names(sensitive), []);
		});

		it('draws each of the find input\'s three toggles in its own state', () => {
			const view = searchView(context.frames.wordAndRegex);

			assert.deepEqual(view.toggles, { Aa: TOGGLE_OFF, ab: TOGGLE_ON, '.*': TOGGLE_ON });
		});

		// `toggleQueryDetails` is what reveals `PatternInputWidget`'s two globs upstream, and
		// `search.focus.nextInputBox` is what walks them.
		it('reveals the two glob boxes, and narrows the query with each of them', () => {
			const details = searchView(context.frames.queryDetails, { details: true });
			assert.deepEqual(details.boxes, ['files to include', 'files to exclude']);
			assert.deepEqual(details.toggles, { Aa: TOGGLE_OFF, ab: TOGGLE_OFF, '.*': TOGGLE_OFF });
			assert.deepEqual(names(details), POLYGLOT_FILES.map(file => file.name).sort());

			const included = searchView(context.frames.includeGlob, { details: true });
			assert.deepEqual(included.boxes, [TS_GLOB, 'files to exclude']);
			assert.deepEqual(names(included), TS_POLYGLOT.map(file => file.name).sort());

			// The same glob on the other box leaves exactly the complement, which is what says the
			// two are separate fields rather than one read twice.
			const excluded = searchView(context.frames.excludeGlob, { details: true });
			assert.deepEqual(excluded.boxes, ['files to include', TS_GLOB]);
			assert.deepEqual(names(excluded), OTHER_POLYGLOT.map(file => file.name).sort());
			assert.ok(excluded.message.includes(`excluding '${TS_GLOB}'`) || counts(excluded).files === OTHER_POLYGLOT.length,
				`the message ignores the exclusion: ${JSON.stringify(excluded.message)}`);
		});

		// The usability pass's item 4. All four of upstream's inputs are here since `§12.3` — the
		// fourth is replace, which was blocked on `IReplaceService` — and they *do* cycle. What made
		// the key look dead is the state the pane opens in: with the two globs hidden there is one box,
		// and cycling one box put the keyboard back where it already was. Upstream does not wrap: past
		// the last box, `focusNextInputBox` runs out into `moveFocusFromSearchOrReplace`, which selects
		// the tree.
		it('leaves the query box for the results when there is no next input to move to', () => {
			assert.equal(searchView(context.frames.lowercase).caret, true, 'the query box did not have the keyboard to begin with');
			assert.equal(searchView(context.frames.leaveQueryBox).caret, false, 'the query box still has the caret, so `Ctrl+Down` wrapped onto it');

			// Discriminating, and it is the step after this one: `c` is `toggleSearchCaseSensitive`,
			// which only fires while no box is swallowing keys — and there is no `Escape` in front of
			// it. A wrap would have typed a `c` into the query instead, and the case-sensitive frame
			// would still be finding three files.
			assert.equal(searchView(context.frames.caseSensitive).toggles.Aa, TOGGLE_ON);
		});

		// Replace, end to end: the box, the preview upstream's own `MatchRenderer` draws beside every
		// match while it holds a term, the row going away when it is applied, and the file on disk.
		it('previews the replacement beside every match while the term is being typed', () => {
			const before = searchView(context.frames.replaceBox, { details: true, replace: true });
			// The box comes up holding nothing, which is now its *placeholder* being drawn — so the
			// colour is what says so. A term already in it would be in `input.foreground`.
			assert.equal(before.replace, REPLACE_PLACEHOLDER, 'the replace box came up with something already in it');
			assert.equal(before.replaceFg, PLACEHOLDER_FOREGROUND, 'the empty replace box is drawn as a value, not as a placeholder');
			assert.deepEqual(names(before), [REPLACED_FILE.name]);

			const typed = searchView(context.frames.replaceTerm, { details: true, replace: true });
			assert.equal(typed.replace, REPLACEMENT);
			assert.notEqual(typed.replaceFg, PLACEHOLDER_FOREGROUND, 'a typed term is drawn as a placeholder');
			assert.equal(typed.preserveCase, TOGGLE_OFF);
			// The counts do not move: a replace term changes no query. What moves is every match row,
			// which now carries the replacement after the match — `MatchRenderer`'s `.replaceMatch`.
			assert.deepEqual(counts(typed), counts(before));

			const [match] = typed.rows.filter(row => !row.collapsible);
			assert.ok(match.preview.includes(`${NEEDLES.sibling}${REPLACEMENT}`),
				`no replacement drawn beside the match: ${JSON.stringify(match.preview)}`);
			// Discriminating: the same row before the term was typed has the match and nothing after it.
			const [plain] = before.rows.filter(row => !row.collapsible);
			assert.ok(!plain.preview.includes(REPLACEMENT), `the preview was there before the term: ${JSON.stringify(plain.preview)}`);
		});

		it('replaces the focused match, and the file on disk is what changed', () => {
			const after = searchView(context.frames.replaced, { details: true, replace: true });

			// The match is gone from the results because the text it matched is gone from the file.
			assert.deepEqual(names(after), []);
			assert.ok(after.message.startsWith('No results found'), `the results survived the replace: ${JSON.stringify(after.message)}`);

			const written = readFileSync(join(context.fixture.root, REPLACED_FILE.path), 'utf8');
			assert.ok(written.includes(REPLACEMENT), `the replacement is not on disk: ${JSON.stringify(written)}`);
			assert.ok(!written.includes(NEEDLES.sibling), `the match is still on disk: ${JSON.stringify(written)}`);
			// The rest of the line is untouched, which is what says a text *edit* was applied rather
			// than the file rewritten from the preview.
			assert.ok(written.includes(REPLACED_FILE.tail), `the line around the match did not survive: ${JSON.stringify(written)}`);
		});

		// Opening a result. `Enter` is the whole surface — the arrows deliberately open nothing —
		// and the file it opens at the match's own range, which is the range the row carries.
		it('opens a file row at its first match, and a match row at its own', () => {
			const results = searchView(context.frames.openQuery, { details: true });
			assert.deepEqual(results.boxes, [OPEN_MATCHES.glob, 'files to exclude']);
			assert.deepEqual(counts(results), { results: 2, files: 1 });

			// The file row is the row the results open on, and `Enter` on it takes the **first** of
			// its two matches. The second is what makes that discriminating: upstream's own
			// `getEditorSelectionFromMatch` would have taken the last.
			const opened = context.frames.openedFileRow;
			assert.equal(caretRow(opened), OPEN_MATCHES.first);
			assert.ok(tabNames(opened).includes(LONG_LINE.file), `the strip holds ${JSON.stringify(tabNames(opened))}`);

			// Two rows down is that file's second match, and opening it is the *same* tab with the
			// caret moved — which is the half an editor that is already open would otherwise lose.
			const second = context.frames.openedSecondMatch;
			assert.equal(caretRow(second), OPEN_MATCHES.second);
			assert.deepEqual(tabNames(second), tabNames(opened), 'the second match opened a second tab');
		});

		it('keeps the keyboard in the results, and opens nothing on the arrows', () => {
			// `w` was pressed straight after the open, with no `Escape` in front of it: in this pane
			// it is `toggleSearchWholeWord`, and in the editor area it is `tscode.file.toggleWordWrap`.
			// So the toggle having moved is `preserveFocus` having held.
			assert.equal(searchView(context.frames.keptKeyboard, { details: true }).toggles.ab, TOGGLE_ON,
				'the keyboard went to the editor area with the file it opened');

			// And the arrows move the cursor over the results without opening anything: no preview
			// tab exists here, so open-on-focus would leave one tab per row.
			const before = context.frames.openedSecondMatch;
			const after = context.frames.arrowsOpenedNothing;
			assert.deepEqual(tabNames(after), tabNames(before), 'an arrow opened an editor');
			assert.equal(caretRow(after), caretRow(before), 'an arrow moved the caret in the editor area');

			// `Left` still folds the file row, which is the key `Enter` did not take over.
			const folded = searchView(context.frames.resultFolded, { details: true });
			assert.deepEqual(fileRows(folded).map(row => row.open), [false], 'the file row did not fold');
			assert.deepEqual(folded.rows.filter(row => !row.collapsible), [], 'the matches survived the fold');
		});

		// `/` over the results: the explorer's key and the explorer's box, with no view root under it
		// — a result list is two levels deep and there is nothing to descend into, so the query is one
		// pattern rather than a path (§7.6).
		describe('`/` filters the results', () => {
			const filtered = frame => searchView(context.frames[frame], { details: true, filter: true });
			const shown = frame => searchView(context.frames[frame], { details: true, filter: true }).rows.map(row => row.name ?? row.preview);

			// The box opens **empty**, because there is no root for it to be prefilled with the path
			// of — and empty is the query that already means *show everything*, so nothing moves.
			it('opens empty, over the rows that are already there', () => {
				const opened = filtered('searchFilterOpened');
				assert.equal(opened.filter, 'filter results', 'the box is not empty');
				assert.equal(opened.filterCaret, true, 'the filter row does not have the keyboard');
				assert.equal(opened.caret, false, 'the query box still has the keyboard');
				assert.deepEqual(names(opened), POLYGLOT_FILES.map(file => file.name).sort());
				assert.deepEqual(counts(opened), { results: 3, files: 3 }, 'opening the box changed the search');
			});

			// Two matched on the *first* keystrokes and one of them on the second, which is what makes
			// this narrowing rather than a single filter run: `ma` keeps `main.rs` by its own name and
			// `deeply.md` by its match's text, and `main` takes the markdown file away.
			it('narrows the rows as it is typed', () => {
				assert.deepEqual(shown('searchFilterTyped'),
					['deeply.md', 'POLYGLOT in markdown', 'main.rs', '// POLYGLOT in rust']);
				assert.deepEqual(shown('searchFilterNarrowed'), ['main.rs', '// POLYGLOT in rust']);
				assert.equal(filtered('searchFilterNarrowed').filter, 'main');
			});

			// A file row is matched on its name *and* on its path, which is `Ctrl+P`'s own rule for a
			// query carrying a separator: `src/app` is no row's name and no row's text.
			it('matches a file row on its path', () => {
				assert.deepEqual(shown('searchFilterByPath'), ['app.ts', "export const KIND = 'POLYGLOT';"]);
			});

			// And a match row on its own line. `rust` is in `// POLYGLOT in rust` and in no name or
			// path here, so `main.rs` has a row only because the match under it does — which is
			// `FindFilter`'s own `Recurse` for an unmatched parent, asked one level up.
			it('matches a match row on its text, and keeps the file above it', () => {
				assert.deepEqual(shown('searchFilterByText'), ['main.rs', '// POLYGLOT in rust']);
				assert.deepEqual(shown('searchFilterByPath').length, 2, 'the by-path frame is not the discriminating pair');
			});

			// `Tab` cycles the **file** rows and only those: three files, so the fourth press wraps.
			it('completes over file rows, and cycles them', () => {
				assert.deepEqual(
					['searchFilterCompleted', 'searchFilterCompletedNext', 'searchFilterCompletedWrapped', 'searchFilterCompletedBack']
						.map(frame => filtered(frame).filter),
					['app.ts', 'deeply.md', 'app.ts', 'main.rs']);

				// The cursor goes with the box, which is what makes `Enter` commit a row on screen.
				assert.ok(selectedRow(context.frames.searchFilterCompletedBack, SELECTED_BACKGROUND).text.includes('main.rs'),
					`the cursor is on ${JSON.stringify(selectedRow(context.frames.searchFilterCompletedBack, SELECTED_BACKGROUND).text)}`);
			});

			// **A match row answers no completion name**, so a query only match rows survive has no
			// candidate at all — a whole line of source written into the box is not a completion.
			it('does nothing on a query that ranks only match rows', () => {
				assert.deepEqual(filtered('searchFilterNoCompletion'), filtered('searchFilterByText'));
			});

			// `Escape` closes the box and puts the cursor back where it was opened from — the second
			// file row, which is discriminating against any reset, since that would land on the first.
			it('restores the cursor on Escape', () => {
				const escaped = searchView(context.frames.searchFilterEscaped, { details: true });
				assert.equal(escaped.rows.length, 6, 'the rows did not all come back');
				assert.ok(selectedRow(context.frames.searchFilterEscaped, SELECTED_BACKGROUND).text.includes(POLYGLOT_FILES[1].name),
					`the cursor is on ${JSON.stringify(selectedRow(context.frames.searchFilterEscaped, SELECTED_BACKGROUND).text)}`);
			});

			// `Enter` closes the box on the row the cursor is on and opens **nothing** — the
			// explorer's *file* arm — so it is the second `Enter` that opens the result.
			it('closes the box on the focused row without opening it, and opens on the next Enter', () => {
				const picked = searchView(context.frames.searchFilterPicked, { details: true });
				assert.equal(picked.rows.length, 6, 'the rows did not all come back');
				assert.deepEqual(tabNames(context.frames.searchFilterPicked), [], 'the Enter that closed the box also opened the row');
				assert.ok(selectedRow(context.frames.searchFilterPicked, SELECTED_BACKGROUND).text.includes(POLYGLOT_FILES[0].name),
					`the cursor is on ${JSON.stringify(selectedRow(context.frames.searchFilterPicked, SELECTED_BACKGROUND).text)}`);

				assert.deepEqual(tabNames(context.frames.searchFilterOpenedResult), [POLYGLOT_FILES[0].name]);
				assert.deepEqual(tabNames(context.frames.searchFilterTabClosed), [], 'the tab did not close again');
			});

			// The pane has five boxes and one `canEdit`/`editing` pair for all of them (§7.2): `I`
			// cannot open the query box over the filter row, because `editing` is already true while
			// that row is there — so it is one more letter the box takes.
			it('keeps `I` off the filter row, and the query box off `/`', () => {
				const typed = filtered('searchFilterTakesLetters');
				assert.equal(typed.filter, 'I');
				assert.equal(typed.query, NEEDLES.polyglot, 'the letter reached the query box');
				assert.equal(typed.caret, false, 'the query box took the keyboard');

				// And with the box gone, `I` is what it always was.
				assert.equal(searchView(context.frames.searchFilterClosed, { details: true }).caret, false);
			});
		});

		// `closeReplaceInFilesWidget`, upstream's own id: the box goes and so does every preview,
		// because `searchModel.replaceActive` is what the renderer draws them from.
		it('takes the replace box and its previews away again', () => {
			const closed = searchView(context.frames.replaceClosed, { details: true });

			assert.deepEqual(closed.boxes, ['files to include', TS_GLOB]);
			assert.ok(!closed.rows.some(row => row.text.includes(REPLACEMENT)), 'a preview survived the box being closed');
		});
	});
}
