// The markdown preview: a workbench editor pane rendering through `IMarkdownRendererService`.
//
// Stock ships this as an extension painting into a webview. This port renders into the editor
// area instead, so what the suite proves is the part that differs: the pane opens as its own
// editor, it renders the document the command was invoked on, it follows that document's edits,
// and it does not displace the text editor as the default way a `.md` file opens.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitFor, waitForElement, waitForRead } from '../lib/wait.mjs';
import { LONG_DOCUMENT, NEEDLES, STYLED_DOCUMENT } from '../lib/fixture.mjs';
import { closeQuickOpen, editorText, openFileByQuickOpen, quickOpen, vimMode } from '../lib/probes.mjs';

/** The fixture document: one heading and one paragraph carrying a needle. */
const DOCUMENT = 'alpha/src/nested/deep/deeply.md';
const HEADING = 'deeply nested';

/**
 * The document the edit test types into. It is the one markdown file outside `alpha`, `beta` and
 * `gamma` — the three fixture repositories — so a typed character cannot reach the working tree
 * the source-control suite asserts against afterwards.
 */
const EDIT_DOCUMENT = 'README.md';

/** Typed into the document by the re-render test, and written nowhere on disk. */
const EDIT_NEEDLE = 'E2E-PREVIEW-EDIT';

// The renderer service marks the element it was handed rather than wrapping the output in a new
// one (`markdownRenderer.ts` adds `rendered-markdown` to `rendered.element`), so the class lands
// on the pane's own content element — this is one element, not a descendant.
/** The rendered document. Passed into the page rather than restated inside each probe. */
const PREVIEW = '.markdown-preview .markdown-preview-content.rendered-markdown';

/**
 * Runs a command through the palette, refusing to press Enter on a pick that is not the one
 * asked for — otherwise a renamed command silently runs whatever sorted first.
 */
async function runCommand(page, label) {
	const { picks } = await quickOpen(page, `>${label}`);
	const first = picks[0]?.label ?? '';
	assert.ok(
		first.includes(label),
		`the palette offered ${JSON.stringify(first)} first for ${JSON.stringify(label)}: ${JSON.stringify(picks.slice(0, 5))}`
	);
	await page.keyboard.press('Enter');
}

/**
 * Runs one of the two commands that open a preview, and waits for the pane it should have drawn —
 * the pair travels together, since a command that opened nothing is otherwise read as a preview
 * that rendered nothing.
 */
async function openPreview(page, label = 'Open Preview') {
	await runCommand(page, label);
	await waitForElement(page, PREVIEW, { what: `${JSON.stringify(label)} never rendered a preview pane` });
}

/** @returns {Promise<{ present: boolean, heading: string, text: string }>} */
function readPreview(page) {
	return page.evaluate(selector => {
		const rendered = document.querySelector(selector);
		if (!rendered) {
			return { present: false, heading: '', text: '' };
		}
		return {
			present: true,
			heading: rendered.querySelector('h1')?.textContent.trim() ?? '',
			text: rendered.innerText.replace(/\s+/g, ' ').trim()
		};
	}, PREVIEW);
}

/**
 * Where the tail of the long document sits relative to the pane, and where to aim a wheel event.
 * Measured off the marker's own position rather than off the scrollbar, so the assertion holds
 * whichever way the scrollable element moves its content.
 */
function readScrollState(page, tail) {
	return page.evaluate(([selector, tailText]) => {
		const content = document.querySelector(selector);
		if (!content) {
			return { present: false };
		}
		const paneRect = content.closest('.markdown-preview').getBoundingClientRect();
		const marker = [...content.querySelectorAll('*')]
			.find(element => element.children.length === 0 && element.textContent.trim() === tailText);
		return {
			present: true,
			paneBottom: paneRect.bottom,
			centerX: paneRect.left + paneRect.width / 2,
			centerY: paneRect.top + paneRect.height / 2,
			tailTop: marker ? marker.getBoundingClientRect().top : undefined
		};
	}, [PREVIEW, tail]);
}

export default function registerMarkdownPreviewSuite(context) {
	describe('markdown preview', () => {
		it('leaves the text editor as the default way a .md file opens', async () => {
			await openFileByQuickOpen(context.page, DOCUMENT);
			await closeQuickOpen(context.page);

			const lines = await context.page.$$('.editor-instance .view-lines .view-line');
			assert.ok(lines.length > 0, 'opening a markdown file did not produce a text editor');
			assert.equal(await context.page.$(PREVIEW), null, 'opening a markdown file rendered a preview by itself');
		});

		it('renders the document it was invoked on', async () => {
			await openFileByQuickOpen(context.page, DOCUMENT);
			await closeQuickOpen(context.page);
			await openPreview(context.page);

			const preview = await readPreview(context.page);
			assert.equal(preview.heading, HEADING, `the preview rendered no heading: ${JSON.stringify(preview)}`);
			assert.ok(
				preview.text.includes(NEEDLES.polyglot),
				`the preview did not render the document body: ${JSON.stringify(preview.text.slice(0, 200))}`
			);
		});

		it('styles the document from upstream\'s stylesheet, and only inside the pane', async () => {
			await openFileByQuickOpen(context.page, STYLED_DOCUMENT.file);
			await closeQuickOpen(context.page);
			await openPreview(context.page);

			const styles = await context.page.evaluate(([selector, cellText]) => {
				const content = document.querySelector(selector);
				const read = (element, property) => element ? getComputedStyle(element)[property] : undefined;
				const cell = [...content.querySelectorAll('td')].find(td => td.textContent.trim() === cellText);

				// The same rules unconfined would style every table in the workbench, so the
				// confinement is asserted on a table the pane does not contain. Built here
				// rather than found, because what it has to be is a table outside the pane —
				// and whether the workbench happens to hold one is not this test's business.
				const outside = document.createElement('table');
				outside.innerHTML = '<tbody><tr><td>outside</td></tr></tbody>';
				document.body.appendChild(outside);
				const outsidePadding = read(outside.querySelector('td'), 'paddingLeft');
				outside.remove();

				// The code block keeps `data-code` and loses its class: the sanitizer allows
				// `class` only on codicon spans. That attribute is also what the renderer
				// itself finds the block by.
				const code = content.querySelector('div[data-code]');

				return {
					cellFound: !!cell,
					codeFound: !!code,
					cellPadding: [read(cell, 'paddingTop'), read(cell, 'paddingLeft')],
					// A hair under 1px at a fractional device pixel ratio, so the assertion is
					// that a border was drawn rather than that it measured a whole pixel.
					ruleBorder: parseFloat(read(content.querySelector('hr'), 'borderBottomWidth')),
					codeBackground: read(code, 'backgroundColor'),
					outsidePadding
				};
			}, [PREVIEW, STYLED_DOCUMENT.cell]);

			assert.ok(styles.cellFound, `the preview rendered no table cell to measure: ${JSON.stringify(styles)}`);
			assert.ok(styles.codeFound, `the preview rendered no code block to measure: ${JSON.stringify(styles)}`);
			assert.deepEqual(styles.cellPadding, ['5px', '10px'], `the copied stylesheet did not reach the table: ${JSON.stringify(styles)}`);
			assert.ok(styles.ruleBorder > 0, `the copied stylesheet did not draw the thematic break: ${JSON.stringify(styles)}`);
			assert.notEqual(styles.codeBackground, 'rgba(0, 0, 0, 0)', `the code block was left with no background: ${JSON.stringify(styles)}`);
			// The browser's own default for a table cell is 1px, and the copied stylesheet's is
			// the 10px asserted above — so the outside table having the default is the proof.
			assert.equal(styles.outsidePadding, '1px', `the preview stylesheet escaped the pane and is styling the workbench: ${JSON.stringify(styles)}`);
		});

		it('scrolls a document taller than the pane', async () => {
			await openFileByQuickOpen(context.page, LONG_DOCUMENT.file);
			await closeQuickOpen(context.page);
			await openPreview(context.page);

			const before = await readScrollState(context.page, LONG_DOCUMENT.tail);
			assert.ok(before.tailTop !== undefined, 'the long document rendered without its tail marker');
			assert.ok(
				before.tailTop > before.paneBottom,
				`the document is not taller than the pane, so scrolling it would prove nothing: ${JSON.stringify(before)}`
			);

			await context.page.mouse.move(before.centerX, before.centerY);
			for (let turn = 0; turn < 5; turn++) {
				await context.page.mouse.wheel(0, 1000);
			}

			// The wheel is handled asynchronously, so the tail's new position is polled for rather
			// than read once — paced like every other poll in the suite, because each reading
			// measures the whole rendered document and an unpaced loop spends the wait competing
			// with the layout it is waiting on.
			let after = before;
			try {
				await waitFor(async () => {
					after = await readScrollState(context.page, LONG_DOCUMENT.tail);
					return after.tailTop < before.tailTop - 200;
				}, { what: 'the preview never scrolled' });
			} catch { /* where it ended up is the assertion below, which names both positions */ }

			assert.ok(
				after.tailTop < before.tailTop - 200,
				`the wheel did not scroll the preview: the tail stayed at ${after.tailTop} from ${before.tailTop}`
			);
		});

		it('opens beside the document and follows its edits', async () => {
			await openFileByQuickOpen(context.page, EDIT_DOCUMENT);
			await closeQuickOpen(context.page);
			await openPreview(context.page, 'Open Preview to the Side');

			const groups = await context.page.$$('.editor-group-container');
			assert.ok(groups.length >= 2, `the preview opened in ${groups.length} editor group(s), not beside the document`);

			// Opening to the side leaves the preview's group active, so the typing has to be aimed
			// back at the document's group by hand — reopening the file through quick open would
			// open it over the preview instead, which is the thing being watched.
			await runCommand(context.page, 'Focus First Editor Group');

			// **A focused editor does not take typing.** This port opens a file as a viewer and
			// gives the letters to the keymap until `V` attaches vim and `i` puts it in insert —
			// which is what `editor.mjs` asserts as the feature. Typed at the viewer, the needle's
			// own letters ran commands instead: its `T` opened a terminal editor over the document,
			// so the preview had nothing to follow.
			await vimMode(context.page, '-- VIEWER --');
			await context.page.keyboard.press('v');
			await vimMode(context.page, '-- NORMAL --');
			await context.page.keyboard.press('i');
			await vimMode(context.page, '-- INSERT --');
			await context.page.keyboard.type(`${EDIT_NEEDLE} `);

			await waitForRead(context.page, {
				read: selector => {
					const rendered = document.querySelector(selector);
					return { present: !!rendered, text: rendered?.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '' };
				},
				readArg: PREVIEW,
				holds: preview => preview.text.includes(EDIT_NEEDLE),
				what: `the preview never re-rendered with ${JSON.stringify(EDIT_NEEDLE)} after it was typed into the document beside it`
			});

			// Back to the state the step found: the buffer without the needle and the editor a
			// viewer again, since every suite after this one starts from the workbench this leaves.
			await context.page.keyboard.press('Escape');
			await vimMode(context.page, '-- NORMAL --');
			// `u` takes back one of vim's insert units, and how many the needle was typed as is the
			// engine's business rather than this step's — so it is pressed until the needle is gone.
			await waitFor(async () => {
				await context.page.keyboard.press('u');
				return !(await editorText(context.page)).includes(EDIT_NEEDLE);
			}, { what: 'undo never took the typed needle back out of the document' });
			await context.page.keyboard.type(':q');
			await context.page.keyboard.press('Enter');
			await vimMode(context.page, '-- VIEWER --');
		});
	});
}
