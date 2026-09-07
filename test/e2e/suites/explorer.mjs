// The explorer: what `FilesFilter` leaves, in the order `FileSorter` put it.
//
// Upstream counterpart: none — tscode drives the explorer through a browser; its e2e suites cover the editor, quick open, the terminal and the workspace instead.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALPHA, ALPHA_DECORATIONS, ALPHA_ICONS, COMPACT_CHAIN, FOLDER_DECORATIONS, README_ICON, SIBLING_FILES, TOP_LEVEL } from '../lib/fixture.mjs';
import { explorerRows, selectedRow } from '../lib/probes.mjs';
import { themeColour, themeColourOver } from '../lib/theme.mjs';

/** What a selected list row is drawn in: both halves of the pair, and what the background sits on. */
const SELECTED_BACKGROUND = themeColourOver('list.activeSelectionBackground', 'sideBar.background');
const SELECTED_FOREGROUND = themeColour('list.activeSelectionForeground');

const sorted = names => [...names].sort();

/** The rows one level below `name`, up to the next row at `name`'s own level or above. */
function childrenOf(rows, name) {
	const parent = rows.findIndex(row => row.name === name);
	assert.notEqual(parent, -1, `no ${name} row among ${JSON.stringify(rows.map(row => row.name))}`);
	assert.ok(rows[parent].open, `${name} is not open`);

	const after = rows.slice(parent + 1);
	const end = after.findIndex(row => row.depth <= rows[parent].depth);

	return (end === -1 ? after : after.slice(0, end));
}

/**
 * The property that says the sorter ran, at one level of the tree: `FileSorter` puts every directory
 * before every file, and a directory is the only kind of row the tree makes collapsible.
 */
function assertDirectoriesFirst(rows, level) {
	const last = rows.findLastIndex(row => row.collapsible);
	const first = rows.findIndex(row => !row.collapsible);

	assert.ok(
		last === -1 || first === -1 || last < first,
		`${level}: a file precedes a directory — ${JSON.stringify(rows.map(row => row.name))}`
	);
}

export default function registerExplorerSuite(context) {
	describe('explorer', () => {
		it('lists exactly the entries `files.exclude` leaves', () => {
			const rows = explorerRows(context.frames.explorer);
			assert.deepEqual(sorted(rows.map(row => row.name)), sorted(TOP_LEVEL));
			assert.ok(rows.every(row => row.depth === 1), `a root entry is nested: ${JSON.stringify(rows.map(row => [row.name, row.depth]))}`);
		});

		it('hides `.git` and keeps `.githooks` when a folder opens', () => {
			const children = childrenOf(explorerRows(context.frames.alpha), ALPHA.folder).map(row => row.name);

			assert.deepEqual(sorted(children), sorted([...ALPHA.directories, ...ALPHA.files]));
			for (const hidden of ALPHA.hidden) {
				assert.ok(!children.includes(hidden), `${hidden} is listed; the glob that hides it also matched ${JSON.stringify(children)}`);
			}
		});

		// The other half of `IDecorationsService`: `TauriGitDecorationProvider` is registered with it,
		// `FilesRenderer` asks its label for `explorer.decorations`, and `DecorationStyles` writes the
		// rule behind the class names through a `<style>` element's `sheet` — so the badge and the
		// name's colour are upstream's own path rather than a second route (phase C).
		it('carries each file\'s git decoration, letter and colour both', () => {
			const rows = childrenOf(explorerRows(context.frames.alpha), ALPHA.folder);

			for (const [name, decoration] of Object.entries(ALPHA_DECORATIONS)) {
				const row = rows.find(candidate => candidate.name === name);
				assert.ok(row, `no ${name} row among ${JSON.stringify(rows.map(candidate => candidate.name))}`);
				assert.equal(row.letter, decoration.letter, `${name}'s badge`);
				assert.equal(row.colour, decoration.colour, `${name}'s badge colour`);
				if (decoration.colour) {
					assert.equal(row.nameColour, decoration.colour, `${name}'s name is not in its decoration's colour`);
				}
			}
		});

		// The file icon theme, loaded rather than merely scanned: `ThemeRegistry`
		// over upstream's `iconThemes` extension point, `FileIconThemeLoader` building upstream's own
		// stylesheet out of it, and `tui/terminal/dom/style.ts` reading that sheet beside every other.
		// The colour on the cell is the definition's `fontColor` and reaches it unchanged; the glyph
		// cannot, and is the substitute this fork draws in its place.
		it('draws each file\'s icon from the icon theme, in the theme\'s own colour', () => {
			const rows = childrenOf(explorerRows(context.frames.alpha), ALPHA.folder);

			for (const [name, icon] of Object.entries(ALPHA_ICONS)) {
				const row = rows.find(candidate => candidate.name === name);
				assert.ok(row, `no ${name} row among ${JSON.stringify(rows.map(candidate => candidate.name))}`);
				assert.equal(row.icon, icon.glyph, `${name}'s icon`);
				assert.equal(row.iconColour, icon.colour, `${name}'s icon colour`);
				// The theme colours the icon and nothing else: the name keeps git's.
				assert.notEqual(row.nameColour, icon.colour, `${name}'s name took the icon's colour`);
			}
		});

		// `views.css:8`, the rule the copy script left with no importer and phase F gave a gate:
		// Seti has file icons and no folder icons, so a file row spends the twistie's two columns on
		// its icon instead of carrying both. Without it every file in the explorer is indented past
		// the folders beside it, which is the defect this was reported as.
		it('puts a file\'s icon where a folder\'s twistie is, not beside it', () => {
			const rows = explorerRows(context.frames.explorer);
			const readme = rows.find(row => row.name === 'README.md');

			assert.ok(readme, `no README.md row among ${JSON.stringify(rows.map(row => row.name))}`);
			assert.equal(readme.icon, README_ICON.glyph);
			assert.equal(readme.iconColour, README_ICON.colour);
			// Every root entry, folder or file, starts its box in the same column.
			assert.deepEqual([...new Set(rows.map(row => row.column))], [readme.column]);
		});

		// The other end of the same service: a folder answers for what is underneath it.
		it('rolls a folder\'s git state up from the files under it', () => {
			const rows = explorerRows(context.frames.explorer);

			for (const [name, decoration] of Object.entries(FOLDER_DECORATIONS)) {
				const row = rows.find(candidate => candidate.name === name);
				assert.ok(row, `no ${name} row among ${JSON.stringify(rows.map(candidate => candidate.name))}`);
				assert.equal(row.letter, decoration.letter, `${name}'s bubble badge`);
				assert.equal(row.colour, decoration.colour, `${name}'s bubble badge colour`);
				if (decoration.colour) {
					assert.equal(row.nameColour, decoration.colour, `${name}'s name is not in its children's colour`);
				}
			}
		});

		// `explorer.compactFolders`, which defaults to true upstream and was honoured by nothing
		// here: `CompressibleObjectTreeModel` folds the chain and `FilesRenderer.renderCompressedElements`
		// draws it, with `autoExpandSingleChildren` opening the chain that gives it something to fold.
		it('folds a single-child folder chain into one row', () => {
			const rows = explorerRows(context.frames.compact);
			const names = childrenOf(rows, COMPACT_CHAIN.parent).map(row => row.name);

			assert.ok(names.includes(COMPACT_CHAIN.row), `no compacted row among ${JSON.stringify(names)}`);
			// Discriminating: neither folder may also be a row of its own, and the file the chain
			// ends at has to be reachable — a fold that dropped the subtree would pass the first.
			for (const folder of COMPACT_CHAIN.folders) {
				assert.ok(!names.includes(folder), `${folder} is still a row of its own: ${JSON.stringify(names)}`);
			}
			assert.ok(names.includes(COMPACT_CHAIN.file), `${COMPACT_CHAIN.file} is not under the compacted row: ${JSON.stringify(names)}`);
		});

		it('puts directories before files at every level', () => {
			const rows = explorerRows(context.frames.alpha);

			// Discriminating because `LICENSE` sorts before `src` alphabetically: a listing that came
			// out in name order alone would fail this and pass the two assertions above.
			assertDirectoriesFirst(childrenOf(rows, ALPHA.folder), ALPHA.folder);
			assertDirectoriesFirst(rows.filter(row => row.depth === 1), 'the workspace root');
		});

		it('opens the folder that was asked for, and only that one', () => {
			const open = explorerRows(context.frames.alpha).filter(row => row.open).map(row => row.name);

			assert.deepEqual(open, [ALPHA.folder]);
		});

		// The `when` clause is the part of `files.exclude` that only a workspace can contribute, so this
		// is the assertion that says the fixture's own settings reached `FilesFilter`. It is
		// discriminating rather than merely "something was excluded": `pair.js` must be hidden because
		// `pair.ts` exists, while `lone.js` must not be.
		it('hides a file its sibling `when` clause excludes, and keeps the one with no sibling', () => {
			const children = childrenOf(explorerRows(context.frames.siblings), SIBLING_FILES.folder).map(row => row.name);

			assert.deepEqual(sorted(children), sorted(SIBLING_FILES.visible));
		});

		// `workbench.files.action.collapseExplorerFolders`, upstream's own id: the command exists in
		// the vendored tree and is registered inside the DOM view, so nothing here could reach it.
		// Its body is `setCollapsed(rootRef, true, true)`, which is `AbstractTree.collapseAll`.
		it('folds every folder in the explorer, and leaves the cursor on a row that is still there', () => {
			const before = explorerRows(context.frames.siblings);
			const after = explorerRows(context.frames.collapsedFolders);

			// Discriminating: four folders are open on the frame before, so a collapse that folded
			// only the focused row, or only the top level, would leave some of them.
			assert.ok(before.filter(row => row.open).length >= 4,
				`nothing was open to fold: ${JSON.stringify(before.filter(row => row.open).map(row => row.name))}`);
			assert.deepEqual(after.filter(row => row.open).map(row => row.name), []);
			assert.deepEqual(sorted(after.map(row => row.name)), sorted(TOP_LEVEL));
			assert.ok(after.every(row => row.depth === 1), `a row survived below the root: ${JSON.stringify(after.map(row => [row.name, row.depth]))}`);

			// Upstream tree focus and selection are distinct. Right must reopen the focused
			// siblings folder; the selected file need not change when keyboard focus moves.
			assert.deepEqual(explorerRows(context.frames.collapseFocusRetained)
				.filter(row => row.open).map(row => row.name), [SIBLING_FILES.folder]);
		});

		// The other half of that clause, and the assertion `IEditorService` exists for: `FilesFilter`
		// answers `true` for a hidden resource an editor is open on, "show all opened files and their
		// parents". It is discriminating in the one way that matters — the same folder, the same
		// glob, the same frame's worth of settings, with the file open — so a service that answers
		// `visibleEditors: []` fails this and nothing else.
		it('keeps an open file listed where the same `when` clause hides it', () => {
			const children = childrenOf(explorerRows(context.frames.excludedListed), SIBLING_FILES.folder).map(row => row.name);

			assert.deepEqual(sorted(children), sorted([...SIBLING_FILES.visible, ...SIBLING_FILES.hidden]));
		});

		// What `E` used to do to the tree, and the reason nothing watched for it: `refresh` with no
		// item rebuilt from the workspace roots, so every expanded folder lost the children under it.
		// The frames either side of one editor opening are the whole assertion — upstream's
		// `updateChildren` re-reads the nodes it already has, and this is that property.
		it('holds every expanded folder across an editor opening that re-runs the filter', () => {
			const opened = rows => rows.filter(row => row.open).map(row => row.name);
			const before = explorerRows(context.frames.expandedBeforeEdit);
			const after = explorerRows(context.frames.editExcluded);

			// Both folders must be open. Upstream auto-reveal may also have expanded src during
			// earlier editor opens; preserve that subtree too, rather than assuming it is closed.
			assert.ok(opened(before).includes(ALPHA.folder));
			assert.ok(opened(before).includes(SIBLING_FILES.folder));
			assert.deepEqual(sorted(opened(after)), sorted(opened(before)));
			// And expanded is not the same as populated: a folder whose row still says open while its
			// children were spliced away reads as collapsed on screen, which is what was reported.
			assert.deepEqual(
				sorted(childrenOf(after, ALPHA.folder).map(row => row.name)),
				sorted(childrenOf(before, ALPHA.folder).map(row => row.name)));
			const alpha = before.find(row => row.name === ALPHA.folder);
			assert.deepEqual(sorted(childrenOf(before, ALPHA.folder)
				.filter(row => row.depth === alpha.depth + 1).map(row => row.name)),
				sorted([...ALPHA.directories, ...ALPHA.files]));
			// `pair.js` is the one row that must move: its editor is no longer visible, so the `when`
			// clause hides it again — which is the filter having actually run rather than nothing
			// having happened.
			assert.deepEqual(sorted(childrenOf(after, SIBLING_FILES.folder).map(row => row.name)), sorted(SIBLING_FILES.visible));
		});

		// And again once the child's tab is gone, which is a second editor change over the same tree.
		// Which editor the group reveals underneath decides whether the filter fires at all, so what
		// is asserted here is only the part that must hold either way.
		it('still holds them when the editing tab is closed again', () => {
			const rows = explorerRows(context.frames.editExcludedClosed);
			const before = explorerRows(context.frames.expandedBeforeEdit);

			assert.deepEqual(sorted(rows.filter(row => row.open).map(row => row.name)),
				sorted(before.filter(row => row.open).map(row => row.name)));
			assert.deepEqual(
				sorted(childrenOf(rows, ALPHA.folder).map(row => row.name)),
				sorted(childrenOf(before, ALPHA.folder).map(row => row.name)));
		});


		// The colour pair, which is the usability pass's item 5. Upstream states **both** halves of it
		// and states the background with an alpha, because a GUI composites it onto the part behind;
		// taking the colour and dropping the alpha resolved one half and not the other, so a
		// deliberately light foreground landed on a background that had become white. What makes this
		// discriminating is that it names both ids and what the background sits on — the bug's own
		// value, `ffffff`, is what `list.activeSelectionBackground` reads as when nothing composites it.
		it('draws the cursor row in the pair the theme states for a selected list row', () => {
			const cursor = selectedRow(context.frames.explorer, SELECTED_BACKGROUND);

			assert.equal(cursor.row, 1, `the cursor is on side bar row ${cursor.row}, not the first row of the list`);
			assert.ok(cursor.text.endsWith(TOP_LEVEL[0]), `the cursor row says ${JSON.stringify(cursor.text)}`);
			assert.equal(cursor.fg, SELECTED_FOREGROUND, 'the row is not drawn in list.activeSelectionForeground');
			assert.notEqual(cursor.fg, cursor.bg, 'the cursor row is drawn in one colour, so its text is invisible');
		});
	});
}
