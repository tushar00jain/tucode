// Source control: every repository at once, their groups, and the decoration on each resource.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GROUPS, NESTED_RESOURCE, REPOSITORIES, SCM_COMPACT_CHAIN, SCM_RANKED } from '../lib/fixture.mjs';
import { filterBox, paneTextLines, regionLines, scmSnapshot, selectedRow, sideBarLines } from '../lib/probes.mjs';
import { themeColour, themeColourOver } from '../lib/theme.mjs';

/**
 * What `views.css:21` puts behind a matched character. The filter input owns Home, so the matched
 * resource stays selected: the match tint sits over the selection, then the sidebar.
 */
const FILTER_MATCH = themeColourOver('editor.findMatchHighlightBackground', 'list.activeSelectionBackground', 'sideBar.background');

/** The row the keyboard is on, which is the only place a cursor exists as data. */
const SELECTED_BACKGROUND = themeColourOver('list.activeSelectionBackground', 'sideBar.background');

function repositoryOf(snapshot, name) {
	const repository = snapshot.find(candidate => candidate.label === name);
	assert.ok(repository, `no repository named ${name}; the view lists ${JSON.stringify(snapshot.map(entry => entry.label))}`);

	return repository;
}

function groupOf(repository, label) {
	const group = repository.groups.find(candidate => candidate.label === label);
	assert.ok(group, `${repository.label} has no ${label} group; it has ${JSON.stringify(repository.groups.map(entry => entry.label))}`);

	return group;
}

const byName = resources => [...resources].sort((a, b) => a.name.localeCompare(b.name));

export default function registerScmSuite(context) {
	describe('source control', () => {
		it('lists every repository in the workspace, with its own resource count', () => {
			const snapshot = scmSnapshot(context.frames.scm);

			assert.deepEqual(snapshot.map(repository => repository.label).sort(), [...REPOSITORIES].sort());
			for (const [name, groups] of Object.entries(GROUPS)) {
				const expected = Object.values(groups).reduce((total, resources) => total + resources.length, 0);
				assert.equal(repositoryOf(snapshot, name).count, expected, `${name}'s count`);
			}
		});

		it('groups staged, unstaged, untracked and conflicted changes', () => {
			const snapshot = scmSnapshot(context.frames.scm);

			for (const [name, groups] of Object.entries(GROUPS)) {
				const repository = repositoryOf(snapshot, name);
				assert.deepEqual(repository.groups.map(group => group.label).sort(), Object.keys(groups).sort(), `${name}'s groups`);

				for (const [label, resources] of Object.entries(groups)) {
					const group = groupOf(repository, label);
					assert.equal(group.count, resources.length, `${name} / ${label} count`);
					assert.deepEqual(
						byName(group.resources).map(entry => entry.name),
						byName(resources).map(entry => entry.name),
						`${name} / ${label} resources`
					);
				}
			}
		});

		// `scmViewPane.ts:1645` marks the input and the action button `force-no-twistie`, and
		// `views.css:11` gives that class a twistie of no width — so both start where a sibling group
		// puts its *twistie* rather than where it puts its label, one level left of every other row at
		// their depth. Read off the first repository, whose rows are the deepest set in the fixture.
		it('gives the commit input and the commit button no twistie box, as `views.css` does', () => {
			const lines = paneTextLines(context.frames.scm);
			const column = pattern => {
				const at = lines.findIndex(text => pattern.test(text));
				assert.notEqual(at, -1, `no row matches ${pattern}; the view shows ${JSON.stringify(lines.slice(0, 8))}`);

				return lines[at].search(/\S/);
			};

			const group = column(/^\s*▾ Staged Changes/);
			assert.equal(column(/^\s*Message \(/), group, 'the input is not at the twistie column its siblings use');
			assert.equal(column(/^\s*Commit\s*$/), group, 'the action button is not at the twistie column its siblings use');
		});

		// `ActionButtonRenderer` builds a `SCMActionButton`, which builds upstream's own `Button` with
		// `defaultButtonStyles` — so the row carries `button.background` rather than the pane's. It is
		// the only row in this frontend drawn in a colour of a control's own, and the fill is what
		// says the widget ran rather than a label being printed where it would have been.
		it('draws the commit button as a button, in the colours a button has', () => {
			const row = sideBarLines(context.frames.scm).find(line => line.text.trim() === 'Commit');
			assert.ok(row, 'no commit button row');

			const cell = row.cells[row.text.indexOf('C')];
			assert.equal(cell.bg, themeColour('button.background'));
			assert.equal(cell.fg, themeColour('button.foreground'));
		});

		it('draws each status letter in the colour its status maps to', () => {
			const snapshot = scmSnapshot(context.frames.scm);

			for (const [name, groups] of Object.entries(GROUPS)) {
				for (const [label, resources] of Object.entries(groups)) {
					const group = groupOf(repositoryOf(snapshot, name), label);
					assert.deepEqual(
						byName(group.resources).map(entry => ({ name: entry.name, letter: entry.letter, colour: entry.colour })),
						byName(resources).map(entry => ({ name: entry.name, letter: entry.letter, colour: entry.colour })),
						`${name} / ${label} decorations`
					);
				}
			}
		});

		// The two modes are one call each in `SCMTreeDataSource` and `SCMTreeSorter`, and the visible
		// difference is where a resource's directory goes: beside the name in list mode, and into a
		// row of its own in tree mode. `alpha`'s untracked file under `src/` is the one that shows it.
		it('shows a resource\'s folder beside it in list mode', () => {
			const changes = groupOf(repositoryOf(scmSnapshot(context.frames.scm), 'alpha'), 'Changes');
			const nested = changes.resources.find(entry => entry.name === NESTED_RESOURCE.name);

			assert.deepEqual(changes.folders, [], 'list mode built a folder row');
			assert.ok(nested, `no ${NESTED_RESOURCE.name} among ${JSON.stringify(changes.resources.map(entry => entry.name))}`);
			assert.equal(nested.folder, NESTED_RESOURCE.label);
		});

		it('builds a folder row for it in tree mode instead', () => {
			const changes = groupOf(repositoryOf(scmSnapshot(context.frames.scmTree), 'alpha'), 'Changes');
			const nested = changes.resources.find(entry => entry.name === NESTED_RESOURCE.name);

			// `scm.compactFolders`, the same `CompressibleObjectTreeModel` fix as the explorer's:
			// `src` holds two entries so it stays a row of its own, and `zone` holds only `deep`, so
			// those two are one row. Neither folder may also appear alone.
			assert.deepEqual([...changes.folders].sort(), [NESTED_RESOURCE.directory, SCM_COMPACT_CHAIN.row].sort());
			assert.ok(changes.resources.some(entry => entry.name === SCM_COMPACT_CHAIN.file.name),
				`${SCM_COMPACT_CHAIN.file.name} is not under the compacted row: ${JSON.stringify(changes.resources.map(entry => entry.name))}`);
			assert.ok(nested, `no ${NESTED_RESOURCE.name} among ${JSON.stringify(changes.resources.map(entry => entry.name))}`);
			assert.equal(nested.folder, '', 'tree mode repeated the folder beside the name');
			assert.equal(nested.depth, 4, 'the resource is not under the folder row');
		});

		// `/`, which is the explorer's — a **view root** and one level of filtering over it, on the
		// file both panes share. What is this fork's is the root; what a row is *matched* on is still
		// upstream's `SCMTreeKeyboardNavigationLabelProvider`, per row kind and per view mode, so what
		// tree mode does that list mode does not is read off there rather than decided here (`§7.2`).
		describe('the `/` view root', () => {
			const topOf = frame => scmSnapshot(frame, { skip: filterBox(frame).rows });
			const groupsOf = (frame, open = true) => scmSnapshot(frame, { rooted: true, skip: filterBox(frame, { rooted: true, open }).rows })[0].groups;
			const textOf = (frame, open = true) => paneTextLines(frame).slice(filterBox(frame, { rooted: true, open }).rows).map(text => text.trim()).filter(Boolean);
			const namesIn = group => group.resources.map(entry => entry.name);

			// The box opens on the path of the root being looked at, so it never moves the pane — and
			// at the top level there is no path, which is the query that already means *everything*.
			it('opens on the path of the root being looked at, and an empty query filters nothing', () => {
				assert.equal(filterBox(context.frames.scmFilterOpened).input, 'path to filter');
				assert.deepEqual(topOf(context.frames.scmFilterOpened).map(repository => repository.label).sort(), [...REPOSITORIES].sort());
				assert.equal(groupOf(repositoryOf(topOf(context.frames.scmFilterOpened), 'alpha'), 'Changes').resources.length,
					GROUPS.alpha.Changes.length);
			});

			// The last segment at the top level ranks the repositories, which is where a path's first
			// segment lands, and **a repository it misses is hidden** — the explorer's own arm for a
			// folder, reached through the same composition. The row is scored on `provider.name`
			// rather than through the label provider, which has no answer for one; the ranking is
			// what puts the cursor on the repository `Enter` re-roots to.
			it('ranks the repositories from an empty box, and hides the ones it missed', () => {
				const repositories = topOf(context.frames.scmRankedRepositories).map(repository => repository.label);

				// Discriminating: `beta` is the only one of the four carrying a `b` and is second in
				// discovery order, so a frame that ranked nothing reads all four, starting at `alpha`.
				assert.deepEqual(repositories, ['beta'], `the query did not take the other repositories away: ${JSON.stringify(repositories)}`);
			});

			// `Tab` over that ranking, which is the explorer's `Tab` on the file both panes share: the
			// top-ranked row's name into the last segment, the cursor onto that row, and — the part
			// that is not obvious — the ranked rows left alone while it cycles.
			it('completes to each ranked repository in turn, and wraps', () => {
				const ranked = topOf(context.frames.scmRankedInTree).map(repository => repository.label);
				const box = frame => filterBox(context.frames[frame]).input;

				// The rows the cycle has to walk, and there is more than one of them: a query that
				// kept a single repository would answer every assertion below with the same row.
				assert.deepEqual([...ranked].sort(), [...SCM_RANKED.repositories].sort());
				assert.equal(box('scmCompleted'), ranked[0]);
				assert.ok(selectedRow(context.frames.scmCompleted, SELECTED_BACKGROUND).text.includes(ranked[0]),
					`the cursor is on ${JSON.stringify(selectedRow(context.frames.scmCompleted, SELECTED_BACKGROUND).text)}`);
				// **Discriminating**: the box holds a whole repository name by now, so a query re-run on
				// it would hide every repository but that one and leave a single row here.
				assert.deepEqual(topOf(context.frames.scmCompletedNext).map(repository => repository.label), ranked,
					'the completion was re-run as a query');
				assert.equal(box('scmCompletedNext'), ranked[1]);
				assert.equal(box('scmCompletedWrapped'), ranked[0], 'the cycle did not wrap');
				assert.equal(box('scmCompletedBack'), ranked.at(-1), '`Shift+Tab` did not wrap back');
			});

			// `Enter` after a `Tab` is `Enter` on the row the cursor is on, on the arm that row already
			// had — a repository, so it re-roots.
			it('commits the completed repository on the arm that row already had', () => {
				const ranked = topOf(context.frames.scmRankedInTree).map(repository => repository.label);

				assert.equal(filterBox(context.frames.scmCompletedRoot, { rooted: true, open: false }).root, ranked.at(-1));
			});

			// `Enter` on a repository is the explorer's *folder* arm: the pane is displayed from it, so
			// the repository row is gone and its own rows are the top level. The header says where it
			// is, as the explorer's does — the side bar's title is the workbench's formula (`§7.1`).
			it('re-roots the pane at a repository, and says where it is', () => {
				const frame = context.frames.scmRooted;
				const groups = groupsOf(frame, false);
				const lines = textOf(frame, false);

				assert.equal(filterBox(frame, { rooted: true, open: false }).root, 'alpha');
				assert.deepEqual(groups.map(group => group.label).sort(), Object.keys(GROUPS.alpha).sort());
				assert.deepEqual(byName(groupOf({ label: 'alpha', groups }, 'Changes').resources).map(entry => entry.name),
					byName(GROUPS.alpha.Changes).map(entry => entry.name));
				// One repository's rows and no other's, which is the whole of what a root does.
				assert.equal(lines.filter(text => text.startsWith('Message (')).length, 1, `commit boxes in ${JSON.stringify(lines)}`);
				assert.equal(lines.filter(text => text === 'Commit').length, 1, `Commit buttons in ${JSON.stringify(lines)}`);
			});

			// **In list mode a group's children are every resource under it**, so the last segment
			// reads as a deep search there — `note.txt` is two folders down and is a row of this group
			// all the same. There is no arm for the mode anywhere: it is the same rule over the same
			// children `SCMTreeDataSource` answers with.
			it('reaches every resource under the root in list mode', () => {
				const groups = groupsOf(context.frames.scmRootedListSearch);

				assert.deepEqual(namesIn(groupOf({ groups }, 'Changes')), [SCM_COMPACT_CHAIN.file.name]);
				// The commit input, the Commit button and both groups are structure: they render at
				// every root, whatever the query took away under them.
				assert.deepEqual(groups.map(group => group.label).sort(), Object.keys(GROUPS.alpha).sort());
				assert.deepEqual(namesIn(groupOf({ groups }, 'Staged Changes')), []);
				assert.equal(textOf(context.frames.scmRootedListSearch).filter(text => text.startsWith('Message (')).length, 1);
			});

			it('tints what the query matched', () => {
				const row = sideBarLines(context.frames.scmMatchTinted).find(line => line.text.includes(SCM_COMPACT_CHAIN.file.name));

				assert.ok(row, 'no row for the resource the query matched');
				assert.equal(row.cells[row.text.indexOf('.txt')].bg, SELECTED_BACKGROUND,
					'the unmatched suffix should retain the selected row background');
				assert.equal(row.cells[row.text.indexOf('note')].bg, FILTER_MATCH, `the matched characters carry no tint: ${JSON.stringify(row.text)}`);
			});

			// A folder segment re-roots, and **the folders it walks are the groups' own**: `zone` is a
			// node in the resource tree each group builds, not a directory anything here listed.
			it('re-roots at a folder inside the repository', () => {
				const frame = context.frames.scmRootedFolder;
				const box = filterBox(frame, { rooted: true });

				assert.equal(box.root, `alpha/${SCM_COMPACT_CHAIN.folders[0]}`);
				assert.equal(box.input, `alpha/${SCM_COMPACT_CHAIN.folders[0]}/`);
				assert.deepEqual(namesIn(groupOf({ groups: groupsOf(frame) }, 'Changes')), [SCM_COMPACT_CHAIN.file.name]);
				assert.deepEqual(namesIn(groupOf({ groups: groupsOf(frame) }, 'Staged Changes')), []);
			});

			it('puts back the root the box was opened on, and the top level on an empty query', () => {
				assert.deepEqual(paneTextLines(context.frames.scmRootEscaped), paneTextLines(context.frames.scmRooted));
				assert.deepEqual(paneTextLines(context.frames.scmTopLevel), paneTextLines(context.frames.scm));
			});

			// The box turns `scm.compactFolders` off while it is open, for the reason `§7.1` gives —
			// a chain takes its `filterData` from its **last** element while only the first is a row at
			// the root, so the tint would be computed against one name and drawn against another.
			it('unfolds a compacted chain for as long as the box is open', () => {
				const folded = groupsOf(context.frames.scmTreeRooted, false);
				const opened = groupsOf(context.frames.scmTreeFilterOpened);

				assert.ok(groupOf({ groups: folded }, 'Changes').folders.includes(SCM_COMPACT_CHAIN.row),
					`the chain is not folded with the box closed: ${JSON.stringify(groupOf({ groups: folded }, 'Changes').folders)}`);
				assert.deepEqual(groupOf({ groups: opened }, 'Changes').folders.filter(name => SCM_COMPACT_CHAIN.folders.includes(name) || name === SCM_COMPACT_CHAIN.row),
					SCM_COMPACT_CHAIN.folders);
			});

			// **The same query at the same root, in the other mode.** In tree mode a group's children
			// are the folders and files at that level, so `note` reaches nothing — `note.txt` is under
			// two of them — where list mode above answered with it. That is one rule read in two modes
			// rather than an arm for each.
			it('ranks only the root\'s direct children in tree mode', () => {
				const groups = groupsOf(context.frames.scmTreeMiss);

				assert.deepEqual(namesIn(groupOf({ groups }, 'Changes')), []);
				assert.deepEqual(groupOf({ groups }, 'Changes').folders, []);
				assert.deepEqual(groups.map(group => group.label).sort(), Object.keys(GROUPS.alpha).sort(), 'a group went with the rows under it');
				assert.equal(textOf(context.frames.scmTreeMiss).filter(text => text === 'Commit').length, 1);
			});

			// And the positive half: a folder that matches keeps everything under it, and the siblings
			// that missed are gone. `Enter` on it re-roots, which is the same arm the repository took.
			it('takes the siblings a folder outranked, and re-roots into it on Enter', () => {
				const ranked = groupOf({ groups: groupsOf(context.frames.scmTreeRanked) }, 'Changes');
				const rooted = groupsOf(context.frames.scmTreeFolderRoot, false);

				assert.ok(ranked.folders.includes(SCM_COMPACT_CHAIN.folders[0]), `the matched folder is gone: ${JSON.stringify(ranked.folders)}`);
				assert.ok(!ranked.folders.includes(NESTED_RESOURCE.directory), `a folder that missed survived: ${JSON.stringify(ranked.folders)}`);
				assert.deepEqual(namesIn(ranked), [SCM_COMPACT_CHAIN.file.name], 'a resource that missed survived');

				assert.equal(filterBox(context.frames.scmTreeFolderRoot, { rooted: true, open: false }).root, `alpha/${SCM_COMPACT_CHAIN.folders[0]}`);
				assert.deepEqual(groupOf({ groups: rooted }, 'Changes').folders, [SCM_COMPACT_CHAIN.folders[1]]);
			});

			// `Enter` on a resource is the explorer's *file* arm: the box goes and the cursor stays on
			// the row it was pressed on, which is where the ranking had put it.
			it('closes the box on a resource with the cursor on it', () => {
				const frame = context.frames.scmResourceFocused;

				assert.equal(filterBox(frame, { rooted: true, open: false }).root, SCM_COMPACT_CHAIN.label.split(/[\\/]/).join('/'));
				assert.ok(selectedRow(frame, SELECTED_BACKGROUND).text.includes(SCM_COMPACT_CHAIN.file.name),
					`the cursor is on ${JSON.stringify(selectedRow(frame, SELECTED_BACKGROUND).text)}`);
			});

			it('leaves the pane as it found it', () => {
				assert.deepEqual(paneTextLines(context.frames.scmTreeRestored), paneTextLines(context.frames.scmTree));
			});
		});

		// The second region of the same tab, which exists at all because `TauriGitHistoryProvider` set
		// a history provider and `SCMService` counted it. The commits are the fixture's own, and the
		// node glyph is `scmHistoryText.ts`'s — the assertion is that the graph is there and is about
		// this repository, not what shape it drew.
		it('draws the source control graph in the region below', () => {
			const lines = regionLines(context.frames.scm);

			assert.ok(lines.length > 0, 'the graph region painted nothing');
			assert.ok(lines.some(line => /^[o@]/.test(line.trim())), `no node glyph in ${JSON.stringify(lines)}`);
			// Every fixture repository's first commit is `<name> base`, and the graph draws one
			// repository — whichever `SCMHistoryViewModel` picked — so the assertion is that the rows
			// are some repository's history rather than a status line.
			assert.ok(lines.some(line => REPOSITORIES.some(name => line.includes(`${name} base`))), `no commit subject in ${JSON.stringify(lines)}`);
		});
	});
}
