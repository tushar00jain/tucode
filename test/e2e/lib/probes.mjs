// The named probes the suites read a frame through — the only place that knows how a row is drawn.
//
// The vendored suite's `lib/probes.mjs` was the only place that knew a workbench *selector*; this is
// the same contract one layer down, over cells instead of DOM. Every probe separates an empty
// answer from no answer: a part that painted nothing comes back as an empty array, and a row whose
// shape does not parse throws naming what it saw, rather than being silently dropped.
//
// **A frame is columns before it is rows.** The workbench draws an activity bar, a side bar, a
// one-column divider and an editor area beside each other (`src/tui/workbench/workbench.ts`), so every probe
// starts by cutting a row down to the part it is about — and the divider is *found*, not counted, so
// the side bar's width stays the workbench's business. Inside the side bar the three shapes that
// covered all four panes still cover them: a title row, an optional view header, an optional
// non-scrolling pane header, and a list of rows indented two columns per level with a twistie or two
// more spaces.

import assert from 'node:assert/strict';

/** The status bar, one row — `Workbench.STATUS_ROWS`. */
const STATUS_ROWS = 1;

/** The activity bar's columns and the side bar's title row — `Workbench`'s two constants. */
const ACTIVITY_BAR_COLUMNS = 3;
const TITLE_ROWS = 1;

/** The divider column, and the rule closing each editor tab — both are `│` in a terminal. */
const RULE = '│';

/** What a folder's twistie is, at the two states a terminal can show (`TWISTIE` in every pane). */
const OPEN = '▾';
const CLOSED = '▸';

/** A line cut to a column range, cells included, so a colour still reads off the right cell. */
function slice(line, from, to) {
	const cells = line.cells.slice(from, to);

	return { text: cells.map(cell => cell.ch).join('').replace(/ +$/, ''), cells };
}

/** Every row above the status bar, which is what the parts share. */
const bodyLines = frame => frame.lines.slice(0, frame.rows - STATUS_ROWS);

/** The status bar, which is the one row below every part. */
export const statusLine = frame => frame.lines[frame.rows - STATUS_ROWS];

/** The corners of the box the floating layer draws — `Overlays.BOX`, read the other way round. */
const CORNERS = { topLeft: '┌', topRight: '┐', bottomLeft: '└' };

/**
 * The overlay on the floating layer, or `null` when nothing is up: where its box is and what is
 * inside it. It is found by its own rule rather than counted, the same way the divider is — and it
 * is *why* a frame with an overlay cannot be read through `dividerColumn`, because a box drawn over
 * the divider is exactly the thing that column's invariant forbids a pane from doing.
 */
export function overlayBox(frame) {
	const top = frame.lines.findIndex(line => line.text.includes(CORNERS.topLeft) && line.text.includes(CORNERS.topRight));
	if (top === -1) {
		return null;
	}

	const left = frame.lines[top].cells.findIndex(cell => cell.ch === CORNERS.topLeft);
	const right = frame.lines[top].cells.findIndex((cell, column) => column > left && cell.ch === CORNERS.topRight);
	const bottom = frame.lines.findIndex((line, row) => row > top && line.cells[left].ch === CORNERS.bottomLeft);
	assert.ok(right !== -1 && bottom !== -1, `an overlay box that opens at row ${top} and does not close`);

	const rows = [];
	for (let row = top + 1; row < bottom; row++) {
		rows.push(slice(frame.lines[row], left + 1, right));
	}

	return { top, left, width: right - left + 1, rows };
}

/**
 * The column the side bar is separated from the editor area by, or `-1` while the side bar is
 * hidden. It is the arrangement invariant every other probe is measured from, and it is a *column*
 * rather than a character: a candidate only counts if every row above the status bar carries the
 * glyph there.
 */
export function dividerColumn(frame) {
	const body = bodyLines(frame);

	for (let col = ACTIVITY_BAR_COLUMNS; col < frame.cols; col++) {
		if (body.every(line => line.cells[col].ch === RULE)) {
			return col;
		}
	}

	return -1;
}

/** The same, asserted — every probe below is about a part the divider separates. */
function divider(frame) {
	const col = dividerColumn(frame);
	assert.notEqual(col, -1, `no divider column in a ${frame.cols}-column frame: ${JSON.stringify(bodyLines(frame)[1]?.text)}`);

	return col;
}

/** The activity bar's entries, one per view container, top to bottom. */
export function activityEntries(frame) {
	return bodyLines(frame)
		.map(line => slice(line, 0, ACTIVITY_BAR_COLUMNS))
		.filter(line => line.text.trim().length > 0)
		.map(line => ({ text: line.text.trim(), bold: line.cells[1].bold, fg: line.cells[1].fg }));
}

/** The side bar's rows: its title first, then its views. */
export function sideBarLines(frame) {
	const col = divider(frame);

	return bodyLines(frame).map(line => slice(line, ACTIVITY_BAR_COLUMNS, col));
}

/** The editor area's rows: its tab strip first, then the active editor. */
export function editorLines(frame) {
	const col = dividerColumn(frame);

	return bodyLines(frame).map(line => slice(line, col + 1, frame.cols));
}

/** The side bar's title, which is `ViewPaneContainer.getTitle` uppercased. */
export function sideBarTitle(frame) {
	return sideBarLines(frame)[0].text.trim();
}

/**
 * The side bar row the keyboard is on, found by the colour a selected list row is drawn in — the
 * same shape `activeTab` uses, and for the same reason: a cell's colour is the only place a theme
 * value exists as data, so the caller names the ids and the probe finds the row.
 *
 * @returns {{ row: number, text: string, fg: string, bg: string }} `row` is the index within the
 *   side bar, so the title is 0 and a container's first list row is 1 or 2 depending on its header.
 */
export function selectedRow(frame, background) {
	const lines = sideBarLines(frame);
	const at = lines.findIndex(line => line.cells.some(cell => cell.bg === background));
	assert.notEqual(at, -1, `no side bar row is drawn in ${background}, so nothing is selected`);

	const cell = lines[at].cells.find(candidate => candidate.bg === background);

	return { row: at, text: lines[at].text.trim(), fg: cell.fg, bg: cell.bg };
}

/**
 * A view's header row: a space, then a twistie, which no pane row can produce — a row at depth zero
 * puts its twistie in column 0 and every deeper row puts it in an even column. Either state counts:
 * a collapsed view is a header with no rows under it, so its header is the only thing left of it.
 */
const isViewHeader = line => !!line && line.cells[0]?.ch === ' ' && (line.cells[1]?.ch === OPEN || line.cells[1]?.ch === CLOSED);

/** The rule a header carries on its top, which is the row above it and belongs to it. */
const isViewRule = line => !!line && /^─+$/.test(line.text);

/**
 * The side bar's views, each as the lines below its header. A container that merged its single view
 * into the title has no header, and is therefore one section holding everything below the title.
 */
function viewSections(frame) {
	const lines = sideBarLines(frame).slice(TITLE_ROWS);
	const headers = lines.flatMap((line, index) => isViewHeader(line) ? [index] : []);
	if (headers.length === 0) {
		return [lines];
	}

	// A header's rule is the row above it, so it is the *next* view's and not this one's last row.
	return headers.map((start, index) => {
		const section = lines.slice(start + 1, headers[index + 1] ?? lines.length);
		while (isViewRule(section.at(-1))) {
			section.pop();
		}

		return section;
	});
}

/** The rows the shown container's first view owns. */
const paneLines = frame => viewSections(frame)[0] ?? [];

/**
 * The first view's rows as text, indentation included — which is where a twistie box shows up, or
 * does not: `views.css` gives a `force-no-twistie` row none, and a row without one starts at the
 * column its siblings put their twistie in.
 */
export const paneTextLines = frame => paneLines(frame).map(line => line.text);

/**
 * The rule above each view header, as the colour it is drawn in. `Pane.updateStyles` puts
 * `1px solid sideBarSectionHeader.border` on the top of every visible header
 * (`paneview.ts:396`), and a row of `─` is what a terminal can spend on it.
 */
export function viewRules(frame) {
	const lines = sideBarLines(frame).slice(TITLE_ROWS);

	return lines.flatMap((line, index) => isViewRule(line) && isViewHeader(lines[index + 1]) ? [line.cells[0].fg] : []);
}

/** Each view's header row, in the order they are stacked: its name, and its twistie's state. */
const headerLines = frame => sideBarLines(frame).slice(TITLE_ROWS).filter(isViewHeader);

/** The name on each view's header, in the order they are stacked. */
export function viewHeaders(frame) {
	return headerLines(frame).map(line => line.text.trim().slice(2));
}

/** The names of the views whose header carries a collapsed twistie — `Pane.isExpanded` off a frame. */
export function collapsedViews(frame) {
	return headerLines(frame).filter(line => line.cells[1].ch === CLOSED).map(line => line.text.trim().slice(2));
}

/**
 * The rows of the container's second view — the Graph under Changes, the commit-info drawer under
 * the smartlog. Empty for a container that has only one.
 */
export function regionLines(frame) {
	return (viewSections(frame)[1] ?? []).map(line => line.text).filter(text => text.length > 0);
}

/**
 * The pane's list, parsed.
 *
 * A row's content starts at its twistie (`'  '.repeat(depth - 1)` before it) or, for a leaf, two
 * spaces further in — so the first non-space column is what gives both the depth and where the
 * text begins. `skip` drops a pane's header rows, which do not scroll and are not list rows.
 *
 * **After the twistie there may be a file icon**, which the file icon theme draws as one glyph and
 * a column of separation — the same two columns. In a tree `views.css` gave
 * `align-icons-and-twisties` (the explorer and the source control view, because Seti has file icons
 * and no folder icons) a file row spends those columns on the icon *instead of* the twistie, which
 * is what puts its name under the names of the folders beside it; in the search view, which upstream
 * does not give that class, a file row carries both.
 *
 * @returns {{ depth: number, collapsible: boolean, open: boolean, icon: string | undefined, text: string, column: number, cells: object[] }[]}
 */
function treeRows(frame, { skip = 0, iconsAlignedWithTwisties = false } = {}) {
	const rows = [];

	for (const line of paneLines(frame).slice(skip)) {
		const indent = line.text.search(/\S/);
		if (indent === -1) {
			continue;
		}

		const twistie = line.text[indent] === OPEN || line.text[indent] === CLOSED ? line.text[indent] : undefined;
		let column = twistie ? indent + 2 : indent;

		// One glyph and a space, with a name behind it: nothing else in a row is shaped that way.
		const icon = line.text[column + 1] === ' ' && line.text.slice(column + 2).trim() ? line.text[column] : undefined;
		if (icon) {
			column += 2;
		}

		rows.push({
			// A twistie sits at its level's indent, and so does an icon that replaced one; a leaf's
			// own two spaces — blank twistie or none — put it one level in.
			depth: twistie || (icon && iconsAlignedWithTwisties) ? indent / 2 + 1 : indent / 2,
			collapsible: !!twistie,
			open: twistie === OPEN,
			icon,
			iconColour: icon ? line.cells[column - 2].fg : undefined,
			text: line.text.slice(column),
			column,
			cells: line.cells
		});
	}

	return rows;
}

/** The colour of the cell `offset` characters into a row's text. */
function colourAt(row, offset) {
	const cell = row.cells[row.column + offset];
	assert.ok(cell, `column ${row.column + offset} is off the frame for ${JSON.stringify(row.text)}`);

	return cell;
}

/** The colour of the first cell of `text` within a row, which is where a span's colour is. */
export function colourOf(row, text) {
	const offset = row.text.indexOf(text);
	assert.notEqual(offset, -1, `${JSON.stringify(text)} is not in ${JSON.stringify(row.text)}`);

	return colourAt(row, offset);
}

/**
 * The decoration badge at the end of a row, which is where `IDecorationsService` puts one:
 * `DecorationRule` writes the status letter as `::after` content on the label and its
 * `gitDecoration.*` colour beside it, and `iconlabel.css`'s margin is what separates it from the
 * name by a column. Undefined for a row nothing decorates.
 */
function badgeOf(row) {
	return /\s(\S)$/.exec(row.text.trimEnd()) ?? undefined;
}

/** A row's name and the decoration on it, which is the split every list row here shares. */
function decorated(row) {
	const badge = badgeOf(row);

	return {
		name: row.text.slice(0, badge?.index).trim(),
		letter: badge?.[1] ?? '',
		colour: badge ? colourAt(row, badge.index + 1).fg : undefined
	};
}

/**
 * The header rows a view root puts above a pane: where the pane is rooted, and — while the box is
 * up — the query it is typed into. Both panes with a view root draw the two the same way, so
 * `rooted` and `open` say which of them are there, the way the search pane's `details` and `replace`
 * do, and `rows` is what a row probe has to skip past.
 */
export function filterBox(frame, { rooted = false, open = true } = {}) {
	const lines = paneLines(frame);

	return {
		root: rooted ? lines[0].text.trim() : undefined,
		input: open ? withoutCaret(lines[rooted ? 1 : 0].text.trim()) : undefined,
		rows: (rooted ? 1 : 0) + (open ? 1 : 0)
	};
}

//#region --- the editor area

/**
 * The tab strip, one entry per open editor. Each tab is closed by the `tab.border` rule upstream's
 * `redrawTabBorders` puts on its right, so the strip splits on that rather than on a colour — two
 * inactive tabs are the same colour as the container they sit in, in this theme and in most.
 */
export function editorTabs(frame) {
	const strip = editorLines(frame)[0];
	const tabs = [];
	let start = 0;

	for (const [index, cell] of strip.cells.entries()) {
		if (cell.ch !== RULE) {
			continue;
		}

		const label = slice(strip, start, index);
		tabs.push({ name: label.text.trim(), bg: label.cells[1].bg, fg: label.cells[1].fg, italic: false });
		start = index + 1;
	}

	return tabs;
}

/** The active tab is the one drawn in `tab.activeBackground`, which the caller names. */
export const activeTab = (frame, activeBackground) => editorTabs(frame).find(tab => tab.bg === activeBackground);

/** The active editor's own rows — everything in the editor area below the tab strip. */
export function editorRows(frame) {
	return editorLines(frame).slice(1).map(line => line.text).filter(text => text.length > 0);
}

//#endregion

//#region --- explorer

/**
 * A row is `twistie + name + badge`, and a directory is the only row the tree makes collapsible.
 * `nameColour` is the label's own, which is what a decoration's `labelClassName` colours.
 */
export function explorerRows(frame, { skip = 0 } = {}) {
	return treeRows(frame, { skip, iconsAlignedWithTwisties: true }).map(row => ({ ...row, ...decorated(row), nameColour: colourAt(row, 0).fg }));
}

//#endregion

//#region --- search

/**
 * What a text input draws where the keyboard is — the search pane's query box, the commit box and a
 * quick input's filter row all draw the same one, so what strips it lives here once.
 */
const CARET = '▏';

/** A row's text with the caret taken off, which is not part of what was typed. */
export const withoutCaret = text => text.replace(CARET, '');

/**
 * `FindInput`'s three toggles, at the end of the query row and in the order upstream builds them.
 * Each is the mnemonic its codicon draws, since there is no icon font here.
 */
const TOGGLES = ['Aa', 'ab', '.*'];
const TOGGLE_SUFFIX = TOGGLES.map(label => ` ${label}`).join('');

/** `FindInput`'s fourth toggle, which upstream draws on the replace box rather than on the query. */
const PRESERVE_CASE = 'AB';

/**
 * The header rows: the query box with its caret and its toggles, the replace box when
 * `workbench.action.replaceInFiles` has opened it, the two glob boxes when the query details are
 * showing, `buildResultCountMessage`'s answer, and — while `/` is open — the filter row, which is
 * drawn last so that it sits against the rows it filters. `details`, `replace` and `filter` say
 * which layout to read, because the number of header rows is what separates them from the list.
 */
export function searchView(frame, { details = false, replace = false, filter = false } = {}) {
	const lines = paneLines(frame);
	const query = lines[0];
	const trimmed = query.text.trimEnd();
	const at = trimmed.length - TOGGLE_SUFFIX.length;
	assert.equal(trimmed.slice(at), TOGGLE_SUFFIX, `the query row has no toggles: ${JSON.stringify(trimmed)}`);

	const header = 2 + (replace ? 1 : 0) + (details ? 2 : 0) + (filter ? 1 : 0);
	const replaceRow = replace ? lines[1] : undefined;
	const replaceAt = replaceRow ? replaceRow.text.trimEnd().length - PRESERVE_CASE.length - 1 : 0;

	return {
		// The caret is the box's focus, and it is not part of what was typed.
		query: withoutCaret(trimmed.slice(0, at).trim()),
		/** Whether the query box is the one taking keys, which is the only mark focus leaves on it. */
		caret: trimmed.slice(0, at).trimEnd().endsWith(CARET),
		// A toggle is on when it is drawn in `inputOption.activeBackground`, which is the whole of
		// what a terminal can show of `FindInput`'s checked state.
		toggles: Object.fromEntries(TOGGLES.map((label, index) => [label, query.cells[at + 1 + index * 3].bg])),
		/** The replace term, and the state of the `preserveCase` toggle drawn at the end of its box. */
		replace: replaceRow ? withoutCaret(replaceRow.text.trimEnd().slice(0, replaceAt).trim()) : undefined,
		/**
		 * What that box's first character is drawn in, which is the only thing that tells a term
		 * from the placeholder standing in for one: `inputSpans` draws a value in `input.foreground`
		 * and a placeholder in `input.placeholderForeground`, and both read as text.
		 */
		replaceFg: replaceRow ? replaceRow.cells[1].fg : undefined,
		preserveCase: replaceRow ? replaceRow.cells[replaceAt + 1].bg : undefined,
		boxes: lines.slice(replace ? 2 : 1, header - 1 - (filter ? 1 : 0)).map(line => withoutCaret(line.text.trim())),
		message: lines[header - 1 - (filter ? 1 : 0)].text.trim(),
		/** What the `/` row holds, caret and all — the caret is what says it is the box taking keys. */
		filter: filter ? withoutCaret(lines[header - 1].text.trim()) : undefined,
		filterCaret: filter ? lines[header - 1].text.trimEnd().endsWith(CARET) : undefined,
		rows: searchRows(frame, header)
	};
}

/**
 * A folder or file row is `name`, its folder, and a `CountBadge`; a match row is the three parts of
 * `preview()`. Only the first is collapsible, which is what tells them apart.
 */
function searchRows(frame, skip = 2) {
	return treeRows(frame, { skip }).map(row => {
		if (!row.collapsible) {
			return { ...row, preview: row.text };
		}

		const badge = /^(.*?)\s+(\d+)$/.exec(row.text);
		assert.ok(badge, `no count badge on the search row ${JSON.stringify(row.text)}`);
		const [name, ...folder] = badge[1].split(/\s+/);

		return { ...row, name, folder: folder.join(' '), count: Number(badge[2]) };
	});
}

//#endregion

//#region --- source control

/**
 * A label with the count beside it, which is what a repository row and a group row both draw —
 * `CountBadge`, separated from the label by `scm.css`'s `.count { margin-left: 6px }`. Answers
 * nothing for a row that carries no count, which is how the two are told apart from the commit
 * input and the action button beside them.
 */
function counted(row) {
	const match = /^(.*?)\s+(\d+)$/.exec(row.text);

	return match ? { label: match[1], count: Number(match[2]) } : undefined;
}

/**
 * A resource row: the file name, the folder it is in — in list mode only — and the status letter
 * in the colour `TauriGitDecorationProvider` gave it.
 */
function resource(row) {
	const { name: text, ...decoration } = decorated(row);
	const [name, ...folder] = text.split(/\s+/);

	return { depth: row.depth, ...decoration, name, folder: folder.join(' ') };
}

/**
 * The view as `SCMTreeDataSource` built it: every visible repository, its groups, and what is under
 * each of them.
 *
 * The hierarchy is the rows' own depths, and the discrimination is a count on a row that opens: a
 * repository and a group each draw a `CountBadge` and each has children, while the commit input and
 * the action button beside them have neither. Below a group, a collapsible row is one of the folders
 * tree mode builds out of a resource's path and a leaf is a resource.
 *
 * **At a view root there is no repository row at all** — the pane is displayed from one, so its
 * groups are the top level and every row is one level shallower. `rooted` is that: one repository
 * with no row of its own, and the same parse a level down.
 */
export function scmSnapshot(frame, { skip = 0, rooted = false } = {}) {
	const repositories = [];
	let repository = rooted ? { label: undefined, count: undefined, groups: [] } : undefined;
	let group;

	if (repository) {
		repositories.push(repository);
	}

	for (const row of treeRows(frame, { skip })) {
		const count = row.collapsible ? counted(row) : undefined;
		const depth = row.depth + (rooted ? 1 : 0);

		if (depth === 1 && count) {
			repository = { ...count, groups: [] };
			repositories.push(repository);
			group = undefined;
		} else if (depth === 2 && count) {
			group = { ...count, folders: [], resources: [] };
			repository?.groups.push(group);
		} else if (depth >= 3 && group) {
			if (row.collapsible) {
				group.folders.push(row.text.slice(0, badgeOf(row)?.index).trim());
			} else {
				group.resources.push(resource(row));
			}
		}
	}

	return repositories;
}

//#endregion

//#region --- sapling

/**
 * The smartlog as lines, untouched: every glyph in them is `TextRenderer`'s, so a parse here would
 * be this suite deciding what the graph looks like. The pane's status line — "Loading…", "No
 * Sapling repository in this folder." — comes back as a single line, which is what separates a
 * graph from the absence of one.
 */
export function saplingLines(frame) {
	return paneTextLines(frame).filter(text => text.length > 0);
}

//#endregion
