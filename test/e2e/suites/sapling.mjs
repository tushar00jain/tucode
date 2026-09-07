// The Sapling smartlog: the commits `sl` printed, the graph drawn beside them, and the
// picker that chooses which repository is being drawn.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SAPLING } from '../lib/fixture.mjs';
import { openFileByQuickOpen, saplingCommitInfo, saplingPickRepository, saplingSelectCommit, saplingSnapshot, scmStatusRepository } from '../lib/probes.mjs';

export default function registerSaplingSuite(context) {
	describe('sapling', () => {
		// Discovery answers with the roots in path order and the view draws the first, so
		// `alpha` is what is on screen until something picks otherwise.
		// `Auto` is upstream's own first item — see the Source Control Graph's `RepositoryPicker` —
		// and it is what keeps the pane following the active repository, so it is part of the offer
		// rather than an extra beside it.
		it('discovers every Sapling repository and draws the first', async () => {
			const { picks } = await saplingPickRepository(context.page);
			assert.deepEqual(picks.map(pick => pick.label).sort(), ['Auto', ...SAPLING.repositories].sort());

			const snapshot = await saplingSnapshot(context.page);
			assert.equal(snapshot.message, '', 'the view reported a failure');
			assert.deepEqual(snapshot.rows.map(row => row.title), SAPLING.alphaCommits);
		});

		// The whole ordering contract in one assertion: `sl log` prints descendants first and
		// nothing between the subprocess and the list re-sorts, so an inverted graph shows up
		// here as a reversed list rather than as an error anywhere.
		it('lists the commits in the order sl printed them', async () => {
			const { snapshot } = await saplingPickRepository(context.page, 'delta');
			assert.deepEqual(snapshot.rows.map(row => row.title), SAPLING.commits);
		});

		it('draws a swimlane per column, and two of them across the fork', async () => {
			const snapshot = await saplingSnapshot(context.page);

			for (const row of snapshot.rows) {
				assert.ok(row.columns > 0, `${row.title} drew no node line: ${JSON.stringify(row)}`);
			}

			// `delta base` is the only row below the fork, so every row above it is laid out
			// across two columns and it alone is back to one. A graph that drew one column
			// everywhere would still satisfy "every row has a node line".
			const widest = Math.max(...snapshot.rows.map(row => row.columns));
			assert.equal(widest, 2, `the fork was never laid out across two columns: ${JSON.stringify(snapshot.rows)}`);
			assert.equal(snapshot.rows.at(-1).columns, 1, 'the root commit should be back to one column');
		});

		it('marks the working directory parent, and only it', async () => {
			const snapshot = await saplingSnapshot(context.page);
			const marked = snapshot.rows.filter(row => row.isDot).map(row => row.title);
			assert.deepEqual(marked, [SAPLING.dot]);
		});

		it('shows the bookmarks each commit carries', async () => {
			const snapshot = await saplingSnapshot(context.page);
			const drawn = snapshot.rows.flatMap(row => row.bookmarks).sort();
			assert.deepEqual(drawn, [...SAPLING.bookmarks].sort());
		});

		// The author is deliberately absent: ISL draws it as an avatar inside the glyph and puts
		// a relative date on the row instead, so the row carries the date and nothing else.
		it('renders a date on every row', async () => {
			const snapshot = await saplingSnapshot(context.page);
			for (const row of snapshot.rows) {
				assert.ok(row.date.length > 0, `${row.title} has no date`);
			}
		});

		// The working copy is a row of its own above ".", as `CommitTreeList.tsx` renders it, and
		// the link line between the two is what draws the curve from the label into the circle.
		it('labels the working copy on a row above the working directory parent', async () => {
			await saplingSnapshot(context.page);
			const label = await context.page.evaluate(() => {
				const rows = [...document.querySelectorAll('.sapling-smartlog .render-dag-row-group')];
				const index = rows.findIndex(row => row.querySelector('.you-are-here-container'));
				return {
					count: rows.filter(row => row.querySelector('.you-are-here-container')).length,
					badge: rows[index]?.querySelector('.inline-badge')?.textContent.trim() ?? '',
					curves: rows[index]?.querySelectorAll('.link-line path').length ?? 0,
					dotIsNext: !!rows[index + 1]?.querySelector('.commit.head-commit')
				};
			});
			assert.equal(label.count, 1, 'the working copy should be labelled exactly once');
			assert.equal(label.badge, 'You are here');
			assert.equal(label.dotIsNext, true, 'the label should sit directly above "."');
			assert.ok(label.curves > 0, 'no link line was drawn from the label down into the commit');
		});

		// The two views share one selection, and an empty one resolves to "." — which is what
		// `commitInfoViewCurrentCommits` does upstream, so the panel is never blank on arrival.
		it('opens the commit-info view on the working directory parent', async () => {
			const info = await saplingCommitInfo(context.page);
			assert.equal(info.title, SAPLING.dot);
			assert.match(info.byline, /You are here/);
			assert.match(info.byline, /Created by/);
		});

		it('draws the clicked commit, and marks the row it came from', async () => {
			const target = SAPLING.commits.find(title => title !== SAPLING.dot);
			const snapshot = await saplingSelectCommit(context.page, target);

			const selected = snapshot.rows.filter(row => row.selected).map(row => row.title);
			assert.deepEqual(selected, [target], 'exactly one row should carry the selection');

			const info = await saplingCommitInfo(context.page);
			assert.equal(info.title, target);
		});

		// The changed files are a second `sl log`, not a column of the smartlog fetch: the sample
		// that paints first has no statuses, so a row that ends up `file-added` proves the second
		// read landed and was what the list was rebuilt from.
		it('lists the files the selected commit changed, with their statuses', async () => {
			await saplingSelectCommit(context.page, SAPLING.dot);
			const info = await saplingCommitInfo(context.page);

			assert.ok(info.files.length > 0, `no changed files were listed: ${JSON.stringify(info)}`);
			assert.equal(info.count, String(info.files.length), 'the badge should count the files below it');
			for (const file of info.files) {
				assert.ok(file.path.length > 0, `a file row carried no path: ${JSON.stringify(info.files)}`);
				assert.match(file.status, /^file-(added|modified|removed)$/);
			}
		});

		// More files than the smartlog's sample carries, so a list this long can only have come
		// from the second read — and long enough to overflow the pane, which is what the rest of
		// the assertions are about.
		it('draws every file of a commit that changed more than the sample carries', async () => {
			await saplingSelectCommit(context.page, SAPLING.wideCommit.title);
			const info = await saplingCommitInfo(context.page);

			assert.equal(info.count, String(SAPLING.wideCommit.files));
			assert.equal(info.files.length, SAPLING.wideCommit.files);
		});

		// ISL's list is its own scroller under a 500px cap, inside a drawer that does not scroll.
		// Here the pane scrolls, so the list must not: a second scroller nested in the pane's
		// scrollable element never receives the wheel, and the fade `::after` the cap hangs off is
		// positioned at a fixed 480px, which adds scrollable height with nothing in it.
		it('leaves the changed-file list to the pane to scroll', async () => {
			await saplingSelectCommit(context.page, SAPLING.wideCommit.title);
			await saplingCommitInfo(context.page);

			const layout = await context.page.evaluate(() => {
				const content = document.querySelector('.commit-info-view-main-content');
				const list = document.querySelector('.changed-files-list');
				const row = document.querySelector('.changed-file');
				return {
					overflows: content.scrollHeight > content.clientHeight,
					listOverflowY: getComputedStyle(list).overflowY,
					listMaxHeight: getComputedStyle(list).maxHeight,
					gradient: getComputedStyle(list, '::after').content,
					rowPosition: getComputedStyle(row).position
				};
			});

			assert.ok(layout.overflows, `the pane should have more content than it can show: ${JSON.stringify(layout)}`);
			assert.equal(layout.listOverflowY, 'visible', 'the list must not be a scroller of its own');
			assert.equal(layout.listMaxHeight, 'none', "the list must not carry ISL's drawer cap");
			assert.equal(layout.gradient, 'none', 'the fade sits at a fixed offset and must not render');
			assert.equal(layout.rowPosition, 'static', 'a sticky row would pile up at the top of the pane');
		});

		// `Auto` is the sync, and this is it: opening a file hands the active repository — what the
		// bottom-left status bar names — to whichever repository owns the file, and the graph
		// follows it without being told, because the selection is derived from that value.
		it('follows the active repository while the picker is on Auto', async () => {
			await saplingPickRepository(context.page, 'Auto');

			await openFileByQuickOpen(context.page, 'alpha/src/app.ts');
			assert.match(await scmStatusRepository(context.page), /alpha/);
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.alphaCommits);

			await openFileByQuickOpen(context.page, 'delta/main.txt');
			assert.match(await scmStatusRepository(context.page), /delta/);
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.commits);
		});

		// Most of a real workspace is not a Sapling checkout — this one holds `beta` and `gamma`
		// as git repositories with no `.sl` — so the active repository is regularly one this pane
		// has no root for. It must leave the graph where it is: falling through to the first
		// discovered repository put the graph on a repository nobody asked for and looked, from
		// the outside, exactly like following being broken.
		it('leaves the graph alone for a repository it has no root for', async () => {
			await saplingPickRepository(context.page, 'Auto');
			await openFileByQuickOpen(context.page, 'delta/main.txt');
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.commits);

			await openFileByQuickOpen(context.page, 'beta/main.rs');
			assert.doesNotMatch(await scmStatusRepository(context.page), /delta/, 'the status bar should have moved');
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.commits);
		});

		// And the other half of upstream's contract, which is the part that is easy to get wrong
		// in either direction: a pick is this view's own, so it neither moves the status bar nor
		// keeps following the editor — and `Auto` puts it back in step. `SCMHistoryViewPane`
		// behaves exactly this way; it never writes to `activeRepository` at all.
		it('holds a picked repository until Auto is picked back', async () => {
			await saplingPickRepository(context.page, 'alpha');
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.alphaCommits);

			// The status bar stays where the editor left it — the pick was not pushed out.
			await openFileByQuickOpen(context.page, 'delta/main.txt');
			assert.match(await scmStatusRepository(context.page), /delta/);
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.alphaCommits);

			await saplingPickRepository(context.page, 'Auto');
			assert.deepEqual((await saplingSnapshot(context.page)).rows.map(row => row.title), SAPLING.commits);
		});
	});
}
