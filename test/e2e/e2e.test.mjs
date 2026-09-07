// The end-to-end suite: one generated workspace, one app run, one frame per step.
//
// Run it with `npm run e2e`, which builds first — so, unlike the suite this is ported from, there is
// no freshness check to make: `out/` and the host binary cannot be older than the sources.
//
// The steps are the whole script of the run, in order, and each leaves a frame behind under its
// name. A suite asserts on those frames and waits for nothing, so a pane's failure is a statement
// about what was on screen at a named point rather than a race with the app.

import { ALPHA, createFixture, NEEDLES, OPEN_MATCHES, QUICK_OPEN_FILE, REPLACEMENT, SCM_RANKED, SIBLING_FILES, TS_GLOB, VIM_MARK } from './lib/fixture.mjs';
import { clear, click, KEYS, paste, registerSession, shiftWheelUp, wheelDown } from './lib/session.mjs';
import registerExplorerSuite from './suites/explorer.mjs';
import registerInputBoxSuite from './suites/inputBox.mjs';
import registerInteractionSuite from './suites/interaction.mjs';
import registerLayoutSuite from './suites/layout.mjs';
import registerMarkdownSuite from './suites/markdown.mjs';
import registerRegionSuite from './suites/region.mjs';
import registerSaplingSuite from './suites/sapling.mjs';
import registerScmSuite from './suites/scm.mjs';
import registerSearchSuite from './suites/search.mjs';
import registerVimSuite from './suites/vim.mjs';

/**
 * Wide enough that no row this fixture produces is truncated, and tall enough for every repository's
 * groups at once — the two things a frame has to hold for the assertions to be about content.
 *
 * **A pane is a quarter of the frame wide now**, because that is what the side bar is
 * (`Workbench.SIDE_BAR_SHARE`, from upstream's own `Math.min(300, width / 4)`), so the frame has to
 * be four times the widest row a pane draws rather than as wide as it. The widest here is the
 * commit-info drawer's byline at 70 columns.
 */
const SIZE = { cols: 300, rows: 90 };

/**
 * A paste made of nothing but keys that do something with the explorer focused: `t` opens a
 * terminal, `q` quits, `3` switches view container, and `\r` opens the focused row. If one
 * character of it were dispatched as a key, this run would not reach its second frame.
 *
 * **It is deliberately larger than a pipe's buffer**, so the closing marker arrives in a different
 * read from the opening one — which is the case a paste has to survive and the one no shorter
 * fixture reaches. A marker that straddles two reads and is decoded as keys is the whole defect
 * back, quietly.
 */
const PASTE_BOMB = 't3q\r'.repeat(20_000);

const context = { frames: undefined, fixture: undefined, run: undefined };

registerSession(context, {
	createFixture,
	size: SIZE,
	steps: [
		// The explorer is pane 1 and has focus at boot, with the cursor on the first row — `.vscode`,
		// so one `Down` puts it on `alpha` and `Right` opens that. Which folder opened is asserted
		// rather than assumed, so a fixture that grew a new first row fails loudly here.
		{ name: 'explorer' },
		// A paste, which is the one input this frontend must never treat as keys. Nothing has a text
		// input focused here, so what a browser would do with it is nothing at all — and a frame
		// identical to the one before it is the whole assertion. Every step below is downstream of
		// that: a paste that moved the cursor would break all of them rather than only this one.
		{ name: 'pasteIgnored', keys: paste(PASTE_BOMB) },
		{ name: 'alpha', keys: KEYS.home + KEYS.down + KEYS.right },
		// Two rows into `alpha` is `src` — `FileSorter` puts `.githooks` first. `src` has four
		// children so nothing folds there; `nested` below it holds one directory and nothing else,
		// which is what `explorer.compactFolders` folds into a single row. A cursor move is not
		// queued behind the expansion the way another `Right` would be, so the two are two steps.
		{ name: 'srcOpen', keys: `${KEYS.down.repeat(2)}${KEYS.right}` },
		{ name: 'compact', keys: `${KEYS.down}${KEYS.right}` },
		// The workspace's last two rows are its two files, so `End` and two `Up`s land on `siblings`.
		// Opening it needs the folder read the step before to have *finished*, which is the gesture the
		// one-chunk driver could not reach — and which folder opened is asserted either way.
		{ name: 'siblings', keys: KEYS.end + KEYS.up.repeat(2) + KEYS.right },
		// `C` is `workbench.files.action.collapseExplorerFolders` — upstream's own id, whose
		// `Action2` lives inside the DOM view and is therefore dormant in this closure. Four folders
		// are open by this point, so a collapse that only folded the focused row would leave three.
		{ name: 'collapsedFolders', keys: 'c' },
		{ name: 'collapseFocusRetained', keys: KEYS.right },
		{ name: 'collapsedAgain', keys: 'c' },
		// The removed custom `/` Explorer filter is intentionally not exercised here.
		// Explorer navigation/expansion above uses the upstream tree directly.

		// `2` is the search pane, which opens in **navigation** rather than in its box: `c` is
		// `toggleSearchCaseSensitive` and works on the first keystroke, with no `Escape` in front of
		// it. A box holding the keyboard would have typed a `c` into the query instead.
		{ name: 'searchOpened', keys: '2' },
		{ name: 'searchToggledOnOpen', keys: 'c' },
		// The toggle back off, and the digits — which the box would have swallowed too — out to the
		// explorer and back. The pane is still in navigation when it returns.
		{ name: 'searchReopened', keys: 'c12' },
		// `I` is `tscode.editInput`, the key that opens the box, and the query goes into it from
		// there. `search.searchOnType` is on, so it runs as it is typed and each of the queries below
		// supersedes the one before it.
		{ name: 'polyglot', keys: `i${NEEDLES.polyglot}` },
		// The other half of the paste: an input that *is* focused takes it, the way an element with
		// focus takes a browser's `paste` event. The query is the one the `sibling` step below types,
		// so what is asserted is that pasting a query and typing it reach the same place — and the
		// box is put back to what it held, so every step after this one is unaffected.
		{ name: 'pastedQuery', keys: clear(NEEDLES.polyglot) + paste(NEEDLES.sibling) },
		{ name: 'queryRetyped', keys: clear(NEEDLES.sibling) + NEEDLES.polyglot },
		{ name: 'sibling', keys: clear(NEEDLES.polyglot) + NEEDLES.sibling },
		// The two editing keys the boxes gained with the shared input. `needle-sibling` is the query
		// that makes them tell each other apart: `Ctrl+W` stops at the hyphen and `Ctrl+U` does not,
		// so a `Ctrl+W` wired to either backspace or clear fails one of the two frames. The query is
		// then retyped, because every step after this one is measured against it.
		{ name: 'wordDeleted', keys: KEYS.ctrlW },
		{ name: 'boxCleared', keys: KEYS.ctrlU },
		{ name: 'queryRestored', keys: NEEDLES.sibling },
		{ name: 'longLine', keys: clear(NEEDLES.sibling) + NEEDLES.longLine },
		// The one row in this fixture that is wider than the side bar, which is what horizontal
		// scrolling is for. `Ctrl+Right` is `list.scrollRight` — upstream's own id, at the key its
		// vertical siblings use one axis over — and `Shift`+wheel is upstream's own gesture for the
		// same axis. A new query resets the position, because the rows it measured are gone.
		{ name: 'scrolledRight', keys: KEYS.ctrlRight.repeat(4) },
		{ name: 'scrolledBack', keys: shiftWheelUp(10, 5).repeat(2) },
		{ name: 'encoded', keys: clear(NEEDLES.longLine) + NEEDLES.encoded },

		// The find input's three toggles and the two glob boxes behind the query details, none of
		// which had a surface before phase C. `Escape` leaves the box, which is where every
		// single-character key in this fork lives; `Ctrl+Down` is upstream's own key for the next
		// input box and carries its modifier on the wire, so it works while a box is being typed in.
		{ name: 'lowercase', keys: clear(NEEDLES.encoded) + NEEDLES.polyglot.toLowerCase() },
		// `Ctrl+Down` with the two globs hidden — the state the pane opens in — is upstream's
		// `moveFocusFromSearchOrReplace`, which selects the *tree* because there is no next box. It
		// used to wrap onto the one visible box, which is a key that does nothing. The step after it
		// is what proves it moved: `c` toggles case sensitivity only if the box let go of the
		// keyboard, and there is no `Escape` in front of it any more.
		{ name: 'leaveQueryBox', keys: KEYS.ctrlDown },
		{ name: 'caseSensitive', keys: 'c' },
		{ name: 'wordAndRegex', keys: 'cwr' },
		{ name: 'queryDetails', keys: 'wrd' },
		{ name: 'includeGlob', keys: `${KEYS.ctrlDown}${TS_GLOB}` },
		{ name: 'excludeGlob', keys: `${clear(TS_GLOB)}${KEYS.ctrlDown}${TS_GLOB}` },

		// Replace, which had no service to write through until `§12.3`. `Ctrl+Up` is upstream's own
		// `search.focus.previousInputBox`, twice, back to the query box the step above walked away
		// from.
		//
		// **The exclude glob is deliberately left set**, because it is what makes the target a single
		// known file: `**/*.ts` takes `pair.ts` out, `files.exclude`'s sibling clause takes `pair.js`
		// out, and the one file left carrying `needle-sibling` is `siblings/lone.js` — which is in no
		// repository, so what this writes to disk changes no assertion anywhere else in the run.
		{ name: 'replaceQuery', keys: `${KEYS.ctrlUp.repeat(2)}${clear(NEEDLES.polyglot)}${NEEDLES.sibling}` },
		// `Escape` leaves the box, which is where every single-character key in this fork lives, and
		// `h` is `workbench.action.replaceInFiles` — upstream's own id, at the letter its own
		// `Ctrl+Shift+H` gives it, since shift+ctrl+letter cannot reach a terminal.
		{ name: 'replaceBox', keys: `${KEYS.escape}h` },
		// A replace term searches nothing and moves every row: `MatchRenderer` draws it beside the
		// match while `searchModel.replaceActive` holds, which is the preview a GUI gets from the
		// same renderer.
		{ name: 'replaceTerm', keys: REPLACEMENT },
		// One `Down` off the file row is its one match, and `R` is `search.action.replace`.
		{ name: 'replaceFocused', keys: `${KEYS.escape}${KEYS.down}` },
		{ name: 'replaced', keys: 'R' },
		{ name: 'replaceClosed', keys: 'H' },

		// `/` over the **results**, which is the explorer's key and the explorer's box with no view
		// root under it (§7.6). The setup is one step: `Ctrl+Down` twice to the exclude glob the
		// replace steps left set, `Ctrl+U` to clear it, back up to the query, and `POLYGLOT` — one
		// match in each of three files, in three different folders, which is what a filter over
		// results needs to have anything to say. The query details stay **on**, because the steps
		// that open a result later walk the same boxes.
		{ name: 'searchFilterQuery', keys: `i${KEYS.ctrlDown.repeat(2)}${KEYS.ctrlU}${KEYS.ctrlUp.repeat(2)}${KEYS.ctrlU}${NEEDLES.polyglot}${KEYS.escape}${KEYS.home}` },
		// The cursor two rows down — the second file — so that what `Escape` restores is a row rather
		// than the top of the list, which any reset would also produce.
		{ name: 'searchFilterFrom', keys: KEYS.down.repeat(2) },
		{ name: 'searchFilterOpened', keys: '/' },
		// `Tab` cycles the **file** rows and nothing else: a match row is a line of source and answers
		// no name, so the box never fills with one. Three files, so the fourth press wraps.
		{ name: 'searchFilterCompleted', keys: KEYS.tab },
		{ name: 'searchFilterCompletedNext', keys: KEYS.tab },
		{ name: 'searchFilterCompletedWrapped', keys: KEYS.tab.repeat(2) },
		{ name: 'searchFilterCompletedBack', keys: KEYS.shiftTab },
		// `Escape` closes the box and puts the cursor back where it was opened from, whatever the
		// cycling did to it.
		{ name: 'searchFilterEscaped', keys: KEYS.escape },
		// Opening is a step of its own for the reason the source control pane's is: `r` below is
		// `toggleSearchRegex` until the box exists to put `inputFocus` up.
		{ name: 'searchFilterReopened', keys: '/' },
		// Narrowing as it is typed. `ma` keeps `main.rs` by its own name and the markdown file by its
		// match's text; `main` takes the second of those away.
		{ name: 'searchFilterTyped', keys: 'ma' },
		{ name: 'searchFilterNarrowed', keys: 'in' },
		// A match row matched on **its own text**, and a file row surviving because of it: `rust` is
		// in the line `// POLYGLOT in rust` and in no name or path here. `Tab` then has no candidate
		// at all, because a whole line of source is not a completion.
		{ name: 'searchFilterByText', keys: `${KEYS.ctrlU}rust` },
		{ name: 'searchFilterNoCompletion', keys: KEYS.tab },
		// A file row matched on its **path**, which is `Ctrl+P`'s own rule for a query carrying a
		// separator — `src/app` is no row's text and no row's name.
		//
		// **It is also the row the two `Enter`s below land on**, and that is deliberate: opening a
		// file makes its repository the active one, which the status bar draws — so the file has to be
		// in `alpha`, the repository the steps around this are measured against.
		{ name: 'searchFilterByPath', keys: `${KEYS.ctrlU}src/app` },
		// `Enter` closes the box on the row the cursor is on and **opens nothing** — the explorer's
		// *file* arm — so the second `Enter`, with the box gone, is the one that opens. The tab it
		// makes is closed again — `Ctrl+W` is `EditorAreaFocus`'s, so `0` either side of it — because
		// the steps below are measured against the strip this pane found.
		{ name: 'searchFilterPicked', keys: KEYS.enter },
		{ name: 'searchFilterOpenedResult', keys: KEYS.enter },
		{ name: 'searchFilterTabClosed', keys: `0${KEYS.ctrlW}0` },
		// `I` cannot open the query box over the filter row, because `editing` is already true while
		// that row is there — so it is one more letter the box takes.
		{ name: 'searchFilterTakesLetters', keys: '/I' },
		{ name: 'searchFilterClosed', keys: `${KEYS.ctrlU}${KEYS.escape}` },

		// `Escape` leaves the box, which is what gives the digits back, and `3` is source control.
		{ name: 'scm', keys: `${KEYS.escape}3` },
		// `/` in the source control pane, which is the explorer's `/` — a **view root** and a query
		// over it, on the file both panes share (§7.2). Opening it is a step of its own because the
		// letters below are pane commands (`A` is stage, `R` is refresh) until the box exists to put
		// `inputFocus` up.
		//
		// The pane is in **list** mode here, which is what the frames above assert it opens in.
		{ name: 'scmFilterOpened', keys: '/' },
		// The last segment at the top level ranks the **repositories**, which is the first segment of
		// a path, and **takes away the ones it misses** — the explorer's arm for a folder, on the
		// composition both panes share. `bet` is the discriminating query: `beta` is the only one of
		// the four carrying a `b`, and it is second in discovery order, so a frame that ranked nothing
		// would read all four, starting at `alpha`.
		{ name: 'scmRankedRepositories', keys: 'bet' },
		// `Enter` on a repository is the explorer's *folder* arm: the pane is displayed from it, so
		// the repository row is gone and its commit box, its Commit button and both its groups are the
		// top level. `Ctrl+U` first, because the box carries the query above.
		{ name: 'scmRooted', keys: `${KEYS.ctrlU}alp${KEYS.enter}` },
		// **The same query, at the same root, in each mode** — which is where the two modes differ and
		// the difference is upstream's rather than an arm of ours. In list mode a group's children are
		// every resource under it, so `note` reaches `zone/deep/note.txt` two levels down; in tree
		// mode (below) the same query reaches nothing, because none of the root's *direct* children is
		// named that. The box reopens prefilled with `alpha/`, which is where the pane already is.
		{ name: 'scmRootedListSearch', keys: '/note' },
		// Home moves the filter input's caret, leaving the resource selected. The match tint
		// must compose over that selection and the sidebar; the unmatched suffix keeps just
		// the selection background. This also verifies the views.css pane-body paint scope.
		{ name: 'scmMatchTinted', keys: KEYS.home },
		// A folder segment re-roots, and the folders it walks are the ones the **groups** have: `zone`
		// is a directory in no listing this pane draws, only a node in the resource tree each group
		// builds. `Staged Changes` still draws, with nothing under it — a group is structure, not a
		// path segment.
		{ name: 'scmRootedFolder', keys: `${KEYS.ctrlU}alpha/zone/` },
		// `Escape` puts back the root the box was opened on, which is `alpha` rather than the top.
		{ name: 'scmRootEscaped', keys: KEYS.escape },
		// The empty query is the top level, and `Enter` on it commits where it is — so this is the way
		// back out of a root with nothing typed.
		{ name: 'scmTopLevel', keys: `/${KEYS.ctrlU}${KEYS.enter}` },
		{ name: 'scmTree', keys: 'v' },
		// The explorer's `Tab`, on the file both panes share: the top-ranked row's name into the last
		// segment, the cursor onto that row, and the ranked rows frozen while it cycles. **The query
		// has to leave more than one repository standing**, now that one it misses is hidden rather
		// than ranked last, and `SCM_RANKED` is the one that does. What the cycle walks is those rows
		// and nothing else, in either view mode: the rows under a repository are two levels down and
		// the last segment does not rank them (`SCMViewRootDataSource.getChildren`), so this runs in
		// tree mode because that is the mode the steps around it are in.
		{ name: 'scmRankedInTree', keys: `/${SCM_RANKED.query}` },
		{ name: 'scmCompleted', keys: KEYS.tab },
		{ name: 'scmCompletedNext', keys: KEYS.tab },
		// Two `Tab`s in, so the presses that land back on the first ranked row are one fewer than the
		// rows the query kept — the whole cycle, wherever the ranking put its edges.
		{ name: 'scmCompletedWrapped', keys: KEYS.tab.repeat(SCM_RANKED.repositories.length - 1) },
		{ name: 'scmCompletedBack', keys: KEYS.shiftTab },
		// **`Enter` after a `Tab` is `Enter` on the row the cursor is on**: a repository, so it is the
		// *folder* arm and the pane is displayed from it. Back out to the top level after it, which is
		// where the steps below start.
		{ name: 'scmCompletedRoot', keys: KEYS.enter },
		{ name: 'scmCompletedTopLevel', keys: `/${KEYS.ctrlU}${KEYS.enter}` },
		{ name: 'scmTreeRooted', keys: `/alp${KEYS.enter}` },
		// The box turns `scm.compactFolders` off while it is open, for the reason §7.1 gives, so
		// `zone / deep` is two rows here and one row either side of it.
		{ name: 'scmTreeFilterOpened', keys: '/' },
		{ name: 'scmTreeMiss', keys: 'note' },
		{ name: 'scmTreeRanked', keys: `${KEYS.ctrlU}alpha/zon` },
		// `Enter` on a folder row re-roots, which is the same arm the repository took.
		{ name: 'scmTreeFolderRoot', keys: KEYS.enter },
		// And `Enter` on a **resource** is the explorer's *file* arm: the box goes and the cursor stays
		// on the row it was pressed on.
		{ name: 'scmResourceFocused', keys: `/deep/note${KEYS.enter}` },
		{ name: 'scmTreeRestored', keys: `/${KEYS.ctrlU}${KEYS.enter}` },

		{ name: 'sapling', keys: '4' },
		// The commit-info drawer, which is the container's second region. `Tab` is
		// `tscode.focusNextView` and is the only way into it where a terminal sends no mouse reports
		// — Alacritty is one, and `§5.3` says why. Focusing is a step of its own so the frame before
		// the scroll is the drawer as it was drawn.
		{ name: 'commitInfo', keys: KEYS.tab },
		// `Ctrl+Right` is `list.scrollRight`, the same key and the same `Pane` axis the search pane
		// is scrolled with: two presses, three cells each. The row it moves is the description this
		// fixture gives `delta main`, which is the one row in the drawer wider than the side bar.
		{ name: 'commitInfoScrolled', keys: KEYS.ctrlRight.repeat(2) },
		// Back to column zero, and back to the smartlog — which is the region `p` below is scoped to.
		{ name: 'commitInfoBack', keys: KEYS.ctrlLeft.repeat(2) + KEYS.tab },
		// `P` is `sapling.pickRepository`, upstream's own command reached through A2's quick input.
		// One `Down` past the Auto item and the separator a keyboard skips is `delta`; two is
		// `gamma`, the fixture's second Sapling repository and the one the pane is not showing.
		//
		// **The key that opens an overlay is a step of its own.** The overlay is installed on a
		// promise, and a chunk is dispatched synchronously — so a key written beside `p` reaches the
		// pane underneath rather than the picker, which is a silent no-op rather than an error.
		//
		// **A pick paints twice** — the overlay comes down at once, and the two `sl` invocations
		// behind the new selection land about 800 ms later. That used to be read one step early and
		// was covered up with a filler keystroke; `whenSettled` is what the pick's own promise is
		// tracked in, so the step now ends when the smartlog is on screen.
		{ name: 'saplingPicker', keys: 'p' },
		{ name: 'saplingGamma', keys: `${KEYS.down.repeat(2)}${KEYS.enter}` },
		// `Auto` hands the choice back to the active repository, which here is a git checkout `sl`
		// has never touched — so what arrives is the empty state and `gamma`'s graph goes.
		{ name: 'saplingAutoPicker', keys: 'p' },
		{ name: 'saplingNoSelection', keys: KEYS.enter },

		// The editor area. `1` shows the explorer again — the digits are the activity bar — and its
		// last two rows are its two files, because `FileSorter` puts every directory first. Two
		// `Enter`s are two editors, which is the property a single reader pane could not have.
		//
		// **The plain file is opened first, and the order matters**: `TextFileEditorPane.show` awaits
		// `whenTokenized`, the explorer queues one navigation behind the last, and loading the
		// markdown grammar for `README.md` takes longer than the 250 ms of quiet a step settles on —
		// so an `Enter` issued behind that one runs two steps later.
		{ name: 'openEncoding', keys: `1${KEYS.end}${KEYS.up}${KEYS.enter}` },
		{ name: 'openReadme', keys: `1${KEYS.end}${KEYS.enter}` },
		// `p` is `markdown.showPreview` — upstream's command id, at the key §20 says why. It is
		// scoped to the file editor *and* to `resourceLangId == markdown`, which is upstream's own
		// precondition, so the two steps also prove `ResourceContextKey` is published here.
		// Closed again before `editFile`, because `tscode.editFile` is a file editor's key and the
		// preview is not one.
		{ name: 'markdownPreview', keys: 'p' },
		{ name: 'markdownPreviewClosed', keys: KEYS.ctrlW },
		// `E` is `tscode.editFile` on the open file, in `$EDITOR` — a **bare executable name**, which
		// is what a user's `$EDITOR` is and what the launch could not resolve before: the config
		// carried no `PATH` for `find_executable`, so the child exited 0 having painted nothing and
		// the reason went nowhere. `session.mjs` says what the stub is. The keys after it are
		// vim-shaped on purpose: `q` quits, `Escape` leaves an input and `Tab` walks the strip in
		// every other frame of this run, and an editor needs all three.
		{ name: 'editFile', keys: 'e', child: true, childText: 'EDITOR-OPENED:' },
		{ name: 'editFileKeys', keys: `iqq${KEYS.escape}${KEYS.tab}`, child: true, childText: 'EDITOR-SAW:' },
		{ name: 'editFileClosed', keys: KEYS.ctrlW },
		// A second file edited in the same session, and the child quitting on its own — which is how
		// every real `$EDITOR` ends and the one path `Ctrl+W` above does not cover. `Z` is the stub's
		// `:q`; what follows it is upstream's `_onProcessExit`, so the tab goes with the process and
		// the strip is back to the two file editors rather than carrying a dead region per edit.
		{ name: 'editFileAgain', keys: 'e', child: true, childText: 'EDITOR-OPENED:' },
		{ name: 'editFileExited', keys: 'Z', child: true, afterSync: true },
		// `Enter` uses the source-control resource's own open command, which opens a third editor.
		// `v` puts the pane back in list mode, where the fourth row below the repository row is its
		// one staged change.
		{ name: 'openDiff', keys: `3v${KEYS.home}${KEYS.down.repeat(4)}${KEYS.enter}` },
		// Opening moved the keyboard into the editor area, where `Tab` walks the strip.
		{ name: 'nextEditor', keys: KEYS.tab },
		// `0` is one key for both directions of upstream's `Ctrl+1`/`Ctrl+0` pair, which a terminal
		// cannot deliver at all: it is `focusEditorArea` from the side bar and
		// `workbench.action.focusSideBar` from the editor area, told apart by `editorAreaFocus`. Only
		// the first half existed, so there was no way out of the editor area and no hint offering one.
		{ name: 'focusSideBar', keys: '0' },
		{ name: 'focusEditorArea', keys: '0' },
		{ name: 'closeEditor', keys: KEYS.ctrlW },
		{ name: 'hideSideBar', keys: KEYS.ctrlB },

		// The floating layer. `Ctrl+B` brings the side bar back, and list mode's fourth row below
		// `alpha`'s repository row is its one staged change — the same navigation `openDiff` makes.
		// `Shift+F10` is upstream's own keyboard route to a context menu.
		{ name: 'showSideBar', keys: KEYS.ctrlB },

		// The mouse, which is the one input path the keyboard steps say nothing about: a click on the
		// activity bar, a click on a row, and a wheel notch, each routed to the part the column it
		// landed in belongs to (`Workbench.handleMouse`). The coordinates are the arrangement's own —
		// the activity bar is the first three columns and its rows are its entries, the side bar's
		// first row is the container title — so a click that lands in the wrong part fails here.
		{ name: 'mouseExplorer', keys: click(1, 0) },
		{ name: 'mouseSourceControl', keys: click(1, 2) },
		{ name: 'mouseRow', keys: click(10, 3) },
		{ name: 'mouseWheel', keys: wheelDown(10, 5).repeat(3) },

		// `?` is `workbench.action.openGlobalKeybindings` — upstream's own id, on the floating layer
		// because this fork has no settings editor. It is where the keys the status line has no room
		// for are, which is every `tabs`-scope key and whatever a narrow frame cut off.
		{ name: 'keysOverlay', keys: '?' },
		{ name: 'keysClosed', keys: KEYS.escape },

		{ name: 'contextMenu', keys: `3v${KEYS.home}${KEYS.down.repeat(4)}${KEYS.shiftF10}` },
		{ name: 'menuClosed', keys: KEYS.escape },
		// Six rows further down — past the `Changes` group, the `src` folder and the file inside it,
		// and the compacted `zone / deep` row and the file inside that — is `tracked.txt` in the
		// working tree, whose menu offers the one command A1 left unbound: discarding needs a
		// confirmation, and now there is one.
		{ name: 'discardMenu', keys: `${KEYS.down.repeat(6)}${KEYS.shiftF10}` },
		// Three down the menu, past the separator a keyboard skips, is *Discard Changes*.
		{ name: 'discardPrompt', keys: `${KEYS.down.repeat(3)}${KEYS.enter}` },
		{ name: 'discardCancelled', keys: KEYS.escape },
		// And the same menu answered the other way, which is the half nothing drove: a destructive
		// command that *runs* is where the frame stopped being repainted, and a run that only ever
		// declined the confirmation could not see it.
		{ name: 'discardMenuAgain', keys: KEYS.shiftF10 },
		{ name: 'discardPromptAgain', keys: `${KEYS.down.repeat(3)}${KEYS.enter}` },
		{ name: 'discardDone', keys: KEYS.enter },
		// `P` runs `scm.setActiveProvider`, whose `RepositoryPicker` is upstream's own quick pick.
		{ name: 'repositoryPicker', keys: 'p' },
		{ name: 'pickerFiltered', keys: 'gam' },
		{ name: 'pickerCancelled', keys: KEYS.escape },

		// The layout's own two gestures, which upstream reaches by dragging a sash and clicking a
		// twistie. `=` and `-` are `workbench.action.increaseViewSize` / `decreaseViewSize` — upstream's
		// own commands, which resize whichever part has the keyboard through `layout.ts`'s `resizePart`
		// — and the shifted arrows are `paneview.ts`'s own collapse and expand off a focused header.
		//
		// **Both pairs put the layout back where they found it**, because every frame after this one is
		// measured against a divider that has not moved: two increments out and two back is exact, since
		// neither reaches the floor `SidebarPart.minimumWidth` sets.
		{ name: 'widerSideBar', keys: '==' },
		{ name: 'defaultSideBar', keys: '--' },
		{ name: 'collapsedView', keys: KEYS.shiftLeft },
		{ name: 'expandedView', keys: KEYS.shiftRight },

		// Quick access, which is a registry of its own, separate from `IQuickInputService`.
		// **Both keys are upstream's** and neither is invented: `F1` is `ShowAllCommandsAction`'s
		// *secondary* — its primary is `Ctrl+Shift+P`, which is the same byte as `Ctrl+P` on the
		// wire and can never arrive — and `Ctrl+P` is `QuickAccessAction`'s primary.
		//
		// A key that opens an overlay is a step of its own, as every picker in this run is.
		{ name: 'commandPalette', keys: KEYS.f1 },
		{ name: 'paletteFiltered', keys: 'clear com' },
		// **Running one is the discriminating half.** `Clear Command History` is an upstream
		// `Action2` that no key in this fork is bound to, so a palette that only *listed* it would
		// pass every assertion above and none of these: what it does is ask.
		{ name: 'paletteRan', keys: KEYS.enter },
		{ name: 'paletteCancelled', keys: KEYS.escape },

		// `Ctrl+P` is the same box over a different provider: the workspace's files, through
		// `ISearchService.fileSearch` and upstream's own fuzzy scorer. `LICENSE` belongs to one
		// repository, so the folder beside the name is the discriminating half — a picker that
		// listed every file would name it too.
		{ name: 'quickOpen', keys: KEYS.ctrlP },
		{ name: 'quickOpenFiltered', keys: QUICK_OPEN_FILE.name },
		{ name: 'quickOpenOpened', keys: KEYS.enter },

		// `IEditorService` answering for the editors that exist. `FilesFilter` keeps an open file and
		// its parents listed even where `files.exclude` hides it — upstream's own arm — and it cannot
		// while the service answers that nothing is open. `siblings/pair.js` is the file the
		// workspace's `when` clause hides, and quick open is the surface that still reaches it.
		{ name: 'excludedOpen', keys: KEYS.ctrlP },
		{ name: 'excludedFiltered', keys: SIBLING_FILES.hidden[0] },
		{ name: 'excludedOpened', keys: KEYS.enter },
		// `1` is the explorer's own activity-bar digit, and `End` then two `Up`s is `siblings` for the
		// reason the step above says: the filter's change collapsed the tree, and the two files at the
		// root sort after every folder.
		{ name: 'excludedListed', keys: '1' + KEYS.end + KEYS.up.repeat(2) + KEYS.right },
			// A second folder open, one the filter has nothing to do with: `Home` is `.vscode` and one
			// `Down` is `alpha`. Two expansions is what makes the step below discriminating — a refresh
			// that rebuilt from the workspace roots took both, and one that only re-read `siblings`
			// would take the other.
			{ name: 'expandedBeforeEdit', keys: KEYS.home + KEYS.down + KEYS.right },
			// `0` is `focusEditorArea` and `e` is `tscode.editFile` on the editor showing there, which
			// is `siblings/pair.js` — the resource `files.exclude` hides. Opening `$EDITOR` over it
			// takes that editor out of `visibleEditors`, which is the gesture that fires
			// `FilesFilter.onDidChange`, and the refresh behind that event is what collapsed the tree.
			{ name: 'focusedExcluded', keys: '0' },
			{ name: 'editExcluded', keys: 'e', child: true, childText: 'EDITOR-OPENED:' },
			// The same event the other way: closing the child makes `pair.js` visible again, so the
			// filter fires a second time and the row comes back — with the expansion still standing.
			{ name: 'editExcludedClosed', keys: KEYS.ctrlW },

		// The embedded region. `T` is `workbench.action.createTerminalEditor` — upstream's own id — which
		// opens the default system shell as a tab in the editor area, in a pty sized to that rectangle.
		//
		// **`echo quit-is-not-quit` is the input-routing assertion, not a greeting.** Every `q` in it is
		// `tscode.quit` when a pane has focus; the run surviving to the end is half the proof and the
		// echoed line on screen is the other half. Everything about what the shell *painted* is asserted
		// on this frame rather than on the one before it, because whether the banner lands inside the
		// `T` step or after it is a race with how fast the shell starts. **The keys below are not in
		// that race**: `prompt: true` holds the `T` step until the shell has printed a prompt in the
		// workspace, which is the only thing that says it is reading stdin. Without it PowerShell's
		// banner ended the step, this line was typed into a shell still loading its profile, and the
		// bytes went nowhere.
		//
		// **These two are the only steps in the run that wait on something other than the app**,
		// because a shell is the one thing it cannot be asked about: `whenSettled` covers the
		// launch and the tab, and nothing covers what the child decides to write next. So they
		// wait for the child to write and then stop — the banner here, the echo below.
		// In-app editing (§19), which is the one thing in this fork tscode does not have at all.
		// `v` is `tscode.file.edit`, which turns vim mode on over the file the editor area is
		// showing. From there the pane answers `takesKey` for everything
		// the workbench has not been told to keep, so every key below is the buffer's rather than a
		// command: `A` is *append at end of line* and not `git.stage`, and `:` is not a character.
		// The editor the steps above left active is the **diff**, and `tscode.file.edit` is scoped
		// to a file pane — so the file is opened again the way `openReadme` opens it, which brings
		// its tab forward and puts the keyboard in the editor area in one gesture.
		{ name: 'vimFocused', keys: `1${KEYS.end}${KEYS.enter}` },
		{ name: 'vimOn', keys: 'v' },
		// `A` is a motion and an insert-mode entry in one key, so what it proves is both halves —
		// the engine moved the cursor and `viewModel.type` put the characters where it said.
		{ name: 'vimTyped', keys: `A${VIM_MARK}${KEYS.escape}` },
		// `:w` is the engine's own ex command over `TextModelResolver.save`. The suite reads the file
		// back off the disk, because a save that was never made looks exactly like one that was.
		{ name: 'vimWritten', keys: `:w${KEYS.enter}` },
		// The caret is a cell, so a line with no characters has nothing for it to sit on: the
		// README's second line is empty, and `j` from the top is the row that used to paint none.
		{ name: 'vimEmptyRow', keys: 'ggj' },
		// Visual mode in its three shapes, which are three shapes of *range* rather than three
		// features: `v` runs from a column on one line to a column on another, `V` takes whole
		// lines, and `<C-v>` is one range per line. Each crosses the empty line, which is where
		// they read differently — a block clips to what that line has, which is nothing.
		{ name: 'vimVisual', keys: `${KEYS.escape}ggvjjl` },
		{ name: 'vimVisualLine', keys: `${KEYS.escape}ggVjj` },
		{ name: 'vimVisualBlock', keys: `${KEYS.escape}gg${KEYS.ctrlV}jjll` },
		// `:` in visual mode opens the engine's own `'<,'>` range rather than a bare prompt, so the
		// way out of the selection comes first.
		{ name: 'vimOff', keys: `${KEYS.escape}:q${KEYS.enter}` },

		// Opening a search result, which is the one thing in that pane that reaches the editor area.
		// The boxes still hold what the replace steps left in them, so all three are retyped: the
		// include glob narrows the query to `longline.ts`, **the one file in this fixture with two
		// matches of a single word**, which is what tells a file row's *first* match from its last
		// and a second open of the same file from a second tab.
		{ name: 'openQuery', keys: `2i${KEYS.ctrlU}${OPEN_MATCHES.needle}${KEYS.ctrlDown}${KEYS.ctrlU}${OPEN_MATCHES.glob}${KEYS.ctrlDown}${KEYS.ctrlU}${KEYS.escape}` },
		// `Enter` on the file row, which is the row the results open on.
		{ name: 'openedFileRow', keys: KEYS.enter },
		// Straight after it, with no `Escape` in front: `w` is `toggleSearchWholeWord` here and
		// `tscode.file.toggleWordWrap` in the editor area, so which of the two moved says where the
		// keyboard is. `preserveFocus` is the whole assertion.
		{ name: 'keptKeyboard', keys: 'w' },
		// Two rows down is the file's *second* match, and it is the same file — so what this proves
		// is the caret moving inside an editor that was already open.
		{ name: 'openedSecondMatch', keys: `${KEYS.down.repeat(2)}${KEYS.enter}` },
		// And the arrows open nothing: no preview tab exists here, so opening on focus would leave
		// one tab per row (`§7.6`).
		{ name: 'arrowsOpenedNothing', keys: KEYS.up.repeat(2) },
		// `Left` still folds the file row, which is what `Enter` did not take over.
		{ name: 'resultFolded', keys: KEYS.left },

		{ name: 'terminalEditor', keys: 't', child: true, prompt: true },
		{ name: 'terminalEcho', keys: `echo quit-is-not-quit${KEYS.enter}`, child: true, childText: 'quit-is-not-quit' },
		// `Ctrl+W` is the escape gesture: `main.ts` puts `workbench.action.closeActiveEditor` into
		// `terminal.integrated.commandsToSkipShell`, so it is the one key the child does not get.
		// Closing is the workbench's own paint, so these two need nothing of the child.
		{ name: 'terminalClosed', keys: KEYS.ctrlW },
		// A second shell, left *running* when the driver closes stdin — which is what makes the suite's
		// own exit assertion a statement about tearing a live child down rather than about a tidy one.
		{ name: 'terminalLive', keys: 't' }
	]
});

registerLayoutSuite(context);
registerInputBoxSuite();
registerExplorerSuite(context);
registerSearchSuite(context);
registerMarkdownSuite(context);
registerVimSuite(context);
registerScmSuite(context);
registerSaplingSuite(context);
registerInteractionSuite(context);
registerRegionSuite(context);
