// The Sapling smartlog: the commits `sl` reported, and the graph `TextRenderer` drew around them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SAPLING } from '../lib/fixture.mjs';
import { overlayBox, regionLines, saplingLines } from '../lib/probes.mjs';

/**
 * `JOIN_RIGHT` + `FORK_RIGHT` from `renderText.ts`'s glyph table, which is the shape a commit with
 * two parents makes. Nothing in `src/tui/` can produce it: the pane draws the renderer's lines.
 */
const FORK = '├─╮';

/** The line each commit's title is on, in the order the pane drew them. */
function commitLines(lines) {
	return SAPLING.commits.map(title => {
		const index = lines.findIndex(line => line.includes(title));
		assert.notEqual(index, -1, `no row for ${JSON.stringify(title)} in ${JSON.stringify(lines)}`);

		return { title, index, text: lines[index] };
	});
}

export default function registerSaplingSuite(context) {
	describe('sapling smartlog', () => {
		it('draws the smartlog rather than a status line', () => {
			const lines = saplingLines(context.frames.sapling);

			// A failure to discover, spawn or read answers with exactly one line, so this separates
			// "the graph is wrong" from "there is no graph".
			assert.ok(lines.length > SAPLING.commits.length, `the pane is showing a status line: ${JSON.stringify(lines)}`);
		});

		it('keeps `sl`\'s own commit order', () => {
			const rows = commitLines(saplingLines(context.frames.sapling));
			const indexes = rows.map(row => row.index);

			assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, `out of order: ${JSON.stringify(rows.map(row => row.text))}`);
		});

		// A text smartlog marks "." with `@` in the node column instead of putting a "You are here"
		// badge on a row above it, which is `glyphFor` in `saplingTextRows.ts` and `sl`'s own answer.
		// Which column that is belongs to the renderer, so the assertion is which *row* carries it.
		it('marks the working-copy parent with `@` and nothing else with it', () => {
			for (const { title, text } of commitLines(saplingLines(context.frames.sapling))) {
				assert.equal(text.includes('@'), title === SAPLING.dot, `${title} is drawn as ${JSON.stringify(text)}`);
			}
		});

		it('draws the two-parent fork the merge makes', () => {
			const lines = saplingLines(context.frames.sapling);

			assert.ok(lines.some(line => line.includes(FORK)), `no ${FORK} in ${JSON.stringify(lines)}`);
		});

		// The commit-info drawer below the graph, which reads the selection the graph publishes through
		// `ISaplingSelectionService`. The cursor has not moved, so the selection is the fallback to "." —
		// `delta main` — and the byline carries the "You are here" label upstream puts on it.
		it('draws the commit-info drawer for the selected commit', () => {
			const lines = regionLines(context.frames.sapling);

			assert.ok(lines.length > 0, 'the commit-info region painted nothing');
			assert.equal(lines[0].trim(), SAPLING.dot, `the drawer's title is ${JSON.stringify(lines[0])}`);
			assert.ok(lines[1].includes('You are here'), `no "You are here" in ${JSON.stringify(lines[1])}`);
			assert.ok(lines.some(line => line.trim() === 'Files Changed'), `no file section in ${JSON.stringify(lines)}`);
		});

		// The drawer's horizontal axis, which is `Pane`'s and not a second one: every pane the side bar
		// draws is told how wide it is (`ListView.layout(height, width)`), so `list.scrollLeft` and
		// `list.scrollRight` work here for the reason they work in the search pane. What a flat list
		// does *not* answer is a bare `←`/`→` — those are a tree's fold, and the status line no longer
		// offers them here (`interaction.mjs`).
		it('scrolls the commit-info drawer sideways once it has the keyboard', () => {
			const before = regionLines(context.frames.commitInfo);
			const at = before.findIndex(text => text.trim() && SAPLING.description.startsWith(text.trim()));
			assert.notEqual(at, -1, `no row of the drawer holds the description: ${JSON.stringify(before)}`);

			// The precondition, stated so that a fixture whose description stopped being over-wide
			// fails as itself rather than as "the scroll did nothing".
			assert.ok(before[at].length < SAPLING.description.length, `the description is not cut off: ${JSON.stringify(before[at])}`);

			const scrolled = regionLines(context.frames.commitInfoScrolled);
			// Every row is still a row: `regionLines` drops the blank ones, so a row scrolled to
			// nothing would shift every index under it.
			assert.equal(scrolled.length, before.length, `the drawer lost a row: ${JSON.stringify(scrolled)}`);
			assert.ok(scrolled[at].startsWith(before[at].slice(6)), `the row did not move 6 columns: ${JSON.stringify([before[at], scrolled[at]])}`);
			// The discriminating half: it reaches further into the description than the unscrolled row
			// could. A pane that cut the row without scrolling would pass the line above and fail this.
			assert.ok(scrolled[at].length > before[at].length - 6, `nothing new came into view: ${JSON.stringify(scrolled[at])}`);

			assert.deepEqual(regionLines(context.frames.commitInfoBack), before, 'the drawer did not come back to column zero');
		});

		// `sapling.pickRepository`, which T07 recorded as absent because it needed a quick pick and a
		// selection chain. Both exist now, so the pane draws whichever repository the pick names —
		// and `Auto` hands the choice back to the active repository, which in this workspace is a
		// git checkout `sl` has never touched, so there is nothing for it to show.
		it('draws whichever repository the picker names, and says so when Auto has none', () => {
			const overlay = overlayBox(context.frames.saplingPicker);
			assert.ok(overlay, 'the repository picker did not open');
			const picker = overlay.rows.map(row => row.text);
			assert.ok(picker.some(line => line.includes('Auto')), `the picker holds ${JSON.stringify(picker)}`);
			for (const repository of [SAPLING.repository, SAPLING.other.repository]) {
				assert.ok(picker.some(line => line.includes(repository)), `${repository} is not in ${JSON.stringify(picker)}`);
			}

			const picked = saplingLines(context.frames.saplingGamma);
			for (const title of SAPLING.other.commits) {
				assert.ok(picked.some(line => line.includes(title)), `no ${JSON.stringify(title)} in ${JSON.stringify(picked)}`);
			}
			// Discriminating: `delta`'s commits must be gone, not merely joined by `gamma`'s.
			for (const title of SAPLING.commits) {
				assert.ok(!picked.some(line => line.includes(title)), `${JSON.stringify(title)} survived the pick`);
			}

			const auto = saplingLines(context.frames.saplingNoSelection);
			assert.ok(auto.some(line => line.includes('No repository is selected')), `Auto left ${JSON.stringify(auto)}`);
		});

		it('puts each bookmark on its own commit\'s row', () => {
			const lines = saplingLines(context.frames.sapling);
			const rows = commitLines(lines);

			for (const bookmark of SAPLING.bookmarks) {
				const carrying = rows.filter(row => row.text.includes(bookmark));
				assert.equal(carrying.length, 1, `${bookmark} is on ${carrying.length} rows: ${JSON.stringify(rows.map(row => row.text))}`);
			}
		});
	});
}
