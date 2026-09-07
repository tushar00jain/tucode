// Named probes over the workbench.
//
// Every probe distinguishes "the feature answered, and the answer was empty"
// from "the feature never answered": an empty return is a fact, and anything
// structural — a missing view, a query that never reached a terminal state — is
// a thrown error naming what was observed instead.

import { settledRead as settle } from './settled.mjs';
import { POLL, QUIET, READ_TIMEOUT, waitFor, waitForElement, waitForRead } from './wait.mjs';

// The activity bar item, not its icon: a view with a badge — search's result
// count, source control's pending-change count — has the badge overlapping the
// icon, and a click aimed at the icon lands on the badge instead.
const activityBarItem = icon => `.activitybar .action-item:has(.action-label.codicon-${icon})`;

// Sapling's container draws its icon from a URI rather than a codicon, so there is no
// `codicon-` class to aim at; the label's own `aria-label` is what names it instead. The
// item's is empty until a badge gives it one, which a view container without one never does.
const activityBarItemLabelled = label => `.activitybar .action-item:has(.action-label[aria-label^="${label}"])`;

const VIEWS = {
	explorer: { icon: 'explorer-view-icon', body: '.explorer-folders-view' },
	search: { icon: 'search-view-icon', body: '.search-view' },
	// `:not(.scm-history-view)` because the Graph pane's tree carries `.scm-view` too.
	scm: { icon: 'source-control-view-icon', body: '.scm-view:not(.scm-history-view)' },
	// The smartlog is not a list widget, so what takes the keyboard is the element `saplingViewPane`
	// gave a `tabIndex` to — `.sapling-scroll`, which is also the element its own `keydown` steps
	// the selection from.
	sapling: { label: 'Sapling', body: '.sapling-smartlog', focus: '.sapling-scroll' }
};

const SEARCH_QUERY_BOX = '.search-view .search-widget .monaco-findInput textarea, .search-view .search-widget .monaco-findInput input';
const SEARCH_INCLUDE_BOX = '.search-view .query-details .file-types.includes .monaco-inputbox input';
const SEARCH_EXCLUDE_BOX = '.search-view .query-details .file-types.excludes .monaco-inputbox input';
const SEARCH_DETAILS_TOGGLE = '.search-view .query-details .more';

/** `SearchAccessibilityProvider.getAriaLabel`'s three shapes, read back. */
const FILE_ROW = /^(\d+) matches? in file (.+?) of folder (.+?), Search result$/;
const MATCH_ROW = /^'([\s\S]*)' at column (\d+) found ([\s\S]*)$/;
const FOLDER_ROW = /^(\d+) matches? in folder root (.+?), Search result$/;

/** `SearchView.buildResultCountMessage` and its no-results counterparts. */
const RESULT_COUNT = /([\d,]+) results? in ([\d,]+) files?/;
const NO_RESULTS = /^No results found/;

/** Whether a view's body is on screen, which is the whole of what "this view is open" means. */
const readViewVisible = selector => {
	const element = document.querySelector(selector);
	return !!element && element.getBoundingClientRect().height > 0;
};

/**
 * What one click on an activity bar item is given to answer before the click is made again.
 *
 * `READ_TIMEOUT` is what bounds `openView` as a whole; this only decides how many attempts fit
 * inside it, and it is a few times what a view that is going to appear takes.
 */
const VIEW_CLICK_TIMEOUT = 2_000;

/**
 * Opens a view, and answers with the selector its body is at.
 *
 * **The activity bar item is a toggle**, so reading whether the view is visible and *then* clicking
 * is a check-then-act: the reading can stop being true before the click lands — a previous step
 * leaves a view settling — and the click meant to open the sidebar closes it instead, after which
 * the wait for the body can never succeed. That is how one keyboard step failed twice consecutively
 * and passed in isolation.
 *
 * Nothing over CDP can make the read and the click one act, so the end state is what this asserts
 * rather than the decision: each pass re-reads, clicks only while the body is still not visible, and
 * waits out what that click did. A click that toggled the sidebar shut is corrected by the next pass
 * instead of reported as a view that never opened, and a caller whose view is already open never
 * clicks at all.
 *
 * **The reading after a click is `quietMs`, not the settle question**, and that is measured rather
 * than chosen: the sidebar goes about ten milliseconds after `page.click` resolves, and the app
 * answers `settled: true` with nothing outstanding in between — so a reading taken then says the
 * view is still open when the click that just closed it is what is being read. Only "the reading
 * held still" separates a view that is open from one that is on its way out, which is the same thing
 * `settled.mjs` says about a shell painting: the settle signal does not cover it.
 */
export async function openView(page, name) {
	const view = VIEWS[name];
	if (!view) {
		throw new Error(`unknown view ${JSON.stringify(name)}; known: ${Object.keys(VIEWS).join(', ')}`);
	}
	const item = view.icon ? activityBarItem(view.icon) : activityBarItemLabelled(view.label);

	const deadline = Date.now() + READ_TIMEOUT;
	for (let clicks = 0; ; clicks++) {
		if (await page.evaluate(readViewVisible, view.body)) {
			return view.body;
		}
		if (Date.now() >= deadline) {
			throw new Error(`the ${name} view never appeared after ${clicks} clicks on its activity bar item within ${READ_TIMEOUT} ms`);
		}
		await page.click(item);
		// A click that opened nothing is not the failure — it is a click that toggled the sidebar
		// shut, and the next pass reads that and clicks again. Only the deadline above fails.
		await settle(page, {
			read: readViewVisible,
			readArg: view.body,
			terminal: value => value,
			quietMs: QUIET,
			what: `the ${name} view after a click on its activity bar item`,
			timeoutMs: Math.min(VIEW_CLICK_TIMEOUT, Math.max(deadline - Date.now(), 0))
		}).catch(() => undefined);
	}
}

async function setInputValue(page, selector, value) {
	await page.click(selector);
	await page.keyboard.press('Control+a');
	if (value) {
		await page.keyboard.type(value);
	} else {
		await page.keyboard.press('Backspace');
	}
}

const readSearchState = () => {
	const view = document.querySelector('.search-view');
	if (!view) {
		return { present: false, message: '', rows: [] };
	}
	const messages = view.querySelector('.messages');
	const message = messages && messages.style.display !== 'none'
		? messages.innerText.replace(/\s+/g, ' ').trim()
		: '';
	const rows = [...view.querySelectorAll('.monaco-list-row')].map(row => ({
		aria: row.getAttribute('aria-label') ?? '',
		text: row.innerText.replace(/\s+/g, ' ').trim()
	}));
	// `SearchView` reports to its own view container's progress bar (`getProgressLocation`, with
	// `delay: 0` on the query path), so the sidebar's is what says a query is still running. The
	// result message counts up while it runs, which is why the message alone cannot say.
	const busy = !!document.querySelector('.part.sidebar .monaco-progress-container.active');
	return { present: true, busy, message, rows };
};

const searchIsTerminal = state => state.present && !state.busy && (NO_RESULTS.test(state.message) || RESULT_COUNT.test(state.message));

function parseSearchMessage(message) {
	if (NO_RESULTS.test(message)) {
		return { resultCount: 0, fileCount: 0 };
	}
	const match = RESULT_COUNT.exec(message);
	if (!match) {
		return { resultCount: undefined, fileCount: undefined };
	}
	return { resultCount: Number(match[1].replace(/,/g, '')), fileCount: Number(match[2].replace(/,/g, '')) };
}

/**
 * Groups the visible rows into files and their matches. The tree is virtualised,
 * so this describes what is on screen — the counts in `message` describe the
 * whole result set.
 */
function parseSearchRows(rows) {
	const files = [];
	const folders = [];
	for (const row of rows) {
		const folder = FOLDER_ROW.exec(row.aria);
		if (folder) {
			folders.push({ name: folder[2], matchCount: Number(folder[1]) });
			continue;
		}
		const file = FILE_ROW.exec(row.aria);
		if (file) {
			files.push({ name: file[2], folder: file[3], matchCount: Number(file[1]), matches: [] });
			continue;
		}
		const match = MATCH_ROW.exec(row.aria);
		if (match && files.length > 0) {
			files.at(-1).matches.push({ text: match[1], column: Number(match[2]), matchString: match[3], rowText: row.text });
		}
	}
	return { files, folders };
}

/** What a cleared search view holds: no rows, and nothing left of the previous query's message. */
const readSearchLeftovers = () => {
	const view = document.querySelector('.search-view');
	if (!view) {
		return { present: false, rows: -1, message: '' };
	}
	const messages = view.querySelector('.messages');
	return {
		present: true,
		rows: view.querySelectorAll('.monaco-list-row').length,
		message: messages && messages.style.display !== 'none' ? messages.innerText.trim() : ''
	};
};

async function resetSearchQuery(page) {
	await setInputValue(page, SEARCH_QUERY_BOX, '');
	// **Not through `settle`.** This one wait is deliberately left polling without asking the app,
	// because the app answers wrong here: clearing the box leaves the view's *message* to be
	// redrawn on the view's own scheduler, which is the one thing `settled.ts` says it does not
	// cover — routed through `settle` this failed after its grace with the previous query's
	// message still on screen, and took seven passing tests with it.
	await waitForRead(page, {
		read: readSearchLeftovers,
		holds: state => state.present && state.rows === 0 && state.message === '',
		what: 'the search view never cleared after its query box was emptied'
	});
}

async function applySearchFilters(page, include, exclude) {
	const expanded = await page.evaluate(() => !!document.querySelector('.search-view .query-details.more'));
	if (!expanded) {
		await page.click(SEARCH_DETAILS_TOGGLE);
		await waitForElement(page, SEARCH_INCLUDE_BOX, { state: 'visible', what: 'the search view\'s include box never appeared after its query details were expanded' });
	}
	await setInputValue(page, SEARCH_INCLUDE_BOX, include);
	await setInputValue(page, SEARCH_EXCLUDE_BOX, exclude);
}

/**
 * Runs one text query from a cleared view and a known filter state, so the
 * reading can never be the previous query's.
 *
 * @returns {Promise<{ query: string, message: string, resultCount: number, fileCount: number, files: object[], folders: object[], rows: object[] }>}
 */
export async function textSearch(page, query, { include = '', exclude = '', timeoutMs = READ_TIMEOUT } = {}) {
	await openView(page, 'search');
	await resetSearchQuery(page);
	await applySearchFilters(page, include, exclude);
	await page.click(SEARCH_QUERY_BOX);
	await page.keyboard.type(query);
	const state = await settle(page, { read: readSearchState, terminal: searchIsTerminal, what: `text search ${JSON.stringify(query)}`, timeoutMs });
	return { query, include, exclude, message: state.message, ...parseSearchMessage(state.message), ...parseSearchRows(state.rows), rows: state.rows };
}

/**
 * What the *first* text search of a launch is allowed to take.
 *
 * **The first read of a file by this binary costs about a millisecond that every later read does
 * not.** Measured as the engine's own `fileWalkTime` over the fixture's 30 000-file corpus: 38 s on
 * the first query of a launch, 0.4 s on every one after it, with the same `filesWalked`. It is not
 * the application's — a second launch over a corpus a first launch had already read walked it in
 * 389 ms, so nothing in the process is being warmed — and it is not the disk's either: `grep` over
 * the same fresh corpus costs 6.6 s cold against 5.6 s warm, and reading every file from node
 * before the launch changes the app's first query by nothing at all. It is on-access scanning
 * charged per file to this unsigned binary, and paid once.
 *
 * So it is paid deliberately, once, in the session's boot, and this is the bound on that one wait.
 * Every other wait in the suite stays bound to what the feature takes.
 */
export const WARM_SEARCH_TIMEOUT = 60_000;

/**
 * Runs the query that pays that cost, over the whole workspace, and fails if the corpus it walked
 * was not the whole one — a warm-up that silently searched nothing warms nothing.
 */
export async function warmSearch(page, query, expectedResultCount) {
	const result = await textSearch(page, query, { timeoutMs: WARM_SEARCH_TIMEOUT });
	if (result.resultCount !== expectedResultCount) {
		throw new Error(`the warming search found ${result.resultCount} results, expected ${expectedResultCount}: ${result.message}`);
	}
}

/**
 * Runs a query while sampling the view's own running result count, so a result
 * set that arrives in batches can be told apart from one that arrives at the end.
 */
export async function streamingTextSearch(page, query, { pollMs = 25 } = {}) {
	await openView(page, 'search');
	await resetSearchQuery(page);
	await applySearchFilters(page, '', '');
	await page.evaluate(interval => {
		globalThis.__tscodeSamples = [];
		const start = performance.now();
		globalThis.__tscodePoll = setInterval(() => {
			const messages = document.querySelector('.search-view .messages');
			const text = messages && messages.style.display !== 'none' ? messages.innerText.replace(/\s+/g, ' ').trim() : '';
			const running = !!document.querySelector('.sidebar .monaco-progress-container.active, .search-view .monaco-progress-container.active');
			globalThis.__tscodeSamples.push([Math.round(performance.now() - start), text, running]);
		}, interval);
	}, pollMs);
	await page.click(SEARCH_QUERY_BOX);
	await page.keyboard.type(query);
	const state = await settle(page, { read: readSearchState, terminal: searchIsTerminal, what: `streaming text search ${JSON.stringify(query)}` });
	const raw = await page.evaluate(() => {
		clearInterval(globalThis.__tscodePoll);
		const samples = globalThis.__tscodeSamples;
		delete globalThis.__tscodePoll;
		delete globalThis.__tscodeSamples;
		return samples;
	});
	const samples = raw
		.map(([at, text, running]) => ({ at, count: parseSearchMessage(text).resultCount ?? 0, running }))
		.filter((sample, index, all) => index === 0 || all[index - 1].count !== sample.count || all[index - 1].running !== sample.running);
	return { query, message: state.message, ...parseSearchMessage(state.message), samples, sampleCount: raw.length };
}

// The workbench holds more than one `.quick-input-widget`, all but one of them
// permanently hidden, so every reading has to pick the visible one.
const readQuickOpenState = () => {
	const widget = [...document.querySelectorAll('.quick-input-widget')]
		.find(candidate => candidate.style.display !== 'none' && candidate.getBoundingClientRect().height > 0);
	if (!widget) {
		return { present: false, busy: false, picks: [] };
	}
	const picks = [...widget.querySelectorAll('.quick-input-list .monaco-list-row')].map(row => ({
		label: row.querySelector('.label-name')?.textContent.trim() ?? row.innerText.replace(/\s+/g, ' ').trim(),
		description: row.querySelector('.label-description')?.textContent.trim() ?? '',
		aria: row.getAttribute('aria-label') ?? ''
	}));
	return { present: true, busy: !!widget.querySelector('.monaco-progress-container.active'), picks };
};

export async function waitForQuickOpen(page, present, what) {
	return waitFor(async () => {
		const state = await page.evaluate(readQuickOpenState);
		return state.present === present ? state : undefined;
	}, { what, poll: POLL });
}

/** @returns {Promise<{ query: string, picks: { label: string, description: string }[] }>} */
export async function quickOpen(page, query) {
	await closeQuickOpen(page);
	await page.keyboard.press('Control+p');
	await waitForQuickOpen(page, true, 'Ctrl+P did not open the quick input widget');
	// The widget already has focus; clicking into it risks blurring it shut.
	await page.keyboard.press('Control+a');
	if (query) {
		await page.keyboard.type(query);
	} else {
		await page.keyboard.press('Backspace');
	}
	const state = await settle(page, {
		read: readQuickOpenState,
		// The picker is idle before the file search starts, so `!busy` alone reads the list the
		// *previous* query left behind — which is what three seconds of waiting was standing in for.
		// A row is the condition instead: `pickerQuickAccess.ts:196` substitutes the provider's
		// `noResultsPick` when a filtered query matches nothing, so a non-empty query that has
		// answered always has at least one row, and "found nothing" reads as the row that says so.
		terminal: value => value.present && !value.busy && (query === '' || value.picks.length > 0),
		what: `quick open ${JSON.stringify(query)}`
	});
	return { query, picks: state.picks };
}

export async function closeQuickOpen(page) {
	await page.keyboard.press('Escape');
	await waitForQuickOpen(page, false, 'the quick input widget stayed open after Escape');
}

/**
 * Opens the file a path names, and waits for its editor.
 *
 * **The row `quickOpen` settles on is not necessarily this query's.** The picker is idle between a
 * keystroke and its own search, so `!busy && picks.length > 0` also describes the list it was
 * already holding — and once an earlier step has opened a file, that list is a non-empty history
 * rather than nothing. This step then pressed `Enter` on whatever was opened last: in the full run
 * it opened `LICENSE` for `alpha/src/longline.ts` and the `W` that followed was pressed over the
 * wrong file, which is why the keymap's editor row passed alone and timed out after other suites.
 * So the file this asks for is what it waits for.
 *
 * **And the line that is drawn is not necessarily this file's either.** A group keeps one text
 * editor pane across every text file it opens, so between `Enter` and the model arriving the lines
 * on screen are still the *previous* file's — a step that measured the editor there measured the
 * file before it, and got a baseline the file it opened need never come back to. The tab is what
 * says the input has been taken, so that is the second thing this waits for.
 */
export async function openFileByQuickOpen(page, query) {
	const name = query.split('/').pop();
	await quickOpen(page, query);
	const state = await settle(page, {
		read: readQuickOpenState,
		terminal: value => value.present && !value.busy && value.picks[0]?.label === name,
		what: `quick open ${JSON.stringify(query)} to offer ${JSON.stringify(name)} as its first pick`
	});
	await page.keyboard.press('Enter');
	await waitForElement(page, '.editor-instance .view-lines .view-line', { what: `no editor drew a line after Enter opened ${JSON.stringify(query)}` });
	await waitForRead(page, {
		read: readActiveEditorTab,
		holds: tab => tab === name,
		what: `Enter on ${JSON.stringify(query)} never made ${JSON.stringify(name)} the active editor`
	});
	return state.picks[0];
}

const readPaneRows = selector => [...document.querySelectorAll(`${selector} .monaco-list-row`)].map(row => ({
	name: row.querySelector('.label-name')?.textContent.trim() ?? row.innerText.replace(/\s+/g, ' ').trim(),
	level: Number(row.getAttribute('aria-level') ?? 0),
	expanded: row.getAttribute('aria-expanded'),
	// Which row a key would act on: `listView.ts` puts `.focused` on the element the list's own
	// focus is at, and every explorer command reads its resource off exactly that.
	focused: row.classList.contains('focused'),
	// The explorer's own mark for "this row is on the clipboard as a move", which
	// `explorerViewer.ts:997` draws from `IExplorerService.isCut` — and draws only once
	// `setToCopy`'s write to the clipboard has resolved, which is what makes it something a step
	// can wait on rather than sleep through.
	cut: !!row.querySelector('.cut'),
	// **What the rows a virtualised list did not render say about themselves.** `abstractTree.ts:184`
	// answers `getSetSize` with the parent's `visibleChildrenCount` and `getPosInSet` with the row's
	// own `visibleChildIndex` — so these two are facts about the whole level, read off a row that
	// happens to be on screen. That is the only way to tell "the query hid a row" from "the row is
	// scrolled out of the window" without walking the list.
	setSize: Number(row.getAttribute('aria-setsize') ?? 0),
	posInSet: Number(row.getAttribute('aria-posinset') ?? 0)
}));

/**
 * The rows a pane's list is drawing, in the order they are drawn — the same few facts for every
 * pane, because `.monaco-list-row` is upstream's own row wherever it appears.
 *
 * `holds` is the same discipline `editorText` is on: a keystroke reaches a tree through a rebuild
 * and comes back as a repaint, so a single read after one is a read of what was on screen before.
 *
 * @returns {Promise<{ name: string, level: number, expanded: string | null, focused: boolean, cut: boolean, setSize: number, posInSet: number }[]>}
 */
export async function paneRows(page, name, holds = () => true) {
	const body = await openView(page, name);
	return settle(page, { read: readPaneRows, readArg: body, terminal: holds, what: `the ${name} rows` });
}

export async function explorerRows(page, holds = () => true) {
	return paneRows(page, 'explorer', holds);
}

/**
 * The icon theme renders a file's glyph through the `::before` of its icon
 * label, so what it resolved to is only visible in computed style.
 */
export async function fileIconGlyph(page, name, { timeoutMs = READ_TIMEOUT } = {}) {
	await openView(page, 'explorer');
	const read = target => {
		const row = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')]
			.find(candidate => candidate.querySelector('.label-name')?.textContent.trim() === target);
		if (!row) {
			return null;
		}
		const label = row.querySelector('.monaco-icon-label');
		const before = getComputedStyle(label, '::before');
		return { classes: label.className, fontFamily: before.fontFamily, content: before.content, backgroundImage: before.backgroundImage };
	};
	// The icon theme's stylesheet is generated asynchronously after boot, so the
	// glyph resolves some time after the row exists. Whether it ever resolves is
	// the caller's assertion; this only gives it the chance.
	let glyph;
	try {
		return await waitFor(async () => {
			glyph = await page.evaluate(read, name);
			return glyph && (glyph.content !== 'none' || glyph.backgroundImage !== 'none') ? glyph : undefined;
		}, { what: `the icon glyph for ${JSON.stringify(name)} never resolved`, timeoutMs, poll: POLL });
	} catch { /* an unresolved glyph is the caller's to assert; a missing row is not */ }

	if (!glyph) {
		const rows = await explorerRows(page);
		throw new Error(`no explorer row named ${JSON.stringify(name)}; rows: ${JSON.stringify(rows.map(row => row.name))}`);
	}
	return glyph;
}

export async function loadedFonts(page) {
	return page.evaluate(async () => {
		await document.fonts.ready;
		return [...document.fonts].map(face => ({ family: face.family, status: face.status }));
	});
}

const readScmState = () => {
	const view = document.querySelector('.scm-view:not(.scm-history-view)');
	if (!view) {
		return { present: false, rows: [] };
	}
	const rows = [...view.querySelectorAll('.monaco-list-row')].map(row => {
		// The list is virtualised, so a reading describes a window onto it; `index` is what
		// lets `scmSnapshot` stitch several windows back into the whole list.
		const index = Number(row.getAttribute('data-index'));
		const provider = row.querySelector('.scm-provider');
		if (provider) {
			return {
				index,
				kind: 'repository',
				name: provider.querySelector('.label-name')?.textContent.trim() ?? '',
				description: provider.querySelector('.label-description')?.textContent.trim() ?? '',
				count: provider.querySelector('.count')?.textContent.trim() ?? ''
			};
		}
		const group = row.querySelector('.resource-group');
		if (group) {
			return { index, kind: 'group', name: group.querySelector('.name')?.textContent.trim() ?? '', count: group.querySelector('.count')?.textContent.trim() ?? '' };
		}
		const resource = row.querySelector('.resource');
		if (resource) {
			return {
				index,
				kind: 'resource',
				name: resource.querySelector('.label-name')?.textContent.trim() ?? '',
				letter: resource.querySelector('.decoration-icon')?.textContent.trim() ?? ''
			};
		}
		if (row.querySelector('.scm-input')) {
			return { index, kind: 'input' };
		}
		return { index, kind: 'other', text: row.innerText.replace(/\s+/g, ' ').trim() };
	});
	rows.sort((a, b) => a.index - b.index);
	return { present: true, rows };
};

/** How many wheel steps a walk down the source control list is given. */
const SCM_SCROLL_STEPS = 40;

/** What one wheel notch's repaint is allowed to take. A scroll is synchronous work, not a query. */
const SCROLL_TIMEOUT = 1000;

/**
 * Where the virtualised list is scrolled to, as the render position of its rows.
 *
 * `listView.ts:953` writes `rowsContainer.style.top = -renderTop` on every render, and that is
 * what this reads. Its neighbour on line 418 — the `translate3d` this read before — is written
 * *once*, at construction, and only when `transformOptimization` is on; the source control tree
 * leaves it off, so that reading was the empty string at every scroll position. Every wheel notch
 * then reported that it had moved nothing, `resetScmScroll` gave up on its first notch, and each
 * probe after the first started its walk wherever the previous one had left the list — with
 * `alpha`'s eight rows above the window, which read as a repository that was never registered.
 */
const readScmScrollTop = () => {
	const rows = document.querySelector('.scm-view:not(.scm-history-view) .monaco-list-rows');
	return rows ? rows.style.top : '';
};

/**
 * One wheel notch over the source control list, waited out by the thing it moves rather than by
 * the clock: the list re-renders its rows at a new offset, and `transform` is where that lands.
 * A notch that moves nothing is the list already at that end, which is a fact both callers act
 * on — so it is returned rather than thrown, and the bound is what a repaint takes.
 */
async function wheelScmList(page, deltaY) {
	const before = await page.evaluate(readScmScrollTop);
	await page.mouse.wheel(0, deltaY);
	try {
		await waitFor(async () => await page.evaluate(readScmScrollTop) !== before, { what: 'the source control list did not scroll', timeoutMs: SCROLL_TIMEOUT });
		return true;
	} catch {
		return false;
	}
}

/**
 * Puts the mouse over the source control list and scrolls it to the top, which is where
 * every walk of it starts — a previous probe may have left it anywhere.
 */
async function resetScmScroll(page) {
	const box = await page.locator('.scm-view:not(.scm-history-view)').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	for (let step = 0; step < SCM_SCROLL_STEPS; step++) {
		if (!await wheelScmList(page, -400)) {
			return;
		}
	}
}

/**
 * The whole source control list, stitched out of the windows the virtualised tree renders.
 * The pane is too short to hold every repository at once now that the Graph shares its
 * container, and a row that was never rendered is indistinguishable from a repository that
 * was never registered unless the list is walked.
 */
async function sweepScmRows(page) {
	await resetScmScroll(page);

	const rows = new Map();
	let highest = -1;

	for (let step = 0; step < SCM_SCROLL_STEPS; step++) {
		const state = await page.evaluate(readScmState);
		for (const row of state.rows) {
			rows.set(row.index, row);
		}

		const last = Math.max(...rows.keys());
		if (last === highest) {
			break;
		}
		highest = last;

		await wheelScmList(page, 200);
	}

	return [...rows.keys()].sort((a, b) => a - b).map(index => rows.get(index));
}

/**
 * @returns {Promise<{ repositories: { name: string, groups: { name: string, count: number, resources: string[] }[] }[], rows: object[] }>}
 */
export async function scmSnapshot(page, { expectedRepositories = 1 } = {}) {
	await openView(page, 'scm');
	await setGraphPane(page, false);
	await settle(page, {
		read: readScmState,
		terminal: value => value.present && value.rows.some(row => row.kind === 'group'),
		what: 'source control view'
	});

	const allRows = await sweepScmRows(page);
	const repositoryCount = allRows.filter(row => row.kind === 'repository').length;
	if (repositoryCount < expectedRepositories) {
		throw new Error(`the source control view lists ${repositoryCount} repositories, expected ${expectedRepositories}: ${JSON.stringify(allRows)}`);
	}

	const repositories = [];
	for (const row of allRows) {
		if (row.kind === 'repository') {
			repositories.push({ name: row.name, description: row.description, groups: [] });
		} else if (row.kind === 'group' && repositories.length > 0) {
			repositories.at(-1).groups.push({ name: row.name, count: Number(row.count) || 0, resources: [] });
		} else if (row.kind === 'resource' && repositories.at(-1)?.groups.length > 0) {
			repositories.at(-1).groups.at(-1).resources.push(row.name);
		}
	}
	return { repositories, rows: allRows };
}

/** The changed paths on screen, in a stable order — the working set, as the view draws it. */
const scmResourceNames = state => state.rows.filter(row => row.kind === 'resource').map(row => row.name).sort();

/**
 * The source control view's working set, waited until it is exactly `expected`.
 *
 * **No scroll sweep, unlike `scmSnapshot`.** This is for a window holding a single repository,
 * which draws no repository rows and puts its whole working set on screen at once; a caller with
 * several repositories wants the stitched reading rather than this one.
 *
 * The wait is `waitForRead` rather than a settled read, and that is the point of the probe: the
 * refresh it is waiting on sits behind a timer, and `settled.mjs` says in as many words that the
 * settle question does not cover one — the app is genuinely idle while the window is armed and
 * would report so, which `GRACE` would then turn into a failure on a view that was about to be
 * right. The bound is the caller's, because what a correction should take is the caller's claim.
 *
 * @returns {Promise<string[]>} the names, sorted
 */
export async function scmResources(page, expected, { timeoutMs = READ_TIMEOUT } = {}) {
	await openView(page, 'scm');
	await setGraphPane(page, false);

	const wanted = JSON.stringify([...expected].sort());
	const state = await waitForRead(page, {
		read: readScmState,
		holds: value => value.present && JSON.stringify(scmResourceNames(value)) === wanted,
		what: `the source control view never listed exactly ${wanted}`,
		timeoutMs
	});

	return scmResourceNames(state);
}

/**
 * Expand or collapse the Graph pane. Every source control probe sets it, because the two
 * panes share one container's height and every list in it is virtualised — an expanded Graph
 * scrolls the last repository out of the Source Control pane above it, which reads as a
 * missing repository rather than as a hidden row.
 */
async function setGraphPane(page, expanded) {
	const state = await page.evaluate(() => {
		const header = [...document.querySelectorAll('.pane-header')]
			.find(candidate => candidate.querySelector('.title')?.textContent.trim() === 'Graph');
		return header ? header.getAttribute('aria-expanded') === 'true' : 'missing';
	});
	if (state === 'missing') {
		throw new Error('the source control container has no Graph pane');
	}
	if (state !== expanded) {
		await page.locator('.pane-header:has(.title:text-is("Graph"))').click();
	}
}

/**
 * Selects a repository in the source control list, which is what makes it the active one
 * the Graph pane follows.
 *
 * The list is virtualised and taller than the pane, so a repository that is merely scrolled
 * out of view is not in the DOM at all — looking only at what is rendered reads that as a
 * repository that was never registered. The walk is `sweepScmRows`', stopped at the row it
 * came for.
 */
async function clickScmRepository(page, name) {
	const ROWS = '.scm-view:not(.scm-history-view) .monaco-list-row';
	const findRendered = target => [...document.querySelectorAll('.scm-view:not(.scm-history-view) .monaco-list-row')]
		.findIndex(row => row.querySelector('.scm-provider .label-name')?.textContent.trim() === target);

	await resetScmScroll(page);

	for (let step = 0; step < SCM_SCROLL_STEPS; step++) {
		const index = await page.evaluate(findRendered, name);
		if (index >= 0) {
			await page.locator(ROWS).nth(index).click();
			return;
		}
		if (!await wheelScmList(page, 200)) {
			break;
		}
	}

	const rows = await sweepScmRows(page);
	throw new Error(`the source control view lists no repository named ${JSON.stringify(name)}; it lists ${JSON.stringify(rows.filter(row => row.kind === 'repository').map(row => row.name))}`);
}

const readScmGraphState = () => {
	const view = document.querySelector('.scm-view.scm-history-view');
	if (!view || view.getBoundingClientRect().height === 0) {
		return { present: false, rows: [] };
	}
	const rows = [...view.querySelectorAll('.monaco-list-row .history-item')].map(item => ({
		subject: item.querySelector('.label-name')?.textContent.trim() ?? '',
		author: item.querySelector('.label-description')?.textContent.trim() ?? '',
		// The swimlanes are drawn per row; a row without one is a row the graph never laid out.
		graph: !!item.querySelector('.graph-container svg')
	}));
	return { present: true, rows };
};

/**
 * The Graph pane's commit rows for one repository. The pane is a second view in the source
 * control container, so it has to be expanded, and it follows the *active* repository —
 * which is what selecting a repository row in the Source Control view above it sets.
 */
export async function scmGraphSnapshot(page, { repository } = {}) {
	await openView(page, 'scm');

	if (repository) {
		await clickScmRepository(page, repository);
	}

	await setGraphPane(page, true);

	const state = await settle(page, {
		read: readScmGraphState,
		terminal: value => value.present && value.rows.length > 0,
		what: `source control graph${repository ? ` for ${repository}` : ''}`
	});
	return state.rows;
}

/**
 * The graph's repository picker, and whether it fits the header it is drawn in.
 *
 * It is a **labelled** toolbar action, and `WorkbenchToolBar` resolves a chord for every action it
 * builds — so once `keymap.ts` gave `workbench.scm.action.graph.pickRepository` a chord,
 * `ActionViewItem.render` drew a second line under the label and the item grew past the 22 px
 * header, which `align-items: center` then clipped from the top. `keybindings` is the count of
 * those lines and the two clips are what the user actually saw.
 */
const readScmGraphPicker = () => {
	const item = document.querySelector('.scm-graph-repository-picker')?.closest('.action-item');
	const header = item?.closest('.pane-header');
	if (!item || !header) {
		return { present: false, keybindings: 0, clippedAbove: 0, clippedBelow: 0 };
	}

	const box = item.getBoundingClientRect();
	const headerBox = header.getBoundingClientRect();

	return {
		present: true,
		keybindings: item.querySelectorAll('.keybinding').length,
		clippedAbove: Math.round(headerBox.top - box.top),
		clippedBelow: Math.round(box.bottom - headerBox.bottom)
	};
};

/** The picker once the graph pane has drawn one — which upstream only does past one repository. */
export async function scmGraphRepositoryPicker(page) {
	return settle(page, { read: readScmGraphPicker, terminal: state => state.present, what: 'the graph\'s repository picker' });
}

/**
 * The Sapling smartlog as the DOM holds it.
 *
 * Three states are separated rather than collapsed: `rows` is the graph, `welcome` is what
 * the pane shows when discovery found no Sapling repository, and `message` is a failure the
 * view could not draw around. An empty `rows` with neither of the other two is a fact —
 * a repository whose smartlog is empty — not a view that never answered.
 */
const readSaplingState = () => {
	const view = document.querySelector('.sapling-smartlog');
	if (!view) {
		return { present: false, message: '', welcome: '', rows: [] };
	}
	// The graph's classes are ISL's own, because the stylesheets behind them are copied from
	// ISL rather than written here. Nothing virtualises the rows, so `.render-dag-row-group`
	// is every row in document order. One of them is not a commit: the virtual working copy
	// that carries the "You are here" label, which `.you-are-here-container` is what names.
	const rows = [...view.querySelectorAll('.render-dag-row-group')].filter(row => !row.querySelector('.you-are-here-container')).map(row => {
		// Every line the row drew, as its tile count. The renderer appends the pad, node and
		// pad lines of the commit row first, so `lines[1]` is the node line — one tile per
		// swimlane — and anything after the third is a link, term or ancestry row.
		const lines = [...row.querySelectorAll('.render-dag-row-left-side-line')].map(line => line.querySelectorAll('svg.render-dag-tile').length);
		return {
			hash: row.querySelector('[data-commit-hash]')?.getAttribute('data-commit-hash') ?? '',
			title: row.querySelector('.commit-title')?.textContent.trim() ?? '',
			date: row.querySelector('.commit-date')?.textContent.trim() ?? '',
			// `head-commit` is the class `Commit.tsx` puts on `.` and on nothing else.
			isDot: !!row.querySelector('.commit.head-commit'),
			bookmarks: [...row.querySelectorAll('.tag')].map(bookmark => bookmark.textContent.trim()),
			// `commit-row-selected` is what `CommitTreeList.tsx` puts on the clicked row.
			selected: !!row.querySelector('.render-dag-row-commit.commit-row-selected'),
			// The obsolescence sentence, which is the only thing this port puts on the second row.
			secondRow: row.querySelector('.commit-second-row')?.textContent.trim() ?? '',
			lines,
			columns: lines.length > 1 ? lines[1] : 0
		};
	});
	return {
		present: true,
		message: view.querySelector('.sapling-message:not(.sapling-hidden)')?.textContent.trim() ?? '',
		welcome: view.querySelector('.welcome-view-content')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
		rows
	};
};

/**
 * The smartlog once the view has answered — with a graph, with its welcome content, or with
 * a message. A view that never reaches one of the three throws naming what it last saw.
 *
 * @returns {Promise<{ message: string, welcome: string, rows: object[] }>}
 */
export async function saplingSnapshot(page) {
	await openView(page, 'sapling');
	return settle(page, {
		read: readSaplingState,
		terminal: state => state.present && (state.rows.length > 0 || state.welcome !== '' || state.message !== ''),
		what: 'the Sapling smartlog'
	});
}

const readSaplingCommitInfoState = () => {
	const view = document.querySelector('.commit-info-view');
	if (!view) {
		return { present: false, title: '', byline: '', description: '', count: '', files: [] };
	}
	return {
		present: true,
		title: view.querySelector('.commit-info-rendered-title')?.textContent.trim() ?? '',
		byline: view.querySelector('.commit-info-title-byline')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
		description: view.querySelector('.commit-info-rendered-textarea')?.textContent.trim()
			?? view.querySelector('.empty-description')?.textContent.trim() ?? '',
		// The badge beside "Files Changed", which is `totalFileCount` off the smartlog fetch.
		count: view.querySelector('.sapling-badge')?.textContent.trim() ?? '',
		files: [...view.querySelectorAll('.changed-file')].map(file => ({
			path: file.querySelector('.changed-file-path-text')?.textContent.trim() ?? '',
			// `file-added` / `file-modified` / `file-removed`, which is the status the second
			// read resolved — the paint before it lands calls everything modified.
			status: [...file.classList].find(name => name.startsWith('file-')) ?? ''
		}))
	};
};

/**
 * The commit-info view below the graph, once it has drawn a commit.
 *
 * It is a second pane in the same container, so the graph has to be open first — and it draws
 * "." by default, which means "settled" is a title rather than an empty state.
 *
 * @returns {Promise<{ title: string, byline: string, description: string, count: string, files: object[] }>}
 */
export async function saplingCommitInfo(page) {
	await saplingSnapshot(page);
	return settle(page, {
		read: readSaplingCommitInfoState,
		terminal: state => state.present && state.title !== '',
		what: 'the Sapling commit-info view'
	});
}

/** Clicks a commit row by title and reports the smartlog once the selection has moved. */
export async function saplingSelectCommit(page, title) {
	await saplingSnapshot(page);
	const clicked = await page.evaluate(wanted => {
		const row = [...document.querySelectorAll('.sapling-smartlog .render-dag-row-commit')]
			.find(candidate => candidate.querySelector('.commit-title')?.textContent.trim() === wanted);
		row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return !!row;
	}, title);
	if (!clicked) {
		throw new Error(`the smartlog draws no row titled ${JSON.stringify(title)}`);
	}

	return settle(page, {
		read: readSaplingState,
		terminal: state => state.rows.some(row => row.selected && row.title === title),
		what: `the smartlog selecting ${title}`
	});
}

/**
 * Opens the view's repository picker and reports what it offers, optionally picking one.
 *
 * The picker is a quick input, so it is read through the same widget the quick open probes
 * read — what is Sapling's about it is only which action opened it.
 *
 * @returns {Promise<{ picks: object[], snapshot: object | undefined }>}
 */
export async function saplingPickRepository(page, name) {
	// The picker offers what discovery found, and discovery only starts when the pane is
	// first shown — so a click made before the view has answered opens an empty list.
	await saplingSnapshot(page);
	await closeQuickOpen(page);
	// The view keeps its own pane header rather than merging into the container's, so its title
	// actions live in that header — and a pane header only shows them while it is hovered.
	await page.hover('.part.sidebar .pane-header');
	await page.click('.part.sidebar .action-label.codicon-repo');

	const state = await settle(page, {
		read: readQuickOpenState,
		terminal: value => value.present && !value.busy && value.picks.length > 0,
		what: 'the Sapling repository picker'
	});

	if (name === undefined) {
		await closeQuickOpen(page);
		return { picks: state.picks, snapshot: undefined };
	}

	const index = state.picks.findIndex(pick => pick.label === name);
	if (index < 0) {
		throw new Error(`the repository picker offers no ${JSON.stringify(name)}; it offers ${JSON.stringify(state.picks.map(pick => pick.label))}`);
	}
	await page.locator('.quick-input-widget:visible .quick-input-list .monaco-list-row').nth(index).click();
	await waitForQuickOpen(page, false, `the repository picker stayed open after picking ${name}`);

	return { picks: state.picks, snapshot: await saplingSnapshot(page) };
}

/**
 * The repository the Source Control status bar entry names — `status.scm.provider` in
 * `scm/browser/activity.ts`, which draws `ISCMViewService.activeRepository` and is the bottom-left
 * item every other Source Control selector agrees with.
 *
 * The entry's id is its element id (`statusbarPart.ts` builds `$('.statusbar-item', { id })`), so
 * this reads the one item rather than the whole bar.
 */
export async function scmStatusRepository(page) {
	return settle(page, {
		read: () => document.querySelector('.statusbar-item#status\\.scm\\.provider')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
		terminal: value => value !== '',
		what: 'the source control status bar entry'
	});
}

/** Clicks the first match row of a settled search and reports where it landed. */
export async function openFirstMatch(page) {
	const index = await page.evaluate(pattern => [...document.querySelectorAll('.search-view .monaco-list-row')]
		.findIndex(row => new RegExp(pattern).test(row.getAttribute('aria-label') ?? '')), MATCH_ROW.source);
	if (index < 0) {
		throw new Error('the search view holds no match rows to open');
	}
	await page.locator('.search-view .monaco-list-row').nth(index).click();
	await waitForElement(page, '.editor-instance .view-line', { what: 'no editor drew a line after the first search match was clicked' });
	return editorPosition(page);
}

const readActiveEditorTab = () => {
	const group = document.querySelector('.editor-group-container.active') ?? document;
	return group.querySelector('.tabs-container .tab.active .label-name')?.textContent.trim()
		?? group.querySelector('.tabs-container .tab .label-name')?.textContent.trim()
		?? '';
};

/**
 * The editor the active group's tab list shows as active — the first tab where none is yet, so a
 * group with one editor answers with it rather than with nothing.
 *
 * **The group is part of the question.** `editorGroupView.ts:987` puts `active` on the group
 * container, and by the time a run has opened a preview beside a document there are two of them —
 * so an unscoped `.tabs-container .tab.active` reads whichever group is drawn first, which is not
 * the one the keyboard is cycling.
 *
 * On its own rather than folded into `editorPosition`, because the cycling keys are read with the
 * keyboard somewhere the status bar reports no cursor at all.
 */
export async function activeEditorTab(page) {
	return page.evaluate(readActiveEditorTab);
}

/**
 * The cursor position as the status bar reports it, plus the active tab. Opening
 * a search match selects it, which leaves the cursor at the end of the match —
 * `startColumn` is where the match itself begins.
 */
export async function editorPosition(page) {
	await waitForRead(page, {
		read: () => document.querySelector('.statusbar')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
		holds: status => /Ln \d+, Col \d+/.test(status),
		what: 'the status bar never reported a cursor position'
	});
	const position = await page.evaluate(() => {
		const status = document.querySelector('.statusbar').innerText;
		const cursor = /Ln (\d+), Col (\d+)/.exec(status);
		const selected = /\(([\d,]+) selected\)/.exec(status);
		const column = Number(cursor[2]);
		const selectedLength = selected ? Number(selected[1].replace(/,/g, '')) : 0;
		return { line: Number(cursor[1]), column, selected: selectedLength, startColumn: column - selectedLength };
	});

	return { ...position, tab: await activeEditorTab(page) };
}

// The terminal is a `TerminalViewPane` in the panel, so its title actions are the
// panel's: `+`, split and kill. The icon is what names each, exactly as it does in
// the activity bar above.
const terminalTitleAction = icon => `.part.panel .title-actions .action-item .action-label.codicon-${icon}`;

const TERMINAL_NEW = 'plus';
const TERMINAL_SPLIT = 'split-horizontal';
const TERMINAL_KILL = 'trash';
/** The chevron beside `+`, which upstream labels "Launch Profile...". */
const TERMINAL_LAUNCH_PROFILE = 'chevron-down';
/** How many clicks the dropdown gets before a closed menu is reported as one. */
const MENU_ATTEMPTS = 3;

/**
 * The terminal view as the DOM holds it: its groups, the panes inside each, and
 * the tab list — which upstream shows only once there is more than one terminal.
 *
 * xterm renders to a canvas under the WebGL renderer and to `.xterm-rows` under
 * the DOM one, so `rendered` is what tells "this terminal has no buffer on screen"
 * apart from "this terminal's buffer is empty".
 */
const readTerminalState = () => {
	const view = document.querySelector('.pane-body.integrated-terminal');
	if (!view) {
		return { present: false, groups: [], tabs: [] };
	}
	/**
	 * One pane's rows, joined back into the lines a shell wrote.
	 *
	 * `.xterm-rows` holds one element per screen *row*, so a line longer than the pane
	 * is several of them — and a split pane is half as wide, narrow enough that the
	 * prompt alone outruns it. The buffer's own `isWrapped` is not in the DOM and the
	 * xterm instance is not reachable from the page, so what says a row was carried on
	 * below is that it reached the last column — the renderer draws a row only as far
	 * as its last written cell. The column count is xterm's own: the screen is exactly
	 * `cols` cells wide, and a rendered run advances one cell per character.
	 */
	const linesOf = (screen, rows) => {
		// The DOM renderer pads a row out with non-breaking spaces, which are not what
		// a shell wrote.
		const drawn = [...rows.children].map(row => row.textContent.replaceAll('\u00a0', ' ').trimEnd());
		const run = [...rows.querySelectorAll('span')].find(span => span.textContent.length > 0);
		const cell = run ? run.getBoundingClientRect().width / run.textContent.length : 0;
		// Nothing is drawn yet, so nothing can be known to have wrapped.
		const cols = cell > 0 ? Math.round(screen.getBoundingClientRect().width / cell) : Infinity;
		const lines = [];
		let continued = false;
		for (const row of drawn) {
			if (continued) {
				lines[lines.length - 1] += row;
			} else {
				lines.push(row);
			}
			continued = row.length >= cols;
		}
		return lines;
	};
	const groups = [...view.querySelectorAll('.terminal-group')].map(group => ({
		visible: group.style.display !== 'none',
		panes: [...group.querySelectorAll('.terminal-wrapper')].map(wrapper => {
			// The sticky scroll overlay is a second xterm inside the pane's own wrapper —
			// see `focusTerminal` — so everything read here excludes what belongs to it.
			const own = selector => [...wrapper.querySelectorAll(selector)].filter(element => !element.closest('.terminal-sticky-scroll'));
			const rows = own('.xterm-rows')[0];
			const screen = own('.xterm-screen')[0];
			return {
				rendered: !!rows,
				lines: rows && screen ? linesOf(screen, rows) : [],
				decorations: own('.terminal-command-decoration').map(mark => mark.className)
			};
		})
	}));
	const tabs = [...view.querySelectorAll('.tabs-list .monaco-list-row')].map(row => ({
		label: row.innerText.replace(/\s+/g, ' ').trim(),
		active: !!row.querySelector('.terminal-tabs-entry.is-active')
	}));
	return { present: true, groups, tabs };
};

/** Every pane of the group on screen; the others are hidden and stop rendering. */
const visiblePanes = state => state.groups.filter(group => group.visible).flatMap(group => group.panes);

const paneCount = state => state.groups.reduce((total, group) => total + group.panes.length, 0);

const terminalIsReady = state => state.present && visiblePanes(state).length > 0 && visiblePanes(state).every(pane => pane.rendered);

/**
 * The terminal view once it holds a terminal that has rendered a buffer. A view
 * that never appears and a terminal whose xterm never attached both throw naming
 * what was seen; an empty buffer is returned as a fact.
 *
 * @returns {Promise<{ groups: object[], tabs: object[], panes: object[] }>}
 */
export async function terminalSnapshot(page) {
	const state = await settle(page, { read: readTerminalState, terminal: terminalIsReady, quietMs: QUIET, what: 'the terminal view' });
	return { ...state, panes: visiblePanes(state) };
}

/**
 * ``Ctrl+` `` — the panel away, or back. Upstream's own chord for
 * `workbench.action.terminal.toggleTerminal`, which is the gesture that went missing when the
 * takeover dropped every rule the keymap had not declared.
 *
 * `present` is the whole reading: the panel takes its view's body with it, so the terminal is
 * either in the DOM or it is not. Coming back, the wait is for the buffer to have rendered again,
 * which is what says the same terminal is still there rather than a view with nothing in it.
 *
 * @returns {Promise<{ present: boolean, groups: object[], tabs: object[], panes: object[] }>}
 */
export async function toggleTerminalPanel(page, { expect }) {
	await page.keyboard.press('Control+Backquote');
	const state = await settle(page, {
		read: readTerminalState,
		terminal: value => expect === 'gone' ? !value.present : terminalIsReady(value),
		quietMs: QUIET,
		what: `the terminal panel to be ${expect} after Ctrl+\``
	});
	return { ...state, panes: visiblePanes(state) };
}

/**
 * Clicks one of the view's title actions and waits for the view to answer with the
 * shape the click was for, so a click that lands on nothing fails as itself rather
 * than as some later assertion.
 */
async function clickTerminalTitleAction(page, icon, terminal, what) {
	await page.click(terminalTitleAction(icon));
	const state = await settle(page, { read: readTerminalState, terminal, quietMs: QUIET, what });
	return { ...state, panes: visiblePanes(state) };
}

/** The `+` action: a terminal of its own, in a group of its own. */
export async function newTerminal(page) {
	const before = paneCount(await page.evaluate(readTerminalState));
	return clickTerminalTitleAction(
		page, TERMINAL_NEW,
		state => terminalIsReady(state) && paneCount(state) === before + 1,
		`the + action to take the terminal count from ${before} to ${before + 1}`
	);
}

/** The split action: a second pane beside the active terminal, in its group. */
export async function splitTerminal(page) {
	const before = await page.evaluate(readTerminalState);
	const groups = before.groups.length;
	return clickTerminalTitleAction(
		page, TERMINAL_SPLIT,
		state => terminalIsReady(state) && paneCount(state) === paneCount(before) + 1 && state.groups.length === groups,
		`the split action to add a pane to one of the ${groups} groups`
	);
}

/**
 * The dropdown the chevron opens, which the context view renders into a shadow root of its
 * own — so the read pierces every one it finds rather than querying the document alone.
 * Separators carry no label and are dropped; `expanded` is the trigger's own account of
 * whether the menu is up, so a menu that never opened is told apart from one that is empty.
 */
const readTerminalMenu = trigger => {
	const labels = [];
	const walk = root => {
		for (const item of root.querySelectorAll('.monaco-menu .action-item')) {
			labels.push(item.querySelector('.action-label')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
		}
		for (const element of root.querySelectorAll('*')) {
			if (element.shadowRoot) {
				walk(element.shadowRoot);
			}
		}
	};
	walk(document);
	return { expanded: document.querySelector(trigger)?.getAttribute('aria-expanded') === 'true', actions: labels.filter(Boolean) };
};

/**
 * What the "Launch Profile..." dropdown offers, as its entries read.
 *
 * Upstream builds the menu from `availableProfiles`, and a profile only reaches that list
 * once detection found an executable behind its configured path — so a name missing here is
 * a fact about the profile rather than about the menu.
 *
 * @returns {Promise<string[]>}
 */
export async function terminalProfileMenu(page) {
	const trigger = terminalTitleAction(TERMINAL_LAUNCH_PROFILE);
	// The `+` item is rebuilt every time the profile list changes, so a click made while
	// detection is still answering lands on a node that is on its way out and opens nothing.
	// Each attempt is a fresh click, and the last one carries the failure.
	for (let attempt = MENU_ATTEMPTS; attempt > 0; attempt--) {
		await page.click(trigger);
		try {
			const menu = await settle(page, {
				read: readTerminalMenu,
				readArg: trigger,
				terminal: state => state.expanded && state.actions.length > 0,
				timeoutMs: attempt === 1 ? READ_TIMEOUT : 5_000,
				what: 'the launch profile dropdown'
			});
			await page.keyboard.press('Escape');
			return menu.actions;
		} catch (error) {
			if (attempt === 1) {
				throw error;
			}
		}
	}
}

/** The kill action: the active terminal goes away. */
export async function killTerminal(page) {
	const before = paneCount(await page.evaluate(readTerminalState));
	return clickTerminalTitleAction(
		page, TERMINAL_KILL,
		state => state.present && paneCount(state) === before - 1,
		`the kill action to take the terminal count from ${before} to ${before - 1}`
	);
}

/**
 * Focuses one of the visible panes, so what is typed next reaches its shell.
 *
 * The textarea rather than the canvas: it is the element xterm actually reads
 * keystrokes from, and clicking the terminal would also place a cursor and start
 * a selection.
 *
 * A pane is addressed by its wrapper and only then by the textarea inside it, because
 * a pane holds more than one xterm: `terminalStickyScrollOverlay` builds a second one
 * inside the same wrapper as soon as a command scrolls out of view, and it has a helper
 * textarea of its own that no shell is behind. Counting textareas across the group puts
 * that one at an index a pane was meant to be at, and everything typed afterwards is
 * silently swallowed.
 */
export async function focusTerminal(page, pane = 0) {
	const result = await page.evaluate(index => {
		const wrappers = [...document.querySelectorAll('.pane-body.integrated-terminal .terminal-group:not([style*="display: none"]) .terminal-wrapper')];
		const textarea = [...wrappers[index]?.querySelectorAll('.xterm-helper-textarea') ?? []].find(candidate => !candidate.closest('.terminal-sticky-scroll'));
		textarea?.focus();
		return { panes: wrappers.length, focused: !!textarea && document.activeElement === textarea };
	}, pane);
	if (!result.focused) {
		throw new Error(`could not focus terminal pane ${pane} of the ${result.panes} on screen`);
	}
}

/**
 * Types one command into a pane and waits for its shell to answer.
 *
 * The keystrokes travel to the shell and come back as an echo, so the wait is in
 * two parts: first for the echo, which is what proves the command is in front of
 * the shell rather than still in flight, and only then for the change that
 * Enter — rather than the typing — produced.
 */
export async function runTerminalCommand(page, command, { pane = 0 } = {}) {
	await focusTerminal(page, pane);
	await page.keyboard.type(command);
	const typed = await settle(page, {
		read: readTerminalState,
		terminal: state => terminalIsReady(state) && visiblePanes(state).some(candidate => candidate.lines.some(line => line.includes(command))),
		quietMs: QUIET,
		what: `the shell to echo ${JSON.stringify(command)}`
	});
	const echoed = JSON.stringify(typed.groups);
	await page.keyboard.press('Enter');
	// `quietMs` here as well as above, and for the same reason the echo needed it: what is being
	// waited for is a *shell* painting, which is the one thing the settle question does not cover.
	// Without it the first repaint after Enter satisfied "the buffer moved" — Enter alone moves it,
	// by dropping the cursor to a new line — and the reading came back one paint before the output,
	// which every assertion then read as a command that never ran.
	const state = await settle(page, {
		read: readTerminalState,
		terminal: value => terminalIsReady(value) && JSON.stringify(value.groups) !== echoed,
		quietMs: QUIET,
		what: `the shell to answer ${JSON.stringify(command)}`
	});
	return { ...state, panes: visiblePanes(state) };
}

/**
 * What xterm has drawn of a selection, where its viewport is scrolled to, and where on screen a
 * named buffer row is — the three readings the clipboard and page keys move or need.
 *
 * `selected` counts the rectangles in the selection layer rather than asking for the text: the
 * selection is the emulator's own state and that layer is the whole of what the DOM says about it,
 * so a copy that cleared it reads as zero and one that did not reads as what it left behind.
 *
 * One reader for all three, because each has to address the same pane the same way — the visible
 * group's wrapper, and never the sticky-scroll overlay's second xterm inside it (`focusTerminal`).
 */
const readTerminalGeometry = ([needle, pane]) => {
	const wrappers = [...document.querySelectorAll('.pane-body.integrated-terminal .terminal-group:not([style*="display: none"]) .terminal-wrapper')];
	const own = selector => [...wrappers[pane]?.querySelectorAll(selector) ?? []].find(element => !element.closest('.terminal-sticky-scroll'));
	const viewport = own('.xterm-viewport');
	const selection = own('.xterm-selection');
	// The DOM renderer pads a row out with non-breaking spaces, as `linesOf` says of the same rows.
	const rows = needle === undefined ? [] : [...own('.xterm-rows')?.children ?? []];
	const rect = rows.find(row => row.textContent.replaceAll(' ', ' ').trim() === needle)?.getBoundingClientRect();

	return {
		selected: selection ? selection.children.length : 0,
		scrollTop: viewport ? Math.round(viewport.scrollTop) : 0,
		scrollable: viewport ? Math.round(viewport.scrollHeight - viewport.clientHeight) : 0,
		row: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined
	};
};

/** A pane's selection and scroll state, once it has stopped moving. */
export async function terminalGeometry(page, holds = () => true, { pane = 0, what = 'the terminal' } = {}) {
	return settle(page, { read: readTerminalGeometry, readArg: [undefined, pane], terminal: holds, quietMs: QUIET, what });
}

/**
 * Drags across the one buffer row whose whole content is `text`, which is what a user does to make
 * a selection for `Ctrl+C` to take.
 *
 * The row rather than a range inside it: xterm drops a row's trailing padding from the selection, so
 * a drag from edge to edge selects exactly what the shell wrote there — and the `echo <needle>`
 * lines the suite runs put the needle on a row of its own.
 */
export async function selectTerminalLine(page, text, { pane = 0 } = {}) {
	await focusTerminal(page, pane);
	const { row } = await page.evaluate(readTerminalGeometry, [text, pane]);
	if (!row) {
		throw new Error(`no terminal row reads ${JSON.stringify(text)}, so there is nothing to select`);
	}

	const middle = row.y + row.height / 2;
	await page.mouse.move(row.x + 1, middle);
	await page.mouse.down();
	await page.mouse.move(row.x + row.width - 1, middle, { steps: 8 });
	await page.mouse.up();

	return terminalGeometry(page, state => state.selected > 0, { pane, what: `the drag across ${JSON.stringify(text)} to select something` });
}

/** The find input of whichever find widget is on screen. */
const TERMINAL_FIND_INPUT = '.pane-body.integrated-terminal .simple-find-part.visible .monaco-findInput input';

/** `SimpleFindWidget`'s own match label — `NLS_MATCHES_LOCATION` and `NLS_NO_RESULTS`. */
const FIND_MATCHES = /^(\d+) of (\d+)(\+?)$/;
const FIND_NO_RESULTS = 'No results';

/**
 * The find widget over the terminal buffer, as the DOM holds it.
 *
 * `label` is the widget's own `matchesCount`, which `SimpleFindWidget` fills from
 * `IXtermTerminal.findResult` — whatever `@xterm/addon-search` last reported through
 * `onDidChangeResults`. So a count read here is the search addon's answer about the
 * buffer, not the widget's account of having been opened.
 *
 * `decorations` are that same addon's highlights over the buffer, as their class names:
 * it marks every one it draws with `xterm-find-result-decoration`, and registers the
 * match it stepped to in xterm's top decoration layer on top of them. A match cut across
 * two screen rows is drawn as one decoration per row, so there is at least one highlight
 * per match rather than exactly one.
 */
const readTerminalFindState = () => {
	const view = document.querySelector('.pane-body.integrated-terminal');
	const widget = view && [...view.querySelectorAll('.simple-find-part')].find(part => part.classList.contains('visible'));
	if (!widget) {
		return { visible: false, term: '', label: '', decorations: [] };
	}
	// The pane's own xterm, not the sticky scroll overlay's — see `focusTerminal`.
	const wrapper = view.querySelector('.terminal-group:not([style*="display: none"]) .terminal-wrapper');
	const screen = [...wrapper?.querySelectorAll('.xterm-screen') ?? []].find(element => !element.closest('.terminal-sticky-scroll'));
	return {
		visible: true,
		term: widget.querySelector('.monaco-findInput input')?.value ?? '',
		label: widget.querySelector('.matchesCount')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
		decorations: screen ? [...screen.querySelectorAll('.xterm-decoration')].map(mark => mark.className) : []
	};
};

/** A widget showing the term it was given, and an answer about it. */
const findIsTerminal = term => state => state.visible && state.term === term && (state.label === FIND_NO_RESULTS || FIND_MATCHES.test(state.label));

/**
 * The label as its two numbers. `No results` is a count of zero — a fact — and a label
 * in neither shape leaves both undefined rather than passing for one.
 */
function parseFindLabel(label) {
	if (label === FIND_NO_RESULTS) {
		return { index: 0, count: 0 };
	}
	const match = FIND_MATCHES.exec(label);
	return match ? { index: Number(match[1]), count: Number(match[2]) } : { index: undefined, count: undefined };
}

const findState = state => ({
	...state,
	...parseFindLabel(state.label),
	highlights: state.decorations.filter(className => className.includes('xterm-find-result-decoration')).length,
	// The active match is the one the addon puts in the top layer. Its own
	// `xterm-find-active-result-decoration` class is never applied — the addon passes a
	// literal `false` for it — so the layer is what names it.
	active: state.decorations.filter(className => className.includes('xterm-find-result-decoration') && className.includes('xterm-decoration-top-layer')).length
});

/**
 * Opens the find widget over a pane and searches for `term`.
 *
 * Through upstream's own `Ctrl+F`, which is the gesture the user has: the chord is a row of
 * `keymap.ts` so the takeover keeps upstream's rule, and `commandsToSkipShell` is what stops xterm
 * handing the key to the shell first. The pane is focused before the press, because
 * `registerActiveXtermAction` runs the action against the *active* instance — which pane that is,
 * is what this probe is asked about. A widget that never appeared throws as itself rather than as
 * a search with no answer.
 *
 * @returns {Promise<{ visible: boolean, term: string, label: string, index: number, count: number, highlights: number, active: number, decorations: string[] }>}
 */
export async function terminalFind(page, term, { pane = 0 } = {}) {
	await focusTerminal(page, pane);
	await page.keyboard.press('Control+f');
	await settle(page, {
		read: readTerminalFindState,
		terminal: state => state.visible,
		what: 'the terminal find widget to open on Ctrl+F'
	});
	await setInputValue(page, TERMINAL_FIND_INPUT, term);
	const state = await settle(page, {
		read: readTerminalFindState,
		terminal: findIsTerminal(term),
		quietMs: QUIET,
		what: `the find widget to answer ${JSON.stringify(term)}`
	});
	return findState(state);
}

/**
 * Steps to the next or previous match.
 *
 * `F3` and `Shift+F3` are the primaries of upstream's own rules, and they are pressed from the find
 * input the search was typed into — where `terminalFindFocused` holds, which is the half of that
 * rule's guard the widget answers. Upstream's *second* rule, `Enter`/`Shift+Enter` in the box, is
 * kept by the same keep-set entry: it names the command, so a command's every rule travels with it.
 *
 * The wait is for the label to move off the one the step started from, so a reading can
 * never be the state before the step — which of the matches it moved to is the caller's
 * assertion.
 */
export async function terminalFindStep(page, direction) {
	const before = await page.evaluate(readTerminalFindState);
	await page.keyboard.press(direction === 'next' ? 'F3' : 'Shift+F3');
	const state = await settle(page, {
		read: readTerminalFindState,
		terminal: value => findIsTerminal(before.term)(value) && value.label !== before.label,
		quietMs: QUIET,
		what: `the find widget to step ${direction} off ${JSON.stringify(before.label)}`
	});
	return findState(state);
}

/**
 * `Escape` in the find box, and the widget goes away.
 *
 * This is the half `workbench.action.terminal.hideFind` does *not* answer — its rule wants
 * `terminalFocusInAny`, and a focused find input has blurred the xterm. Upstream closes it from
 * `simpleFindWidget.ts`'s **keyup** instead, which only ever arrives if no keydown rule moved the
 * focus off the widget first. `tscode.stopEditingInput` was that rule until it was guarded out of
 * the terminal, so this step is the assertion on that guard.
 */
export async function terminalFindClose(page) {
	await page.keyboard.press('Escape');
	const state = await settle(page, {
		read: readTerminalFindState,
		terminal: value => !value.visible,
		what: 'the find widget to close on Escape'
	});
	return findState(state);
}

/**
 * Monaco's own find widget over the active editor, which is the only way this port has of searching
 * a file: `/` belongs to the vim engine and the viewer has no engine attached.
 *
 * The *active group's* widget, because every editor the run has opened builds one of its own and a
 * document-wide query answers for whichever was built first. `label` is `findWidget.ts`'s own
 * `matchesCount`, filled from the find model's match count — so a reading here is what the search
 * found and not that a widget opened.
 */
const readEditorFind = () => {
	const widget = document.querySelector('.editor-group-container.active .editor-widget.find-widget.visible');
	if (!widget) {
		return { visible: false, term: '', label: '' };
	}

	return {
		visible: true,
		// A **textarea**, not an input: `findWidget.ts` builds its `FindInput` with `flexibleHeight`,
		// which is what `InputBox` draws one for. The replace input is a second `.monaco-findInput`
		// in the same widget and is built after this one, so document order tells them apart.
		term: widget.querySelector('.monaco-findInput textarea, .monaco-findInput input')?.value ?? '',
		label: widget.querySelector('.matchesCount')?.textContent.replace(/\s+/g, ' ').trim() ?? ''
	};
};

/** The find widget's answer, read through the same label grammar the terminal's widget uses. */
const editorFindState = state => ({ ...state, ...parseFindLabel(state.label) });

/**
 * `Ctrl+F` over the active editor, and the search it answers with.
 *
 * The chord rather than the palette, because the chord is the whole of what is under test: upstream
 * registers `actions.find` on it and the takeover had dropped the rule, so what a user pressed did
 * nothing at all in a pane where nothing else searches.
 */
export async function editorFind(page, term) {
	await page.keyboard.press('Control+f');
	await settle(page, { read: readEditorFind, terminal: state => state.visible, what: 'the editor find widget to open on Ctrl+F' });
	// Typed rather than clicked into: `StartFindAction` leaves the box with the keyboard, so a click
	// would only be a second way to reach a caret that is already there.
	await page.keyboard.press('Control+a');
	await page.keyboard.type(term);
	const state = await settle(page, {
		read: readEditorFind,
		terminal: value => value.visible && value.term === term && (value.label === FIND_NO_RESULTS || FIND_MATCHES.test(value.label)),
		what: `the editor find widget to answer ${JSON.stringify(term)}`
	});

	return editorFindState(state);
}

/** `Enter` in the find box, which is upstream's second rule for `editor.action.nextMatchFindAction`. */
export async function editorFindStep(page) {
	const before = await page.evaluate(readEditorFind);
	await page.keyboard.press('Enter');
	const state = await settle(page, {
		read: readEditorFind,
		terminal: value => value.visible && value.label !== before.label,
		what: `the editor find widget to step off ${JSON.stringify(before.label)}`
	});

	return editorFindState(state);
}

/**
 * `Escape` over an open find widget, which is `closeFindWidget`'s.
 *
 * It is upstream's rule that has to answer it and not `tscode.stopEditingInput`, which is registered
 * *above* it — `KEYMAP_WEIGHT` outranks `KeybindingWeight.EditorContrib` — and would leave the
 * widget open over an editor it had just taken the keyboard out of. `findWidgetVisible` is the guard
 * that stands it down, and this is the assertion on that guard.
 */
export async function editorFindClose(page) {
	await page.keyboard.press('Escape');
	const state = await settle(page, { read: readEditorFind, terminal: value => !value.visible, what: 'the editor find widget to close on Escape' });

	return editorFindState(state);
}

/**
 * The toasts on screen, as their messages.
 *
 * `notificationsToasts.ts` builds one `.notification-toast` per notification and *removes* it when
 * the toast goes away, so the elements are the whole reading — the container's own `visible` class
 * is a second account of the same fact and would only be a way for the two to disagree.
 */
const readNotificationToasts = () => [...document.querySelectorAll('.notification-toast')]
	.map(toast => toast.innerText.replace(/\s+/g, ' ').trim());

/** The toast list, once it holds what `holds` is waiting for. */
export async function notificationToasts(page, holds = () => true, what = 'the notification toasts') {
	return settle(page, { read: readNotificationToasts, terminal: holds, what });
}

// The modal editor's state, as the two things that can be read about it: the mode line
// (`vim.contribution.ts`'s `status.vimMode` entry, which names `viewer` as a state of the same
// machine as vim's own modes) and the buffer, which is what says whether typing reached it.

const readVimMode = () => document.querySelector('.statusbar-item#status\\.vimMode')?.innerText.replace(/\s+/g, ' ').trim() ?? '';

/** Waits for the mode line to read `expected`, and reports what it read instead if it never does. */
export async function vimMode(page, expected) {
	return settle(page, {
		read: readVimMode,
		terminal: text => text === expected,
		what: `the vim mode line to read ${JSON.stringify(expected)}`
	});
}

const readEditorText = () => document.querySelector('.editor-instance .view-lines')?.innerText ?? '';

/**
 * The active editor's text, as the rendered lines hold it, once `holds` accepts it — a keystroke
 * reaches the buffer through the model and comes back as a repaint, so a single read after typing
 * is a read of what was on screen before it.
 */
export async function editorText(page, holds = () => true) {
	return settle(page, { read: readEditorText, terminal: holds, what: 'the editor text' });
}

/**
 * A line of the editor the *active group* is showing. Scoped the way `activeEditorTab` is, and for
 * the same reason: a run that has opened a preview beside a document has two groups mounted, and an
 * unscoped query answers with whichever is drawn first rather than with the one being driven.
 */
const ACTIVE_EDITOR_LINE = '.editor-group-container.active .editor-instance .view-lines .view-line';

/**
 * Puts the keyboard in the active editor, at a position inside its text. A click rather than a
 * command: which key focuses an editor is itself part of what these steps are testing.
 */
export async function focusEditorText(page) {
	await waitForElement(page, ACTIVE_EDITOR_LINE, { state: 'visible', what: 'the active editor group drew no line to click into' });
	await page.click(ACTIVE_EDITOR_LINE);
}

/**
 * Every mounted editor, and how each is drawing its model's lines onto the screen.
 *
 * **A wrap is a fact about one model line, not a line count.** `.view-line` is the virtualised
 * viewport, so its count moves with the scroll position and with the pane's height; counted across
 * the document it also moves with whatever else is mounted. What a wrap changes, and the only thing
 * it changes, is how many *view* lines one *model* line occupies — and the margin says which is
 * which, because `lineNumbers.ts:110` renders a number only where a view line starts a model line
 * and leaves a continuation blank. The longest run of rendered lines under one number is that span,
 * and `> 1` is a wrap, wherever the editor is scrolled to.
 */
const readEditorWrapping = () => {
	const instances = [...document.querySelectorAll('.editor-instance')].map(instance => {
		const group = instance.closest('.editor-group-container');
		// One row per rendered view line, each written with its own `top` by `viewOverlays.ts:177`,
		// and rendered over exactly the range the view lines are.
		const rows = [...instance.querySelectorAll('.margin-view-overlays > div')]
			.map(row => ({ top: parseFloat(row.style.top) || 0, starts: !!row.querySelector('.line-numbers')?.textContent.trim() }))
			.sort((left, right) => left.top - right.top);

		let span = 0;
		let longestSpan = 0;
		for (const row of rows) {
			span = row.starts ? 1 : span + 1;
			longestSpan = Math.max(longestSpan, span);
		}

		return {
			tab: group?.querySelector('.tabs-container .tab.active .label-name')?.textContent.trim() ?? '',
			activeGroup: !!group?.classList.contains('active'),
			viewLines: instance.querySelectorAll('.view-lines .view-line').length,
			modelLines: rows.filter(row => row.starts).length,
			longestSpan
		};
	});

	const active = instances.find(instance => instance.activeGroup) ?? instances[0] ?? { longestSpan: 0 };

	return { ...active, wrapped: active.longestSpan > 1, instances };
};

/**
 * Whether the active editor is wrapping, once `holds` accepts the reading — and, when it never
 * does, the reading itself: what the editor was drawing, and the same for every other editor
 * mounted beside it. A wrap that did not happen is otherwise reported as silence.
 *
 * `holds` is the same discipline `editorText` is on: a keystroke reaches the editor's options
 * through the model's transient state and comes back as a relayout, so a single read after pressing
 * the key is a read of what was on screen before it.
 */
export async function editorWrapping(page, holds = () => true, { what = 'the active editor\'s wrapping', timeoutMs = READ_TIMEOUT } = {}) {
	await waitForElement(page, ACTIVE_EDITOR_LINE, { what: 'the active editor group drew no line to read a wrap off' });
	return settle(page, { read: readEditorWrapping, terminal: holds, what, timeoutMs });
}

/** The distinct colours TextMate tokenization produced in the active editor. */
export async function editorTokenColors(page) {
	await waitForElement(page, '.editor-instance .view-lines .view-line span[class*="mtk"]', { what: 'the active editor never tokenized: no rendered span carried an `mtk` class' });
	return page.evaluate(() => {
		const spans = [...document.querySelectorAll('.editor-instance .view-lines .view-line span[class*="mtk"]')];
		return {
			spanCount: spans.length,
			classes: [...new Set(spans.map(span => span.className))],
			colors: [...new Set(spans.map(span => getComputedStyle(span).color))]
		};
	});
}

// The keyboard model: what has the keyboard, what the keys do where, and what the resolver holds.
//
// Every bare-letter row of `keymap.ts` is guarded on a pane being focused with nothing taking text
// — `focusedView == <id> && !inputFocus` — so putting the keyboard somewhere precise is the first
// thing each of those steps needs, and it is what `focusPane` is.

/**
 * Puts the keyboard in a pane, with no row opened and no box focused.
 *
 * It focuses the list element rather than clicking a row, and the reason is that a click is not
 * neutral here: a click on an explorer row opens a file, on a folder row folds it, and on a search
 * result row opens an editor — so a probe that focused a pane that way would be changing the state
 * the step is about to read. `.monaco-list` carries upstream's own `tabIndex`, and focusing it is
 * what a click on its empty space does.
 */
export async function focusPane(page, name) {
	const body = await openView(page, name);
	const target = VIEWS[name].focus ?? `${body} .monaco-list`;
	await waitForElement(page, target, { state: 'visible', what: `the ${name} pane never drew the element the keyboard goes to` });
	await page.evaluate(selector => document.querySelector(selector)?.focus(), target);

	return waitFor(async () => page.evaluate(selector => {
		const pane = document.querySelector(selector);
		const active = document.activeElement;
		return !!pane && !!active && pane.contains(active) && !/^(INPUT|TEXTAREA)$/.test(active.tagName);
	}, body), { what: `the ${name} pane never took the keyboard` });
}

/**
 * Whether the pane a header title names is expanded. `paneview.ts` puts the class on the pane
 * element itself, and it is what says whether the body has ever been rendered: a pane that has
 * never been expanded has never run `renderBody`, so every field its `focus()` reads is undefined.
 */
export async function paneExpanded(page, title) {
	return page.evaluate(name => [...document.querySelectorAll('.composite.viewlet .pane')]
		.some(pane => pane.querySelector('.title')?.textContent.trim() === name && pane.classList.contains('expanded')), title);
}

/**
 * The `/` box, wherever it is open — one probe for three panes, because there is one box:
 * `viewRootBox.ts` is a widget each pane mounts rather than a class each pane subclasses. Which
 * pane it is in is part of the reading, since only one box can be open at a time.
 *
 * @returns {Promise<{ open: boolean, value: string, placeholder: string, focused: boolean, pane: string }>}
 */
export async function viewRootBox(page) {
	return page.evaluate(() => {
		const container = [...document.querySelectorAll('.viewpane-filter-container')]
			.find(candidate => candidate.getClientRects().length > 0);
		const input = container?.querySelector('input');
		return {
			open: !!container,
			value: input?.value ?? '',
			// Where a typed character would land. The box opens prefilled with a path, so a caret
			// anywhere but the end makes the next keystroke a different query from the one it looks
			// like — which is a fact about the box rather than about any one step.
			caret: input?.selectionStart ?? -1,
			placeholder: input?.getAttribute('placeholder') ?? '',
			focused: !!input && document.activeElement === input,
			pane: container?.closest('.pane')?.querySelector('.title')?.textContent.trim() ?? ''
		};
	});
}

/** The box once it reads `value` — a query is applied through a queue, so the box leads the rows. */
export async function viewRootBoxReads(page, value) {
	return waitFor(async () => {
		const box = await viewRootBox(page);
		return box.value === value ? box : undefined;
	}, { what: `the \`/\` box never read ${JSON.stringify(value)}` });
}

/** `/` in a pane, once its box has the keyboard — which is what makes the next keystroke a query. */
export async function openViewRootFilter(page, name) {
	await focusPane(page, name);
	await page.keyboard.press('/');

	return waitFor(async () => {
		const box = await viewRootBox(page);
		return box.open && box.focused ? box : undefined;
	}, { what: `\`/\` never opened a focused box in the ${name} pane` });
}

/** The `/` box's own `Escape`, and the pane it hands the keyboard back to. */
export async function closeViewRootFilter(page) {
	await page.keyboard.press('Escape');

	return waitFor(async () => {
		const box = await viewRootBox(page);
		return box.open ? undefined : box;
	}, { what: 'the `/` box stayed open after Escape' });
}

/**
 * Clicks into the search view's own query box — a focus move made with the mouse, which is the one
 * gesture the `/` box cannot hear at its input element.
 *
 * It is the query box rather than a tab or the activity bar because nothing about it moves the pane
 * the `/` box sits in: what a step reads afterwards is the same pane, with the keyboard elsewhere
 * inside it, so a box that closed and a pane that was torn down are not the same reading.
 */
export async function focusSearchQueryBox(page) {
	await openView(page, 'search');
	await page.click(SEARCH_QUERY_BOX);
}

/**
 * What holds the keyboard, as the few facts that tell a box handing it over from a box taking it
 * back. `focusPane`'s reading is about one pane; this is about the document, because the point of a
 * blur is that focus has gone somewhere the pane does not own.
 *
 * @returns {Promise<{ tag: string, pane: string, inList: boolean, inFilterBox: boolean, inEditor: boolean }>}
 */
export async function focusedElement(page) {
	return page.evaluate(() => {
		const active = document.activeElement;
		return {
			tag: active?.tagName ?? '',
			pane: active?.closest('.pane')?.querySelector('.title')?.textContent.trim() ?? '',
			inList: !!active?.closest('.monaco-list'),
			inFilterBox: !!active?.closest('.viewpane-filter-container'),
			// Which is what says `editorAreaFocus` holds: the keys that cycle editors are told apart
			// from the ones that cycle views by that key and nothing else.
			inEditor: !!active?.closest('.editor-instance')
		};
	});
}

/** The find input's three toggles, by the state upstream's own `.checked` class puts on each. */
export async function searchToggles(page) {
	await openView(page, 'search');
	return page.evaluate(() => {
		const toggle = name => {
			const element = document.querySelector(`.search-view .search-widget .monaco-findInput .codicon-${name}`);
			return element ? element.classList.contains('checked') : undefined;
		};
		return { caseSensitive: toggle('case-sensitive'), wholeWord: toggle('whole-word'), regex: toggle('regex') };
	});
}

/**
 * `?` — the keys quick pick, as the list it draws: a row's title, the chord beside it, and the
 * group separator it sits under. It is read rather than picked from, so the caller closes it with
 * `closeQuickOpen` or runs one row through `acceptQuickPick` to prove that accepting runs nothing.
 *
 * @returns {Promise<{ label: string, keys: string, separator: string }[]>}
 */
export async function keysQuickPick(page) {
	await closeQuickOpen(page);
	// `Shift+Slash` rather than `?`: the chord is what the resolver matches on, and a bare `?`
	// arrives as `Slash` with no `shiftKey` — which is `/`, and opens the focused pane's filter box
	// instead of this list. That is a box left open over every later step, not a missing pick.
	await page.keyboard.press('Shift+Slash');
	try {
		const state = await settle(page, {
			read: readKeysPickState,
			terminal: value => value.present && !value.busy && value.entries.length > 0,
			what: 'the keys quick pick'
		});

		return state.entries;
	} catch (error) {
		// As in `acceptQuickPick`: an overlay left up is every later step's failure rather than this
		// one's.
		await closeQuickOpen(page).catch(() => { /* the failure above is the one worth reporting */ });
		throw error;
	}
}

const readKeysPickState = () => {
	const widget = [...document.querySelectorAll('.quick-input-widget')]
		.find(candidate => candidate.style.display !== 'none' && candidate.getBoundingClientRect().height > 0);
	if (!widget) {
		return { present: false, busy: false, entries: [] };
	}
	const entries = [...widget.querySelectorAll('.quick-input-list .monaco-list-row')].map(row => ({
		label: row.querySelector('.label-name')?.textContent.trim() ?? row.innerText.replace(/\s+/g, ' ').trim(),
		// One element per key of the chord, which is how upstream's `KeybindingLabel` draws one.
		keys: [...row.querySelectorAll('.monaco-keybinding-key')].map(key => key.textContent.trim()).join('+'),
		separator: row.querySelector('.quick-input-list-separator, .quick-input-list-separator-as-item')?.textContent.trim() ?? ''
	}));
	return { present: true, busy: !!widget.querySelector('.monaco-progress-container.active'), entries };
};

/**
 * The accessibility help, which `keymap.ts` declares keeps upstream's keyboard entirely.
 *
 * **Neither the container's existence nor its height says whether it is up.** It hangs in a
 * `ContextView`, which stays in the DOM once shown and is zero-height either way — the view inside
 * it is what has a size, and the title survives a close. So `open` is the view's own height.
 */
const readAccessibilityHelp = () => ({
	open: (document.querySelector('.accessible-view')?.getBoundingClientRect().height ?? 0) > 0,
	title: document.querySelector('.accessible-view-title')?.textContent.trim() ?? ''
});

/**
 * The help, up. `Alt+F1` is pressed until it is: the app answered the first press with nothing on
 * two runs in five, and the rule is guarded on `!accessibilityHelpIsShown` so a press once it is up
 * is a no-op. Converging rather than deciding on one press is what `openView` learned.
 *
 * @returns {Promise<{ open: boolean, title: string }>}
 */
export async function openAccessibilityHelp(page) {
	return waitFor(async () => {
		await page.keyboard.press('Alt+F1');
		const state = await page.evaluate(readAccessibilityHelp);
		return state.open ? state : undefined;
	}, { what: '`Alt+F1` never opened the accessibility help', poll: QUIET });
}

/** What the help reads as, waited for. @returns {Promise<{ open: boolean, title: string }>} */
export async function accessibilityHelpReads(page, holds, what) {
	return settle(page, { read: readAccessibilityHelp, terminal: holds, what });
}

/**
 * Narrows whatever quick input is up to one row and accepts it. The narrowing is typed rather than
 * arrowed because the list is the pick's own filtered order, which nothing here should assume.
 */
export async function acceptQuickPick(page, label) {
	try {
		await page.keyboard.type(label);
		const state = await settle(page, {
			read: readQuickOpenState,
			terminal: value => value.present && !value.busy && value.picks.length > 0,
			what: `the quick input narrowed to ${JSON.stringify(label)}`
		});
		if (!state.picks[0].label.includes(label)) {
			throw new Error(`${JSON.stringify(label)} is not the first pick; the list holds ${JSON.stringify(state.picks.map(pick => pick.label))}`);
		}
		await page.keyboard.press('Enter');
		await waitForQuickOpen(page, false, `the quick input stayed open after accepting ${JSON.stringify(label)}`);

		return state.picks;
	} catch (error) {
		// **A step that fails with an overlay up takes the rest of the run with it**: the quick
		// input holds the keyboard, so every later step's keys go to a list of picks and every one
		// of them fails on its own bound instead of on its own assertion.
		await closeQuickOpen(page).catch(() => { /* the failure above is the one worth reporting */ });
		throw error;
	}
}

/**
 * Runs a command the way a user with no key for it does: `F1`, its name, `Enter`.
 *
 * The `>` is typed rather than left to the widget. `QuickAccessController` puts it there when the
 * palette opens, but it is *in the box* — so a `Control+a` that clears the box for a known query
 * clears the prefix with it, and the picker silently becomes the file picker, where a command name
 * matches nothing.
 */
export async function runCommandByPalette(page, name) {
	await closeQuickOpen(page);
	await page.keyboard.press('F1');
	await waitForQuickOpen(page, true, 'F1 did not open the command palette');
	await page.keyboard.press('Control+a');
	await page.keyboard.type('>');

	return acceptQuickPick(page, name);
}

/**
 * The rule set the running app resolves with, one entry per rule.
 *
 * **This is the only place it exists.** `KeybindingsRegistry` is filled at import time by modules
 * that cannot be loaded outside a window, so the unit test classifies a corpus rather than the live
 * set; "Inspect Key Mappings" reads the registry and therefore disagrees with the resolver by
 * exactly the rules the takeover dropped. `Developer: Print Effective Keybindings`
 * (`services/keybinding/tauri/keybindingService.ts`) prints `_getResolver().getKeybindings()`, and
 * this reads that print back off the console.
 *
 * @returns {Promise<{ chord: string, command: string, reason: string, when: string }[]>}
 */
export async function effectiveKeybindings(page) {
	// `effectiveKeybindingsMarker`, which this cannot import: the suite is plain `.mjs` and the
	// action is TypeScript inside the bundle.
	const marker = 'tscode: effective keybindings';
	const prints = [];
	const listen = message => {
		const text = message.text();
		if (text.startsWith(marker)) {
			prints.push(text);
		}
	};

	page.on('console', listen);
	try {
		await runCommandByPalette(page, 'Print Effective Keybindings');
		const print = await waitFor(() => prints.at(-1), { what: 'the effective keybindings were never printed' });

		return print.split('\n').slice(1).filter(Boolean).map(line => {
			const [chord, command, reason, when] = line.split('\t');
			return { chord, command, reason, when: when ?? '' };
		});
	} finally {
		page.off('console', listen);
	}
}
