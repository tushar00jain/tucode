// The markdown preview, on the frame it paints.
//
// **The whole feature is a picture**, so this is where it is checked: the parse is `marked`'s and
// the colours are the theme's, and neither can be asserted anywhere but on cells. Each test names
// one thing the pane had to *substitute* for — a heading's font scale, a list's bullet, a
// blockquote's left border, a table's collapsed border and its auto column widths, a fence's
// syntax colour — because those are the divergences §20 records, and a substitution that silently
// stopped happening looks exactly like one that never did.
//
// Upstream counterpart: none — tscode's preview is a webview document and its own e2e asserts that a stylesheet is applied and confined, which has no counterpart on a cell grid.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PREVIEW, README } from '../lib/fixture.mjs';
import { editorLines, editorTabs } from '../lib/probes.mjs';
import { themeColour } from '../lib/theme.mjs';

/** The active editor's rows, with the tab strip taken off — every row, blanks included. */
const rows = frame => editorLines(frame).slice(1);

/**
 * Where `text` is, as an index into `lines` — an index rather than the row itself because two
 * assertions are about the row *under* one, and `slice` builds a fresh object every call, so an
 * `indexOf` over a second reading finds nothing.
 */
function rowAt(lines, text) {
	const at = lines.findIndex(line => line.text.includes(text));
	assert.notEqual(at, -1, `no preview row holds ${JSON.stringify(text)} — got ${JSON.stringify(lines.map(line => line.text.trimEnd()).slice(0, 30))}`);

	return at;
}

/** The row holding `text`, as cells, so an assertion can read a colour off it. */
function rowWith(frame, text) {
	const lines = rows(frame);

	return lines[rowAt(lines, text)];
}

/** The cell the first character of `text` is drawn in, which is where that span's style is. */
function cellOf(line, text) {
	const at = line.text.indexOf(text);
	assert.notEqual(at, -1, `${JSON.stringify(text)} is not in ${JSON.stringify(line.text)}`);

	return line.cells[at];
}

export default function registerMarkdownSuite(context) {
	describe('markdown preview', () => {
		it('opens as a tab of its own, named by upstream\'s own input', () => {
			const tabs = editorTabs(context.frames.markdownPreview).map(tab => tab.name);

			// `MarkdownPreviewEditorInput.getName` is `Preview {0}` over the document's basename, and
			// Regular preview opens in the current group and keeps the source tab alongside it.
			assert.ok(tabs.includes(`Preview ${README.name}`), `the strip reads ${JSON.stringify(tabs)}`);
			assert.ok(tabs.includes(README.name), 'the document\'s own editor remains in the same tab strip');
		});

		it('draws a heading in bold with a rule under it, because a cell grid has one glyph size', () => {
			const lines = rows(context.frames.markdownPreview);
			const at = rowAt(lines, PREVIEW.heading);
			const heading = lines[at];
			const under = lines[at + 1];

			assert.equal(cellOf(heading, PREVIEW.heading).bold, true, 'the heading is not bold');
			assert.match(under.text, /^─+$/, `the row under an h1 is its border-bottom — got ${JSON.stringify(under.text)}`);
			assert.equal(under.cells[0].fg, themeColour('textSeparator.foreground'));
		});

		it('carries emphasis, strikethrough, link colour and codespan colours onto the cells', () => {
			const line = rowWith(context.frames.markdownPreview, PREVIEW.bold);

			assert.equal(cellOf(line, PREVIEW.bold).bold, true);
			assert.equal(cellOf(line, PREVIEW.struck).strikethrough, true);
			assert.equal(cellOf(line, PREVIEW.link).fg, themeColour('textLink.foreground'));
			assert.equal(cellOf(line, PREVIEW.codespan).fg, themeColour('textPreformat.foreground'));
			assert.equal(cellOf(line, PREVIEW.codespan).bg, themeColour('textPreformat.background'));
			// The markup itself is gone, which is the difference between a preview and the file.
			assert.ok(!line.text.includes('**') && !line.text.includes('~~'), `the source markers are still on screen: ${JSON.stringify(line.text)}`);
		});

		it('gives a list its bullets and a blockquote its border column', () => {
			const frame = context.frames.markdownPreview;

			for (const bullet of PREVIEW.bullets) {
				assert.match(rowWith(frame, bullet).text, new RegExp(`^\\s*•\\s${bullet}`));
			}

			const quote = rowWith(frame, PREVIEW.quote);
			assert.match(quote.text, /^▌ /, `a blockquote's border-left is a gutter column — got ${JSON.stringify(quote.text)}`);
			assert.equal(quote.cells[0].fg, themeColour('textBlockQuote.border'));
		});

		it('draws a table in box glyphs, with the column widths computed from the cells', () => {
			const lines = rows(context.frames.markdownPreview);
			const at = rowAt(lines, PREVIEW.table.columns[0]);
			const header = lines[at];

			assert.match(lines[at - 1].text.trimEnd(), /^┌─+┬─+┐$/, 'the top rule');
			assert.match(lines[at + 1].text.trimEnd(), /^├─+┼─+┤$/, 'the header rule');

			// **Auto layout**: each column is as wide as its own widest cell plus a space either
			// side, which is the one thing about a table no property answers and no stylesheet
			// states. A fixed width, or a width taken from the header alone, fails this.
			const cells = header.text.split('│').slice(1, -1);
			assert.deepEqual(cells.map(cell => cell.length), PREVIEW.table.widest.map(text => text.length + 2),
				`the columns are not the width of their contents — got ${JSON.stringify(cells)}`);
		});

		it('colours a fenced block with the editor\'s own tokenizer, on its own background', () => {
			const line = rowWith(context.frames.markdownPreview, PREVIEW.fence.line);
			const keyword = cellOf(line, PREVIEW.fence.keyword);

			assert.equal(keyword.bg, themeColour('textCodeBlock.background'), 'the fence has no background');
			// Discriminating against "the fence was painted in the body colour": a keyword must not
			// be the foreground every other row of the document is drawn in.
			assert.notEqual(keyword.fg, themeColour('editor.foreground'),
				`\`${PREVIEW.fence.keyword}\` is drawn in the editor foreground, so the grammar never reached it`);
		});

		it('substitutes for what a cell grid cannot draw at all, rather than dropping it', () => {
			const frame = context.frames.markdownPreview;

			// An image is its alt text; a `<hr>` is a full row of the rule glyph; raw HTML is its
			// own source, because nothing here can parse it and a block that vanished would be §17.
			const alt = rowWith(frame, PREVIEW.image);
			assert.ok(alt.text.includes(PREVIEW.html), `raw HTML is shown as written — got ${JSON.stringify(alt.text)}`);
			assert.ok(rows(frame).some(line => /^─{10,}$/.test(line.text.trimEnd())), 'the `---` rule is not drawn');
		});

		it('leaves the document\'s own editor behind when the preview is closed', () => {
			assert.deepEqual(editorTabs(context.frames.markdownPreviewClosed).map(tab => tab.name).filter(Boolean).slice(-1), [README.name]);
		});
	});
}
