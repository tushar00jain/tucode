// `/` — one grammar, three panes. The box is `viewRootBox.ts`'s and the query, the descent, the
// ranking and the completion are `viewRoot.ts`'s, which is a DOM-free module
// pasted whole; what each pane supplies is what a rebuild is and what `Enter` commits to.
//
// The sentences asserted here are claims about the grammar — "`/` opens on the
// folder being looked at and moves nothing", "`Tab` cycles a frozen candidate list", "`Escape` puts
// the root back". **What could not travel is every line of the driving**: those suites assert over
// frames a session script recorded, and these drive a live window and wait on a repaint. See
// `README.md` on what the two harnesses do and do not share.
//
// Upstream counterpart: none — upstream's explorer has a *find* widget, which narrows a whole tree
// and never moves the item the tree is displayed from.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NEEDLES, REPOSITORIES, SIBLING_FILES, TOP_LEVEL } from '../lib/fixture.mjs';
import { closeViewRootFilter, focusedElement, focusPane, focusSearchQueryBox, openViewRootFilter, paneRows, textSearch, viewRootBox, viewRootBoxReads } from '../lib/probes.mjs';
import { waitFor } from '../lib/wait.mjs';

const sorted = names => [...names].sort();

/**
 * Whether the explorer is showing its own root: every row at the top level, and every entry the
 * fixture puts there among them. A count is the wrong reading — `.vscode` is a row too — and what
 * each `/` step is about is the *set* of rows a query left, not how many there are.
 */
const isTopLevel = rows => rows.every(row => row.level === 1) && TOP_LEVEL.every(name => rows.some(row => row.name === name));

/**
 * The explorer with every folder folded, which is the state each `/` step is measured against —
 * `C` is `workbench.files.action.collapseExplorerFolders`, and the suites that ran before this one
 * leave folders open behind them.
 */
async function atTopLevel(page) {
	await focusPane(page, 'explorer');
	await page.keyboard.press('c');

	return paneRows(page, 'explorer', rows => isTopLevel(rows) && rows.every(row => row.expanded !== 'true'));
}

/**
 * Runs a step with the pane's `/` open, and leaves no box behind however the step ends.
 *
 * **A box left open is every later step's failure rather than this one's**: it holds `inputFocus`,
 * so the next `/` types a literal slash into it instead of opening the next pane's box, and a run
 * then reports one defect as five.
 */
async function withViewRootFilter(page, name, body) {
	const box = await openViewRootFilter(page, name);
	try {
		return await body(box);
	} finally {
		if ((await viewRootBox(page)).open) {
			await closeViewRootFilter(page).catch(() => { /* the step's own failure is the report */ });
		}
	}
}

/**
 * What `Tab` writes for a row: **the path in front of the last segment, and then the row's name** —
 * `completeQuery`'s own answer, so the box still names where the pane is rooted and the next `/`
 * typed descends from there rather than from the top.
 */
const completedTo = name => name;

/**
 * A result row from the file the query is *not* narrowed to — present before a `/` query, gone
 * while one is applied, and back once the box closes. Every search step reads the filtering off
 * this one row rather than off a count, since the results list is virtualised.
 */
const hasSiblingPair = rows => rows.some(row => row.name.includes('pair.ts'));

/**
 * The search pane holding the sibling needle's results, focused, and the rows it is showing —
 * the state both `/` steps start from, and the count each of them asserts came back.
 *
 * **The three travel together**: a step that queried without focusing the pane would open the
 * next `/` somewhere else, and one that read the rows before the results arrived would measure a
 * restore against an empty list and pass whatever the box did.
 */
async function searchResults(page) {
	await textSearch(page, NEEDLES.sibling);
	await focusPane(page, 'search');

	return paneRows(page, 'search', hasSiblingPair);
}

/** The rows the box filtered, all of them, back. */
async function assertResultsRestored(page, before) {
	const restored = await paneRows(page, 'search', hasSiblingPair);
	assert.equal(restored.length, before.length, 'the rows the box filtered did not all come back');
}

export default function registerViewRootFilterSuite(context) {
	describe('`/` in the explorer', () => {
		// **It opens on the folder being looked at — the view root — rather than on the folder under
		// the cursor**, so it moves nothing. Paths are relative to the original tree input.
		it('opens prefilled with the folder being looked at, and moves nothing', async () => {
			const page = context.page;
			await atTopLevel(page);
			await withViewRootFilter(page, 'explorer', async box => {
				assert.equal(box.value, '');
				// The next thing typed has to extend the path the box opened on, which is only true
				// if the caret is behind it.
				assert.equal(box.caret, box.value.length, 'the caret is not at the end of the prefilled path');

				const rows = await paneRows(page, 'explorer');
				assert.ok(isTopLevel(rows), `\`/\` moved the pane: ${JSON.stringify(rows.map(row => row.name))}`);
			});
		});

		// The ranking, and `Tab` over it. The three halves that matter: the box reads the row the
		// cursor was taken to, the candidate list is frozen while it cycles — a completion re-run as
		// a query would leave one row to move to — and the cycle wraps.
		it('ranks one level by the query, and Tab cycles the rows it ranked', async () => {
			const page = context.page;
			await atTopLevel(page);
			const ranked = ['README.md', 'beta', 'delta'];
			await withViewRootFilter(page, 'explorer', async () => {
			// `End` rather than trusting the caret: where it opens is test one's assertion, and this
			// step is about the ranking rather than about the box.
			await page.keyboard.press('End');
			await page.keyboard.type('ea');
			// The typed query, read back before the rows are: a box that did not take the keystrokes
			// and a query that took them and ranked nothing are two different failures.
			assert.equal((await viewRootBox(page)).value, 'ea');

			const rows = await paneRows(page, 'explorer', current => current.length === ranked.length);
			assert.deepEqual(rows.map(row => row.name), ranked);
			// Discriminating: `FileSorter` puts every directory first, so a list that had not been
			// re-sorted by the query would answer `beta, delta, README.md` — the same three rows.
			assert.equal(rows[0].name, ranked[0], 'the contiguous match is not first, so the rows are still in the sorter\'s order');

			await page.keyboard.press('Tab');
			await viewRootBoxReads(page, completedTo(ranked[0]));
			await page.keyboard.press('Tab');
			await viewRootBoxReads(page, completedTo(ranked[1]));
			assert.deepEqual((await paneRows(page, 'explorer')).map(row => row.name), ranked, 'the completion was re-run as a query');

			await page.keyboard.press('Shift+Tab');
			await viewRootBoxReads(page, completedTo(ranked[0]));
			await page.keyboard.press('Shift+Tab');
			await viewRootBoxReads(page, completedTo(ranked.at(-1)));
			});

			await paneRows(page, 'explorer', isTopLevel);
		});

		// A `/` in the query is a **view root**: the pane is displayed from that folder. `Escape`
		// puts back the root the box was opened on, whatever the query did to it in between.
		it('re-roots the pane on a path, and puts the root back on Escape', async () => {
			const page = context.page;
			await atTopLevel(page);
			await withViewRootFilter(page, 'explorer', async () => {
				await page.keyboard.press('End');
				await page.keyboard.type(`${SIBLING_FILES.folder}/`);

				const rooted = await paneRows(page, 'explorer', rows => rows.length === SIBLING_FILES.visible.length);
				assert.deepEqual(sorted(rooted.map(row => row.name)), sorted(SIBLING_FILES.visible));
			});

			const restored = await paneRows(page, 'explorer', isTopLevel);
			assert.ok(isTopLevel(restored), `the root did not come back: ${JSON.stringify(restored.map(row => row.name))}`);
		});

		// `Enter` commits the row the ranking put the cursor on — a folder becomes the view root and
		// the box closes on its contents. Re-opening is what says where the pane now is, since the
		// box opens prefilled with its own root.
		it('commits a ranked folder as the pane\'s root on Enter', async () => {
			const page = context.page;
			await atTopLevel(page);
			await withViewRootFilter(page, 'explorer', async () => {
				await page.keyboard.press('End');
				await page.keyboard.type(SIBLING_FILES.folder);
				await page.keyboard.press('Enter');
			});

			const committed = await paneRows(page, 'explorer', rows => rows.length === SIBLING_FILES.visible.length);
			assert.deepEqual(sorted(committed.map(row => row.name)), sorted(SIBLING_FILES.visible));
			assert.equal((await viewRootBox(page)).open, false, 'the box is still open after Enter');

			// And back to the top, through the same two gestures: an empty query is the root of the
			// workspace, and `Enter` with nothing typed commits where the pane already is.
			await withViewRootFilter(page, 'explorer', async box => {
				assert.equal(box.value, `${SIBLING_FILES.folder}/`);
				await page.keyboard.press('Control+a');
				await page.keyboard.press('Backspace');
				await paneRows(page, 'explorer', isTopLevel);
				await page.keyboard.press('Enter');
			});

			const top = await paneRows(page, 'explorer', isTopLevel);
			assert.ok(isTopLevel(top), `the pane did not commit back to the top: ${JSON.stringify(top.map(row => row.name))}`);
			assert.equal((await viewRootBox(page)).open, false, 'the box is still open after Enter');
		});
	});

	// Source control's rows are two levels — repositories at the top, a group's rows under a group
	// — so its rebuild is `updateChildren()` rather than the explorer's `resort`, and its ranked
	// top level is the repositories.
	describe('`/` in source control', () => {
		// **A repository is read by what its row says about its level, not by counting the rows on
		// screen.** This pane's list is virtualised and shares a container with the Graph, so it
		// renders a *window* onto the repositories rather than all of them — the rows drawn are
		// whichever ones fit, and one merely scrolled out of that window is indistinguishable from
		// one the query took away. `setSize` is the level's own `visibleChildrenCount` and `posInSet`
		// the row's place in it, so both facts come off a single row that happens to be drawn.
		it('hides the repositories the query does not name, and puts them back on Escape', async () => {
			const page = context.page;
			const repositories = rows => rows.filter(row => row.level === 1);
			const countsFour = rows => repositories(rows).every(row => row.setSize === REPOSITORIES.length);
			const drawn = await paneRows(page, 'scm', rows => repositories(rows).length > 0 && countsFour(rows));
			const before = Object.fromEntries(repositories(drawn).map(row => [row.name, row.posInSet]));

			await withViewRootFilter(page, 'scm', async () => {
				await page.keyboard.press('End');
				await page.keyboard.type('gamma');

				// **A repository that does not match is hidden, which is what the explorer does with
				// a folder.** It was ranked and never hidden, on the reasoning that a repository row
				// has no name to filter on — and it has one: `SCMRanking.name` answers
				// `provider.name` and `scoreFor` scores it through `repositoryQuery`. The score was
				// always there; only the visibility ignored it.
				//
				// `gamma` shares no subsequence with `alpha`, `beta` or `delta` — none of them holds
				// a `g` — so the level is left with exactly one row, and `setSize` says so from
				// whichever row the virtualised window happens to have drawn.
				const filtered = await paneRows(page, 'scm', rows => repositories(rows).some(row => row.name === 'gamma'));
				const survivors = repositories(filtered);

				assert.deepEqual(survivors.map(row => row.name), ['gamma'],
					`the query left more than the repository it names: ${JSON.stringify(survivors)}`);
				assert.ok(survivors.every(row => row.setSize === 1),
					`a repository the query does not name is still counted in the level: ${JSON.stringify(survivors)}`);
			});

			// Escape restores every repository, in the order they were in before the box opened.
			await paneRows(page, 'scm', rows => countsFour(rows)
				&& repositories(rows).every(row => before[row.name] === undefined || before[row.name] === row.posInSet));
		});

		// **The last segment ranks one level, and this is the pane where that can be seen going
		// wrong.** The changes pane opens expanded, so the files under every repository are already
		// drawn; the explorer's equivalents are behind a twistie, so a query there could never reach
		// them however wide its scope was. Ranking every group's rows wherever they were therefore
		// looked identical in the explorer and emptied the tree here: a repository name typed at the
		// top level is *not* a name any file has, so every repository's files went away one character
		// before the segment was finished, and the pane came back only when the query grew a `/` and
		// the repository took root.
		//
		// The reading is the group headers rather than a row count, because the list is virtualised:
		// a header that says it has changes and is followed by a row of its own level or higher is a
		// group whose files the query took, wherever the window happens to sit.
		it('leaves the other repositories\' files alone while a repository name is typed', async () => {
			const page = context.page;
			const [named] = REPOSITORIES;
			const emptied = rows => rows.flatMap((row, at) => {
				const count = /^.*Changes (\d+)$/.exec(row.name);

				return count && Number(count[1]) > 0 && at + 1 < rows.length && rows[at + 1].level <= row.level ? [row.name] : [];
			});

			const before = await paneRows(page, 'scm');
			assert.deepEqual(emptied(before), [], `a group was already empty before anything was typed: ${JSON.stringify(before)}`);

			await withViewRootFilter(page, 'scm', async () => {
				await page.keyboard.press('End');

				// One character at a time, because the report is about *when* it empties: the whole
				// name never matched a file either, and a step that typed it whole could pass on a
				// query the pane had not been asked one keystroke at a time.
				for (const [at, character] of [...named].entries()) {
					await page.keyboard.type(character);
					await viewRootBoxReads(page, named.slice(0, at + 1));

					const rows = await paneRows(page, 'scm');
					assert.deepEqual(emptied(rows), [],
						`\`${named.slice(0, at + 1)}\` emptied a group that still says it has changes: ${JSON.stringify(rows)}`);
				}
			});
		});
	});

	// Search is the pane with the box and no view root: `/` filters the rows that are already
	// there, over a tree that refuses `TreeVisibility.Recurse` — which is why a changed query is
	// `updateChildren()` here, where a pane that is not a tree would only refilter.
	describe('`/` over the search results', () => {
		it('narrows the result rows as it is typed, and restores them on Escape', async () => {
			const page = context.page;
			const before = await searchResults(page);

			await withViewRootFilter(page, 'search', async () => {
				await page.keyboard.type('lone');
				const narrowed = await paneRows(page, 'search', rows => !hasSiblingPair(rows));
				assert.ok(narrowed.some(row => row.name.includes('lone.js')), `the query left ${JSON.stringify(narrowed.map(row => row.name))}`);
			});

			await assertResultsRestored(page, before);
		});

		// **The click a user reaches this by.** `Enter` and `Escape` are answered at the input element,
		// so focus leaving the box is the one gesture no key can answer: the box stayed open over a
		// filtered tree, still publishing `tscodeFiltering` — and while that key is set, `Tab` and
		// `Shift+Tab` complete in a box the user has walked away from instead of switching editors,
		// everywhere in the window. So a blur is `Escape`, and the two halves are asserted apart:
		// the rows come back, **and the keyboard stays where the click put it** rather than being
		// taken back by the tree the closing arm re-focuses after an `Escape`.
		it('closes on a click that takes the keyboard out of it, and leaves the keyboard there', async () => {
			const page = context.page;
			const before = await searchResults(page);

			await openViewRootFilter(page, 'search');
			await page.keyboard.type('lone');
			await paneRows(page, 'search', rows => !hasSiblingPair(rows));

			await focusSearchQueryBox(page);

			await waitFor(async () => (await viewRootBox(page)).open ? undefined : true,
				{ what: 'the `/` box stayed open after the keyboard left it' });

			await assertResultsRestored(page, before);

			// Discriminating: closing the box also restores the cursor, and the arm that does it calls
			// `domFocus` after an `Escape`. A close that ran that arm unconditionally would answer the
			// results list here, which is the click undone.
			const focused = await focusedElement(page);
			assert.equal(focused.inFilterBox, false, 'the closed box still holds the keyboard');
			assert.equal(focused.inList, false, `the pane took the keyboard back from the click: ${JSON.stringify(focused)}`);
			assert.equal(focused.tag, 'TEXTAREA', `the keyboard is not in the box that was clicked: ${JSON.stringify(focused)}`);
		});
	});
}
