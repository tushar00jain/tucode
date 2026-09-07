// The keyboard model: the rule set the takeover leaves, where each row of the keymap acts and
// where it is dead, what `?` lists, and the smartlog's own keys.
//
// **The takeover print is the one instrument this build has carried a gap in.** The unit test can
// only classify a corpus of rules someone wrote down — `KeybindingsRegistry` is filled at import
// time by modules no type-stripping `node` can load — so the set the app resolves with has never
// been read until here. The first step prints it, sorted and stable, which makes a build's rule set
// diffable against the previous build's.
//
// The three assertions that are about this frontend specifically are marked where they are made:
// it keeps `list.scrollLeft`/`list.scrollRight`, it never binds `Ctrl+C`/`Ctrl+V`/`Ctrl+X` at all,
// and accepting a row in `?` runs the command it names.
//
// Upstream counterpart: none — upstream's keys are the stock set, and its own surface for them is
// the keybindings editor, which the cut table removes.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
	acceptQuickPick,
	accessibilityHelpReads,
	activeEditorTab,
	closeQuickOpen,
	closeViewRootFilter,
	effectiveKeybindings,
	editorFind,
	editorFindClose,
	editorFindStep,
	editorWrapping,
	explorerRows,
	focusedElement,
	focusEditorText,
	focusPane,
	keysQuickPick,
	notificationToasts,
	openAccessibilityHelp,
	openFileByQuickOpen,
	openViewRootFilter,
	paneExpanded,
	runCommandByPalette,
	saplingPickRepository,
	saplingSnapshot,
	searchToggles,
	viewRootBoxReads,
	waitForQuickOpen
} from '../lib/probes.mjs';
import { QUIET, READ_TIMEOUT, delay, waitFor, waitForElement } from '../lib/wait.mjs';

/** The command ids the keymap's own rows register, which the keep-set has to hold. */
const KEYMAP_COMMANDS = [
	'tscode.filterExplorer',
	'tscode.scm.filter',
	'tscode.search.filter',
	'tscode.editInput',
	'tscode.deleteWordLeft',
	'tscode.showViewContainer',
	'workbench.files.action.collapseExplorerFolders',
	'workbench.action.openGlobalKeybindings'
];

/**
 * Commands the takeover drops: tree find and type-ahead, because `/` replaces both, and DOM
 * traversal between navigable containers, because `Ctrl+Up`/`Ctrl+Down` already carry
 * `list.scrollUp`/`list.scrollDown`.
 *
 * **The `widgetNavigation` pair is what the live print caught.** Both survived as `text-input`: the
 * resolver hands the filter a `when` in disjunctive normal form, and one of its five clauses is
 * `inputFocus && navigableContainerFocused`, which the classifier read as the whole rule requiring
 * a text box. It now asks whether a rule applies *only* where one does — every clause, not any —
 * and this is the step that says so against the running app.
 */
const DROPPED_COMMANDS = [
	'list.find',
	'list.closeFind',
	'list.toggleFilterOnType',
	'widgetNavigation.focusNext',
	'widgetNavigation.focusPrevious'
];

/**
 * Rules the accessible view and the accessibility help own, which the takeover dropped for as long
 * as nothing checked the claim that those two surfaces keep upstream's keyboard. One from each
 * group, and each is the surface's only way to do the thing: step the view (`Alt+]`), go to a
 * symbol in it (`Ctrl+Shift+O`), open the help's link (`Alt+H`), configure a key from it (`Alt+K`),
 * open either surface at all (`Alt+F1`/`Alt+F2`), and move by command in the terminal's accessible
 * buffer (`Alt+Down`).
 */
const OVERLAY_COMMANDS = [
	'editor.action.accessibilityHelp',
	'editor.action.accessibleView',
	'editor.action.accessibleViewNext',
	'editor.action.accessibleViewPrevious',
	'editor.action.accessibleViewGoToSymbol',
	'editor.action.accessibilityHelpOpenHelpLink',
	'editor.action.accessibilityHelpConfigureKeybindings',
	'workbench.action.terminal.accessibleBufferGoToNextCommand'
];

/**
 * The clipboard a paste step puts on the machine, and what a text box holds once it lands. Two
 * characters the explorer binds to commands with an `Enter` between them — and a single-line
 * `<input>` takes the line break as a space, which is the browser's own rule rather than anything
 * this port decides. Every byte survives, which is the point: nothing was consumed on the way.
 */
const PASTE_PAYLOAD = 'c\nv';
const PASTED = 'c v';

/**
 * The file the explorer's own clipboard is driven over, and the name upstream gives its copy —
 * `incrementFileName`'s `simple` form, which is the default of `explorer.incrementalNaming`. A
 * top-level file, so the paste target is the workspace root and no folder has to be expanded.
 */
const CLIPBOARD_FILE = 'README.md';
const CLIPBOARD_COPY = 'README copy.md';

/** Rows the shared keymap marks `only: 'tui'`, which this frontend declares and never registers. */
const TERMINAL_ONLY_COMMANDS = ['tscode.quit', 'tscode.editFile', 'tscode.showContextMenu'];

/** Puts a folder on screen in an expanded state, so folding is something with an effect. */
async function expandFirstFolder(page) {
	await focusPane(page, 'explorer');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowRight');

	return explorerRows(page, rows => rows.some(row => row.expanded === 'true'));
}

/**
 * What one press of `W` is given to show in the editor before the press is made again. Well under
 * `READ_TIMEOUT`, which bounds the whole toggle, so a lost press gets several attempts inside it.
 */
const WRAP_PRESS_TIMEOUT = 1_500;

/**
 * `W` in the editor, until the editor wraps the way `wrapped` asks. The fixture's 1,200-character
 * line is what makes that observable: it is one model line, and several view lines once wrapping
 * is on.
 *
 * **Pressed until it is, rather than once**, which is `openView`'s discipline and is here for the
 * same reason: there is a window after a click in which a bare-letter row of the map resolves to
 * nothing, so a single press is a press the app can answer with silence. Measured over twenty
 * replays of this step, the last press left the editor wrapped twice with nothing between the
 * click and the key. The state is read before every press, so a press that did land is never
 * taken back — the loop presses only while the editor is not already where it is asked to be, and
 * only the deadline is a failure.
 */
async function toggleWordWrap(page, wrapped, what) {
	const deadline = Date.now() + READ_TIMEOUT;
	for (let presses = 0; ; presses++) {
		const state = await editorWrapping(page);
		if (state.wrapped === wrapped) {
			return state;
		}
		if (Date.now() >= deadline) {
			throw new Error(`${what} after ${presses} presses of \`W\`: the editor is ${JSON.stringify(state)}`);
		}
		await page.keyboard.press('w');
		await editorWrapping(page, value => value.wrapped === wrapped, {
			what,
			timeoutMs: Math.min(WRAP_PRESS_TIMEOUT, Math.max(deadline - Date.now(), 0))
		}).catch(() => undefined);
	}
}

/**
 * `waitFor` over what holds the keyboard, **with where it actually was named in the failure**.
 * Every step here is about the focus moving, so "it did not" is the one thing already known.
 */
async function waitForFocus(page, holds, what) {
	try {
		return await waitFor(async () => holds(await focusedElement(page)), { what });
	} catch (error) {
		throw new Error(`${error.message}. The keyboard is at ${JSON.stringify(await focusedElement(page))}`);
	}
}

/** The keyboard back in the active editor's text, waited for rather than assumed. */
async function backInTheEditor(page) {
	await focusEditorText(page);

	return waitForFocus(page, focus => focus.inEditor, 'the click into the editor never gave it the keyboard');
}

/**
 * One press of a cycling chord, and the pane the keyboard **settles** in.
 *
 * Settles, not lands: a pane's own `focus()` is asynchronous — `SCMViewPane` queues its on a
 * sequencer and picks between the tree and the commit box once it runs — so a single reading can
 * catch the header before the body has taken it, and the next press then goes to a pane that is
 * still moving. Two readings a quiet apart is the same discipline `settledRead` is on.
 */
async function cycleTo(page, chord, from) {
	await page.keyboard.press(chord);

	return waitForFocus(page, async landed => {
		if (!landed.pane || landed.pane === from) {
			return undefined;
		}

		await delay(QUIET);

		return (await focusedElement(page)).pane === landed.pane ? landed.pane : undefined;
	}, `\`${chord}\` never settled the keyboard off ${JSON.stringify(from)}`);
}

/** The commit the smartlog currently draws as selected, once exactly one row is. */
async function selectedCommit(page, what) {
	const snapshot = await waitFor(async () => {
		const state = await saplingSnapshot(page);
		return state.rows.filter(row => row.selected).length === 1 ? state : undefined;
	}, { what });

	return snapshot.rows.findIndex(row => row.selected);
}

export default function registerKeyboardSuite(context) {
	describe('the keyboard takeover', () => {
		it('prints the rule set the running app resolves with, and it is the filtered one', async () => {
			const rules = await effectiveKeybindings(context.page);
			const commands = new Set(rules.map(rule => rule.command));
			const chordsOf = command => rules.filter(rule => rule.command === command).map(rule => rule.chord);

			// The print itself, which is the deliverable: a build's effective set, in the run's log,
			// in the one form that can be diffed against the next build's.
			console.log(`--- effective keybindings (${rules.length}) ---\n${rules.map(rule => [rule.chord, rule.command, rule.reason, rule.when].join('\t')).join('\n')}`);

			assert.ok(rules.length > 50, `only ${rules.length} rules resolved, which is not a workbench's worth`);
			assert.deepEqual(
				rules.map(rule => [rule.chord, rule.command, rule.reason, rule.when].join('\t')),
				[...rules.map(rule => [rule.chord, rule.command, rule.reason, rule.when].join('\t'))].sort(),
				'the print is not sorted, so two builds cannot be diffed by it');

			// **Every surviving default names why it survived.** That is the filter's whole contract:
			// a rule with no keep reason is one the takeover was supposed to have dropped.
			const unexplained = rules.filter(rule => rule.reason === '');
			assert.deepEqual(unexplained, [], `${unexplained.length} rules survive with no keep reason`);

			for (const command of KEYMAP_COMMANDS) {
				assert.ok(commands.has(command), `the keymap's own ${command} is not in the effective set`);
			}
			for (const command of DROPPED_COMMANDS) {
				assert.ok(!commands.has(command), `${command} survived the takeover on ${JSON.stringify(chordsOf(command))}`);
			}
			for (const command of TERMINAL_ONLY_COMMANDS) {
				assert.ok(!commands.has(command), `${command} is a terminal-only row and this frontend registered it`);
			}

			// **This frontend keeps the horizontal pair.** `list.scrollLeft`/`list.scrollRight` are
			// three rows here: upstream registers both commands and binds neither, so this frontend
			// binds them and `workbench.list.horizontalScrolling` is defaulted on for them.
			for (const [command, arrow] of [['list.scrollLeft', 'Left'], ['list.scrollRight', 'Right']]) {
				const chords = chordsOf(command);
				assert.ok(chords.some(chord => chord.startsWith('Ctrl+') && chord.includes(arrow)),
					`${command} resolves to ${JSON.stringify(chords)} rather than to a Ctrl+${arrow}`);
			}
			assert.ok(commands.has('list.focusDown'), 'list navigation did not survive, so the trees have no keyboard at all');

			// **The clipboard chords belong to the surface that has the keyboard**, and to nothing
			// wider: `clipboard.ts` registers the editor's own only when `platform.isNative`, so a
			// text box's copy and paste are the window's and no decision of ours can take them away.
			//
			// What claims them where the window does not is upstream, at its own chords and under
			// its own guards — the terminal panel, whose three commands are in `commandsToSkipShell`
			// so a dropped rule pasted nothing *and* typed nothing, and **the explorer, which copies
			// and pastes files**. That second pair had been dropped on the grounds that a tree has
			// no editable to paste into, which is an argument about text and not about files; every
			// rule below has to name the surface it belongs to, which is what keeps each out of the
			// others.
			//
			// **Both of `Ctrl+V`'s terminal commands, and `Shift+Insert` too.** The keep-set names
			// commands, so a chord upstream answers with *two* of them keeps whichever was named —
			// and `pastePwsh` is the one stock resolves in a PowerShell terminal.
			const surfaces = /terminalFocus|editorFocus|filesExplorerFocus|fileMatchOrMatchFocus|suggestWidgetDetailsFocused/;
			const clipboard = {
				'Ctrl+C': ['filesExplorer.copy', 'search.action.copyMatch', 'suggestWidgetCopy', 'workbench.action.terminal.copyAndClearSelection'],
				'Ctrl+V': ['filesExplorer.paste', 'workbench.action.terminal.paste', 'workbench.action.terminal.pastePwsh'],
				'Ctrl+Shift+V': ['markdown.showPreview', 'workbench.action.terminal.paste'],
				'Ctrl+X': ['filesExplorer.cut'],
				'Shift+Insert': []
			};
			for (const [chord, expected] of Object.entries(clipboard)) {
				const bound = rules.filter(rule => rule.chord === chord);
				assert.deepEqual(bound.map(rule => rule.command), expected, `${chord} resolves to ${JSON.stringify(bound)}`);
				for (const rule of bound) {
					assert.match(rule.when, surfaces, `${chord} is bound where no surface that owns a clipboard has the keyboard: ${JSON.stringify(rule)}`);
				}
			}

			// The keys this phase gave back, each of which had been a *swallowed* chord rather than
			// an unbound one: the editor's find, which is the only search a viewer has, and the
			// toast's `Escape`, whose only other way out is the ✕ and a mouse.
			for (const command of ['actions.find', 'editor.action.nextMatchFindAction', 'closeFindWidget', 'notifications.hideToasts']) {
				assert.ok(commands.has(command), `${command} is not in the effective set, so ${JSON.stringify(chordsOf(command))} reaches nothing`);
			}

			// **The claim `keymap.ts` makes about the two overlays, read off the resolver.** Every
			// row of the map stands down inside the accessible view and the accessibility help, and
			// that half was enforced from the start; the other half — that upstream's own rules for
			// those surfaces answer instead — was false, because each of them is guarded on the very
			// keys the rows stand down on and the filter had no reason that named either. The rules
			// below are what the surfaces had lost, sampled across all three of their groups: the
			// view's own navigation, the help's, and the terminal accessible buffer's.
			for (const command of OVERLAY_COMMANDS) {
				const bound = rules.filter(rule => rule.command === command);
				assert.ok(bound.length > 0, `${command} is not in the effective set, so the accessible view and the accessibility help do not keep upstream's keyboard`);
				for (const rule of bound) {
					assert.equal(rule.reason, 'accessibility-overlay', `${command} survives on ${rule.chord} for ${JSON.stringify(rule.reason)} rather than because an overlay owns the keyboard`);
				}
			}
		});

		/**
		 * **The same claim, driven rather than classified.** The step above says the overlays' rules
		 * are in the resolver; this says the surface answers them. `Alt+F1` is one of the rules the
		 * takeover dropped, so before the keep reason it opened nothing at all, and `Ctrl+Shift+O`
		 * inside it is a second. The negative is the other half of `keymap.ts`'s claim: `?` is the
		 * map's `openGlobalKeybindings` everywhere else in this app and has to reach nothing here.
		 *
		 * **No screen reader is available to this harness**, so the half of the accessibility surface
		 * guarded on `accessibilityModeEnabled` — the terminal's accessible buffer and its six keys —
		 * cannot be driven at all. Those are asserted at the resolver above and nowhere else.
		 */
		it('opens the accessibility help on upstream’s own key, and answers upstream’s keys inside it', async () => {
			const page = context.page;
			// The help is the *focused thing's*, so it needs one: `AccessibleViewService` picks its
			// provider off the focused context and shows nothing where no provider claims it. An
			// editor is the provider this build has, so the step opens one rather than inheriting
			// whatever the previous step left holding the keyboard.
			await openFileByQuickOpen(page, 'alpha/src/app.ts');
			await backInTheEditor(page);

			const help = await openAccessibilityHelp(page);
			assert.equal(help.title, 'Accessibility Help');

			// `editor.action.accessibleViewGoToSymbol` — the surface's own list, and the only way to
			// move around the help by keyboard.
			await page.keyboard.press('Control+Shift+O');
			const symbols = await waitForQuickOpen(page, true,
				'`Ctrl+Shift+O` inside the accessibility help opened nothing, so `accessibleViewGoToSymbol` is not bound there');
			assert.ok(symbols.picks.length > 0, 'the help’s go-to-symbol list came up empty');
			await closeQuickOpen(page);

			// …and no row of the map, which is what `guiModalOverlays` enforces.
			await page.keyboard.press('Shift+Slash');
			await delay(QUIET);
			await waitForQuickOpen(page, false, '`?` opened a quick pick inside the accessibility help, so a row of the keymap fired there');
			await accessibilityHelpReads(page, state => state.open, 'the accessibility help closed on `?`');

			// Left closed, because a modal overlay outlives the step that opened it and every later
			// step's keys would go to it.
			await page.keyboard.press('Escape');
			await accessibilityHelpReads(page, state => !state.open, 'the accessibility help stayed up after `Escape`');
		});

		// **The defect this frontend cannot have, asserted rather than argued.** Where a paste
		// arrives as the same bytes as typing, every character of a clipboard is dispatched as a
		// keystroke and any character bound to a command runs it — a paste beginning `t` opens a
		// shell and feeds it the rest. Here the browser delivers a paste as a `paste` event on
		// whatever holds focus and fires no `keydown` for its contents, so there is no route from
		// pasted text to the keybinding resolver at all.
		//
		// The payload is what makes that discriminating: `c` is the explorer's own
		// `collapseExplorerFolders` and the newline is `Enter`, which commits the box and closes
		// it. If a single character had gone to the resolver, the box could not still be open
		// holding the whole payload — and if the chord itself were claimed anywhere but a terminal,
		// nothing would have been pasted at all.
		it('pastes a whole clipboard into a box as text, and never into the keybinding resolver', async () => {
			const page = context.page;
			await page.evaluate(text => navigator.clipboard.writeText(text), PASTE_PAYLOAD);

			// The box opens holding the view root it filters under, so what a paste adds is read
			// against what it already had rather than against a fixture's directory name.
			const opened = await openViewRootFilter(page, 'explorer');
			await page.keyboard.press('Control+v');
			const box = await viewRootBoxReads(page, `${opened.value}${PASTED}`);
			assert.ok(box.open, 'the `/` box closed on a paste, so its newline was answered as `Enter`');

			await closeViewRootFilter(page);
		});

		// **The other half of `Ctrl+C`/`Ctrl+V`, and the one the takeover had taken away.** Upstream
		// binds cut, copy, paste and cancel-cut on the explorer tree over *files*, and the audit
		// that restored them found the pair had been dropped because a surface with no file
		// clipboard has nothing to copy files to — never a reason for an omission here.
		//
		// Driven end to end rather than read off the resolver, because a rule that resolves is not a
		// file that arrived: the copy is asserted in the tree, on disk, and by its bytes. It is
		// removed again afterwards, since the suites that run after this one count the rows of this
		// same folder.
		//
		// **The cut mark is what makes the sequence race-free.** `setToCopy` awaits the clipboard
		// write before telling the view, so the row carrying `.cut` is the one observable that says
		// the clipboard now holds the file — and a copy over a cut takes the mark off again, which
		// is the same observable for `Ctrl+C`, which has no mark of its own.
		it('cuts, copies and pastes a file in the explorer, and the copy is a real file', async () => {
			const page = context.page;
			const source = join(context.fixture.root, CLIPBOARD_FILE);
			const pasted = join(context.fixture.root, CLIPBOARD_COPY);
			const marked = want => rows => rows.find(row => row.name === CLIPBOARD_FILE)?.cut === want;

			await focusPane(page, 'explorer');
			// `C` folds everything, so the rows the arrows step through are the top level and the
			// index read below is the index the list focus lands on.
			await page.keyboard.press('c');
			const before = await explorerRows(page, rows => rows.every(row => row.expanded !== 'true'));
			const at = before.findIndex(row => row.name === CLIPBOARD_FILE);
			assert.ok(at >= 0, `the explorer is not showing ${CLIPBOARD_FILE}: ${JSON.stringify(before.map(row => row.name))}`);

			await page.keyboard.press('Home');
			for (let step = 0; step < at; step++) {
				await page.keyboard.press('ArrowDown');
			}
			await explorerRows(page, rows => rows.find(row => row.focused)?.name === CLIPBOARD_FILE);

			try {
				await page.keyboard.press('Control+x');
				await explorerRows(page, marked(true));

				// `Escape` is `filesExplorer.cancelCut`, which outranks the `list.clear` on the same
				// key by upstream's own `explorerCommandsWeightBonus` — so the cut is taken back and
				// the row keeps the keyboard.
				await page.keyboard.press('Escape');
				await explorerRows(page, marked(false));

				await page.keyboard.press('Control+x');
				await explorerRows(page, marked(true));
				await page.keyboard.press('Control+c');
				await explorerRows(page, marked(false));

				await page.keyboard.press('Control+v');
				const after = await explorerRows(page, rows => rows.some(row => row.name === CLIPBOARD_COPY));
				const added = after.map(row => row.name).filter(name => !before.some(row => row.name === name));
				assert.deepEqual(added, [CLIPBOARD_COPY], `the paste added ${JSON.stringify(added)}`);

				// The tree drawing a row is the workbench's answer; the file is the file system's.
				assert.ok(existsSync(pasted), `${CLIPBOARD_COPY} is a row in the explorer and not a file on disk`);
				assert.equal(readFileSync(pasted, 'utf8'), readFileSync(source, 'utf8'),
					`${CLIPBOARD_COPY} does not hold what ${CLIPBOARD_FILE} holds`);
			} finally {
				// Through upstream's own refresh, because a deletion made behind the app's back is
				// not one it hears about: this port watches nothing under the workspace, so the tree
				// would go on drawing the row and every later step would count it.
				rmSync(pasted, { force: true });
				await runCommandByPalette(page, 'Refresh Explorer');
				await explorerRows(page, rows => rows.every(row => row.name !== CLIPBOARD_COPY));
				// The keyboard and the list focus back where the next step steps from.
				await focusPane(page, 'explorer');
				await page.keyboard.press('Home');
			}
		});
	});

	describe('the keymap', () => {
		it('answers a pane\'s own letter in that pane, and gives the same letter to the next pane', async () => {
			const page = context.page;
			await expandFirstFolder(page);

			// `C` in the explorer is `workbench.files.action.collapseExplorerFolders`.
			await page.keyboard.press('c');
			await explorerRows(page, rows => rows.every(row => row.expanded !== 'true'));

			// The same letter in the search pane is `toggleSearchCaseSensitive` and nothing else —
			// which is the `view:` scope working in both directions, since a row that leaked out of
			// its pane would fold the explorer from here. No query is run first: what the row acts on
			// is the widget, and a cold search engine is a fifteen-second wait this step does not owe.
			await focusPane(page, 'search');
			const before = await searchToggles(page);
			await page.keyboard.press('c');
			await waitFor(async () => (await searchToggles(page)).caseSensitive !== before.caseSensitive,
				{ what: '`C` in the search pane did not toggle case sensitivity' });

			// Put it back, so the search suites' own queries are read with the filters they set.
			await page.keyboard.press('c');
			await waitFor(async () => (await searchToggles(page)).caseSensitive === before.caseSensitive,
				{ what: 'the case-sensitivity toggle did not go back' });
		});

		// **§11 names this as G1's own gate.** An `editor:` row expands to
		// `activeEditor == <pane> && editorTextFocus` here and to `!inputFocus` in the terminal
		// frontend, because a focused Monaco always sets `inputFocus` — so `editorTextFocus` is the
		// term that means what the terminal's `!inputFocus` means over an editor.
		it('gives an editor row to the editor, and the same letter to a pane that has one', async () => {
			const page = context.page;
			await openFileByQuickOpen(page, 'alpha/src/longline.ts');
			await closeQuickOpen(page);
			// The keyboard waited for rather than assumed, because a `W` the editor never received
			// looks from the outside exactly like a `W` it received and ignored.
			await backInTheEditor(page);

			// `W` is `tscode.file.toggleWordWrap`.
			const start = await editorWrapping(page);
			assert.ok(!start.wrapped, `the file was already wrapping before \`W\` was pressed: ${JSON.stringify(start)}`);
			await toggleWordWrap(page, true, '`W` in the editor did not wrap the long line');

			// The same letter in the search pane is `toggleSearchWholeWord`, and it does not reach
			// the editor — the editor is still wrapped afterwards.
			await focusPane(page, 'search');
			const before = await searchToggles(page);
			await page.keyboard.press('w');
			await waitFor(async () => (await searchToggles(page)).wholeWord !== before.wholeWord,
				{ what: '`W` in the search pane did not toggle whole word' });
			const still = await editorWrapping(page);
			assert.ok(still.wrapped, `\`W\` in the search pane unwrapped the editor: ${JSON.stringify(still)}`);

			await page.keyboard.press('w');
			await waitFor(async () => (await searchToggles(page)).wholeWord === before.wholeWord,
				{ what: 'the whole-word toggle did not go back' });
			await backInTheEditor(page);
			await toggleWordWrap(page, false, 'the editor did not unwrap again');
		});
	});

	// The cycling gesture, which is the one place a row carries its own chord here: a wire cannot
	// deliver `Ctrl+Tab` — it is the byte `Tab` already is — so the declared chord stays bare `Tab`
	// and this frontend takes the modifier.
	//
	// **Both halves are asserted, and the negative one is the point.** Bare `Tab` doing nothing of
	// ours is what hands the key back to browser focus traversal, which is a *default action* and so
	// was never something the takeover could filter: the port had it half-taken, swallowed where a
	// row matched and walking to the next button where none did. A step that only checked the
	// modifier would pass with the old bare rows still registered.
	describe('`Ctrl+Tab`, and the bare `Tab` it gives back', () => {
		it('cycles the editors, where a bare Tab now reaches no rule of ours', async () => {
			const page = context.page;
			// Two ordinary files. **Not `longline.ts`**: its 1,200-character line renders as a
			// 9,500-pixel view line that the editor has scrolled sideways, and clicking into that after
			// the preview suite has run leaves the keyboard on `body` — a harness fragility of
			// `focusEditorText`, and nothing this step is about.
			await openFileByQuickOpen(page, 'alpha/src/app.ts');
			await closeQuickOpen(page);
			await openFileByQuickOpen(page, 'alpha/LICENSE');
			await closeQuickOpen(page);
			await backInTheEditor(page);

			const opened = await activeEditorTab(page);
			assert.equal(opened, 'LICENSE', `the second file never became the active editor: ${JSON.stringify(opened)}`);

			// The negative half. A press that runs nothing has no state change to wait for, so the
			// wait is the one thing it can be: long enough for a rule to have fired if one had.
			await page.keyboard.press('Tab');
			await delay(QUIET);
			assert.equal(await activeEditorTab(page), opened, 'a bare `Tab` in the editor still switched editors');

			// And the modifier, from inside the editor's own text — which is where a bare `Tab` could
			// never have worked anyway, because Monaco's own `tab` outranks a workbench rule there.
			// The traversal above has taken the keyboard out of the editor, and which of the two
			// cycling rules answers is `editorAreaFocus`, so the click has to have landed first.
			await backInTheEditor(page);
			await page.keyboard.press('Control+Tab');
			await waitFor(async () => await activeEditorTab(page) !== opened,
				{ what: '`Ctrl+Tab` in the editor never switched to another editor' });

			await backInTheEditor(page);
			await page.keyboard.press('Control+Shift+Tab');
			await waitFor(async () => await activeEditorTab(page) === opened,
				{ what: '`Ctrl+Shift+Tab` never went back to the editor `Ctrl+Tab` came from' });
		});

		// **And the pane it lands on has to have a body.** `paneview.ts:327` renders a pane's body
		// only if it is expanded when it is rendered, so a *collapsed* view has never run `renderBody`
		// and every field its `focus()` override reads is still undefined — which is the reported
		// `Cannot read properties of undefined (reading 'domFocus')`, one pane along. The command now
		// pairs `setExpanded(true)` with the focus, which is upstream's own `openView` body.
		it('opens a collapsed view it cycles into, rather than focusing a pane with no body', async () => {
			const page = context.page;
			await focusPane(page, 'scm');
			const start = await focusedElement(page);

			const neighbour = await cycleTo(page, 'Control+Tab', start.pane);
			await page.keyboard.press('Shift+ArrowLeft');
			await waitFor(async () => !await paneExpanded(page, neighbour),
				{ what: `\`Shift+Left\` never collapsed ${JSON.stringify(neighbour)}` });

			await cycleTo(page, 'Control+Shift+Tab', neighbour);

			// The press that used to reach a `focus()` override over a tree that was never built.
			const reported = context.app.consoleErrors.length;
			await cycleTo(page, 'Control+Tab', start.pane);
			const raised = context.app.consoleErrors.slice(reported)
				.filter(error => error.includes('Cannot read properties of undefined'));

			assert.deepEqual(raised, [], `cycling into the collapsed ${JSON.stringify(neighbour)} threw: ${JSON.stringify(raised)}`);
			assert.ok(await paneExpanded(page, neighbour), `${JSON.stringify(neighbour)} took the keyboard while still collapsed`);

			// Back where the suites after this one expect it, by the probe rather than by the key —
			// this step is about the pane it lands on, and the return trip is already asserted above.
			await focusPane(page, 'scm');
		});

		// **And it has to have something that can take the keyboard.** The Sapling container is the
		// one whose second view is neither a list nor a tree, and `ViewPane.focus()`'s fallback is
		// `element.focus()` on the `.pane` div, which carries no `tabindex` and does nothing — so
		// the cycle ran, landed on Commit Info, and the keyboard stayed in the smartlog. Read from
		// the outside that is a dead key, which is how it was reported.
		it('cycles between the smartlog and the commit info beside it', async () => {
			const page = context.page;
			await focusPane(page, 'sapling');

			const landed = await cycleTo(page, 'Control+Tab', 'Smartlog');
			assert.equal(landed, 'Commit Info', '`Ctrl+Tab` in the smartlog did not give the keyboard to the commit info view');
			assert.equal(await cycleTo(page, 'Control+Tab', landed), 'Smartlog', '`Ctrl+Tab` never came back to the smartlog');

			await focusPane(page, 'scm');
		});
	});

	// **The row that made `stock: true` a lie, driven rather than read.** Nothing could see it from
	// the outside: the row declared `editorAreaFocus && editorIsOpen`, the unit suite asserted the
	// row, and the app went on answering upstream's own rule, which carries no `when` at all. A
	// keystroke in a window is the only place the declaration and the behaviour can be told apart.
	describe('`Ctrl+W` and `Ctrl+U`, which the box that has the keyboard answers', () => {
		it('erases a word in the `/` box, and still closes an editor outside it', async () => {
			const page = context.page;
			// Two ordinary files, for the reason the `Ctrl+Tab` step gives: `longline.ts` leaves the
			// keyboard on `body` when it is clicked into.
			await openFileByQuickOpen(page, 'alpha/src/app.ts');
			await closeQuickOpen(page);
			await openFileByQuickOpen(page, 'alpha/LICENSE');
			await closeQuickOpen(page);

			const opened = await activeEditorTab(page);
			assert.equal(opened, 'LICENSE', `the second file never became the active editor: ${JSON.stringify(opened)}`);

			const prefill = (await openViewRootFilter(page, 'explorer')).value;
			try {
				await page.keyboard.press('End');
				await page.keyboard.type('one/two');
				await viewRootBoxReads(page, `${prefill}one/two`);

				// **The boundary is what is asserted, not the deletion.** `/` is one of upstream's
				// own `USUAL_WORD_SEPARATORS`, so one press takes `two` and leaves the path in front
				// of it — where readline's whitespace rule, the other plausible answer, would have
				// taken `one/two` and the prefilled path above it in the same keystroke.
				await page.keyboard.press('Control+w');
				const erased = await viewRootBoxReads(page, `${prefill}one/`);

				assert.equal(await activeEditorTab(page), opened, '`Ctrl+W` closed an editor from inside the `/` box');
				assert.ok(erased.focused, '`Ctrl+W` took the keyboard out of the box');

				// `Ctrl+U` is the other half of the pair, and it clears the whole line rather than
				// stopping where the prefill ended.
				await page.keyboard.press('Control+u');
				await viewRootBoxReads(page, '');
			} finally {
				await closeViewRootFilter(page).catch(() => { /* the step's own failure is the report */ });
			}

			// The other side of the same key, without which this would pass on a `Ctrl+W` that is
			// simply dead: outside a box it is upstream's rule, and upstream's closes the editor.
			await backInTheEditor(page);
			await page.keyboard.press('Control+w');
			await waitFor(async () => await activeEditorTab(page) !== opened,
				{ what: '`Ctrl+W` in the editor area no longer closes the active editor' });
		});
	});

	// **The one key on this list with nothing standing in for it.** `/` is the vim engine's and vim
	// is not attached in the viewer, so a dropped `Ctrl+F` left a read-only text pane with no way to
	// search it at all — and the rule that took the chord away everywhere else was about *trees*,
	// which an editor is not. Three commands rather than one, because a find that cannot be stepped
	// or closed is not the feature.
	describe('`Ctrl+F`, which is the only search a viewer has', () => {
		it('opens the find widget, counts the matches, steps them and closes on Escape', async () => {
			const page = context.page;
			await openFileByQuickOpen(page, 'alpha/src/app.ts');
			await closeQuickOpen(page);
			await backInTheEditor(page);

			// `text` is on three lines of the fixture's `app.ts` and nowhere in it as `Text`, so the
			// count is a fact about the file rather than about a widget that merely opened.
			const found = await editorFind(page, 'text');
			assert.equal(found.count, 3, `the find widget answers ${JSON.stringify(found.label)} for a word the file holds three times`);
			assert.ok(found.index >= 1, `no match is the current one: ${JSON.stringify(found.label)}`);

			// `Enter` in the box is upstream's *second* rule for the same command, which rides along
			// on a keep-set that names commands rather than chords.
			const stepped = await editorFindStep(page);
			assert.equal(stepped.count, 3, `stepping changed how many matches the file holds: ${JSON.stringify(stepped.label)}`);
			assert.notEqual(stepped.index, found.index, `Enter stayed on match ${found.index} of ${found.count}`);

			assert.equal((await editorFindClose(page)).visible, false);
		});
	});

	// `Escape` over a toast, which upstream answers with `notifications.hideToasts` and this port had
	// dropped — leaving the ✕ and a mouse. The toast is raised by a command that reports rather than
	// acts, so the step's own subject is the key and not what raised it.
	describe('`Escape`, and the notification toast it puts away', () => {
		it('hides a toast the workbench raised', async () => {
			const page = context.page;
			// From a focused tree, which is where upstream's rule is the one that answers `Escape`:
			// it is registered at `WorkbenchContrib - 50` deliberately, below every other owner of
			// the key, so a focused *box* keeps `tscode.stopEditingInput` and the toast waits.
			await focusPane(page, 'explorer');

			// The ellipsis is load-bearing: `Join Terminals` without it is `TerminalCommandId.
			// JoinInstance`, which does nothing at all when the terminal list has no selection — and
			// a step raising its toast from a silent no-op would fail as a missing key.
			const ran = await runCommandByPalette(page, 'Join Terminals...');
			const raised = await notificationToasts(page, toasts => toasts.length > 0,
				`a notification toast to appear after running ${JSON.stringify(ran[0]?.label)}`);
			assert.match(raised.join(' '), /Insufficient terminals/i, `the command raised ${JSON.stringify(raised)} rather than the warning this step is about`);

			await page.keyboard.press('Escape');
			assert.deepEqual(
				await notificationToasts(page, toasts => toasts.length === 0, '`Escape` never hid the notification toast'),
				[]);
		});
	});

	// `?`, which is the keymap read through the resolver rather than a second list. Bug 4 of the
	// user's runtime session is its specification: the list is the **focused panel's**, plus the
	// rows that work anywhere, and a row forwarding to an upstream command whose own rule carries
	// no `when` — `tscode.file.toggleWordWrap` → `editor.action.toggleWordWrap` — was the leak.
	describe('`?`, the keys quick pick', () => {
		it('lists the focused pane\'s keys and no other pane\'s', async () => {
			const page = context.page;
			await focusPane(page, 'explorer');
			const inExplorer = (await keysQuickPick(page)).map(entry => entry.label);
			await closeQuickOpen(page);

			assert.ok(inExplorer.includes('Collapse Folders in Explorer'), `the explorer's own key is missing: ${JSON.stringify(inExplorer)}`);
			for (const label of ['Stage Changes', 'List/Tree', 'Toggle Word Wrap']) {
				assert.ok(!inExplorer.includes(label), `${JSON.stringify(label)} is another panel's key and the explorer listed it`);
			}
			// One entry per command, however many rows it has: `tscode.showViewContainer` is nine
			// rows carrying nine arguments and one command with one key.
			assert.equal(inExplorer.filter(label => label === 'Show View Container').length, 1,
				`Show View Container is listed ${inExplorer.filter(label => label === 'Show View Container').length} times`);

			await focusPane(page, 'scm');
			const inScm = (await keysQuickPick(page)).map(entry => entry.label);
			await closeQuickOpen(page);

			assert.ok(inScm.includes('List/Tree'), `source control's own keys are missing: ${JSON.stringify(inScm)}`);
			assert.ok(inScm.includes('Stage Changes'), `source control's own keys are missing: ${JSON.stringify(inScm)}`);
			assert.ok(!inScm.includes('Collapse Folders in Explorer'), 'source control listed the explorer\'s key');
		});

		// **The list is picked from, not only read**: accepting a row runs the command it names, at
		// the focus the row was listed for, which is what makes `?` a way to use a key rather than a
		// second place to read one. `Escape` is still the way out that runs nothing.
		it('runs the command a row names when the row is accepted', async () => {
			const page = context.page;
			const collapse = 'Collapse Folders in Explorer';
			const expandedFolder = async () => (await expandFirstFolder(page)).find(row => row.expanded === 'true').name;
			const stillOpen = async folder => (await explorerRows(page)).find(row => row.name === folder)?.expanded;

			// **The control first, and it is what makes the second half mean anything**: the same
			// row, narrowed to the same one pick, left on `Escape`. If the folder folds here too then
			// it was the typing or the focus that ran the command and not the acceptance.
			const dismissed = await expandedFolder();
			await keysQuickPick(page);
			await page.keyboard.type(collapse);
			await closeQuickOpen(page);
			assert.equal(await stillOpen(dismissed), 'true', 'the folder folded while `?` was merely open');

			// The folder by name rather than "nothing is open": the command it named folds every
			// folder, so the one this step opened is exactly what has to go.
			const accepted = await expandedFolder();
			await keysQuickPick(page);
			await acceptQuickPick(page, collapse);
			await explorerRows(page, rows => rows.find(row => row.name === accepted)?.expanded !== 'true');
			assert.notEqual(await stillOpen(accepted), 'true',
				`accepting \`${collapse}\` in \`?\` did not run it: ${JSON.stringify(await explorerRows(page))}`);
		});
	});

	// The smartlog answers its arrows in a widget-local `keydown` rather than as keybindings — the
	// resolver listens on the window in bubble phase, so the widget is first — and its letters are
	// `view:` rows like any other pane's.
	describe('the smartlog keyboard', () => {
		it('steps the selection with the arrows', async () => {
			const page = context.page;
			// The graph first, and it has to be one with commits to step *between*: `alpha` is the
			// repository the pane draws when nothing has picked otherwise and its whole history is a
			// single commit, so an arrow there has nowhere to go and the step would be asserting
			// against the fixture rather than against the keyboard. `delta` is the one with a graph.
			const { snapshot: graph } = await saplingPickRepository(page, 'delta');
			assert.ok(graph.rows.length > 1, `the smartlog drew ${graph.rows.length} rows: ${graph.message || graph.welcome}`);
			await focusPane(page, 'sapling');

			// Down and then Up, rather than Down twice. The step starts from ".", which the fixture
			// puts between the tip and the root, and the arrows *clamp* at the ends as
			// `useArrowKeysToChangeSelection` does — so a second Down off the last row is a press
			// that correctly moves nothing, and one direction alone could never tell that apart
			// from an arrow that was never answered.
			const dot = graph.rows.findIndex(row => row.isDot);
			await page.keyboard.press('ArrowDown');
			const first = await selectedCommit(page, 'the smartlog never selected a commit on the first Down');
			assert.equal(first, dot + 1, 'Down did not step to the row below "."');

			await page.keyboard.press('ArrowUp');
			const second = await waitFor(async () => {
				const index = await selectedCommit(page, 'the smartlog lost its selection on the Up');
				return index !== first ? index : undefined;
			}, { what: 'the Up did not move the selection' });
			assert.equal(second, first - 1, 'the selection did not step back to the previous row of the graph');
		});

		// Its own step, because it is the pane's `view:` row rather than its widget's own `keydown`
		// — and it says something about the keymap whatever the graph under it holds.
		it('opens the repository picker on P', async () => {
			const page = context.page;
			await saplingSnapshot(page);
			await focusPane(page, 'sapling');

			await page.keyboard.press('p');
			await waitForElement(page, '.quick-input-widget .quick-input-list .monaco-list-row', {
				state: 'visible',
				what: '`P` in the Sapling pane never opened a repository picker with a row in it'
			});
			await closeQuickOpen(page);
		});
	});
}
