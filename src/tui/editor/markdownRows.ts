/*---------------------------------------------------------------------------------------------
 *  A markdown document as terminal rows.
 *
 *  **Every decision about the document is `marked`'s, and none of them is here.** What is in the
 *  document, in what order, with what nesting, which cell of which table and what language each
 *  fence is, all come out of `base/common/marked/marked.js`'s `lexer` — the same parser tscode's
 *  own preview renders through (`contrib/markdown/tauri/markdownPreviewEditor.ts` →
 *  `IMarkdownRendererService` → `marked.parse`), so the parse tree here is tscode's by
 *  construction, GFM edge cases included. What this file owns is *geometry*: which row a block
 *  starts on, where a line wraps, how wide a table column is. That is rung 4's charter and nothing
 *  more.
 *
 *  **Why the pane is not tscode's.** Its pipeline is `marked.parse` → an HTML *string* →
 *  DOMPurify → `innerHTML`, and the terminal DOM (§4) has no HTML parser and no `innerHTML` at
 *  all: an assignment would store a string, create no children, and `paint()` would walk
 *  `childNodes` and paint an empty pane with no error anywhere — §17's shape exactly. And
 *  `paint.ts`'s `walk()` flattens any element tree into **one line of spans**, because `RowPainter`
 *  is the render half of `listView.ts` and a list row is one line. A markdown document is a block
 *  layout, and giving the terminal DOM one is option B of §4.1, which was measured and rejected.
 *  So the tokens are walked here instead, and the HTML step never happens.
 *
 *  One glyph size means a heading is bold plus a rule
 *  row rather than 2em; an image is its alt text; a 1px border is a whole row of `─`.
 *
 *  Upstream counterpart: none — upstream renders markdown to HTML and lets a stylesheet lay it out (`base/browser/markdownRenderer.ts` plus `extensions/markdown-language-features/media/markdown.css`); there is no upstream file that turns markdown into rows.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { marked, type Token, type Tokens } from '../../vs/base/common/marked/marked.js';
import { ILine, ISpan, lineWidth, spanWidth } from '../terminal/screen.js';

/** Link metadata follows styled spans through wrapping, tables and quote/list indentation. */
export interface IMarkdownSpan extends ISpan { readonly href?: string; }

/**
 * The colours the document is drawn in, which are the ids tscode's own preview stylesheets name —
 * `markdownPreview.css` states every one of them (`git show vendor:src/vs/workbench/contrib/markdown/tauri/markdownPreview.css`).
 * A pane resolves them off the theme; nothing here chooses one.
 */
export interface IMarkdownStyle {
	/** `--vscode-editor-foreground`: body text. */
	readonly foreground?: Color;
	/** `--vscode-textSeparator-foreground`: the `h1`/`h2` underline, `hr`, and every table rule. */
	readonly separator?: Color;
	/** `--vscode-textLink-foreground`. */
	readonly link?: Color;
	/** `--vscode-textPreformat-foreground` / `-background`: a codespan. */
	readonly codeForeground?: Color;
	readonly codeBackground?: Color;
	/** `--vscode-textBlockQuote-background` / `-border`. */
	readonly quoteBackground?: Color;
	readonly quoteBorder?: Color;
	/** What has no colour of its own upstream because it is not drawn at all: alt text, raw HTML. */
	readonly muted?: Color;
}

export interface IMarkdownLayout {
	/** The columns the document is laid out in, which is the editor area's width. */
	readonly width: number;
	readonly style: IMarkdownStyle;
	/**
	 * The rows a fenced block draws as. It is the caller's because colouring code needs the
	 * tokenizer, the grammars and the theme — a `TextModel` and a `TextView`, which are services
	 * rather than a function of the token.
	 */
	readonly code: (token: Tokens.Code) => ILine[];
}

/**
 * A hard line break — `Tokens.Br`, and the two-space line ending — as something a span list can
 * carry. It never reaches a frame: `wrap` breaks the line on it and drops it, which is the only
 * safe form for one, because a `\n` written to the terminal moves the cursor and shifts every row
 * after it (§17).
 */
const HARD_BREAK = { text: '' };

/** The `border-bottom` `markdown.css` puts under `h1` and `h2`, and `hr`, as the row it is here. */
const RULE = '─';

/** The `border-left` a blockquote carries, and the column the text is indented by after it. */
const QUOTE_GUTTER = '▌ ';

/** An unordered list's marker. `markdown.css` leaves `ul` at the browser's own `disc`. */
const BULLET = '•';

/** The box `border-collapse: collapse` draws with, in the one alphabet a cell grid has for it. */
const BOX = {
	horizontal: '─', vertical: '│',
	topLeft: '┌', topJoin: '┬', topRight: '┐',
	midLeft: '├', midJoin: '┼', midRight: '┤',
	bottomLeft: '└', bottomJoin: '┴', bottomRight: '┘'
};

/** A table column never shrinks below this, whatever the frame costs it. */
const MIN_COLUMN = 3;

/**
 * **The lexer's text is HTML-escaped, and a cell is not HTML.** `Tokenizer.inlineText` runs every
 * run of text through marked's `escape`, because the destination is markup a browser decodes
 * again — so `the fork's own` arrives as `the fork&#39;s own` and would be painted that way.
 *
 * The map and the pattern are **upstream's own**, copied from `renderAsPlaintext`
 * (`base/browser/markdownRenderer.ts:717–728`), which is the same walk over the same tokens with
 * the same problem. Copied rather than imported because the constant is private to that file, and
 * that file is `base/browser` — `renderMarkdown` beside it is DOMPurify and `innerHTML`.
 */
const UNESCAPE = new Map<string, string>([
	['&quot;', '"'],
	['&nbsp;', ' '],
	['&amp;', '&'],
	['&#39;', '\''],
	['&lt;', '<'],
	['&gt;', '>']
]);

function unescape(text: string): string {
	return text.replace(/&(#\d+|[a-zA-Z]+);/g, match => UNESCAPE.get(match) ?? match);
}

/** Every `Tokens.Code` in the tree, in document order — what a pane tokenizes before it draws. */
export function codeTokens(tokens: readonly Token[]): Tokens.Code[] {
	const found: Tokens.Code[] = [];

	marked.walkTokens(tokens as Token[], token => {
		if (token.type === 'code') {
			found.push(token as Tokens.Code);
		}
	});

	return found;
}

/**
 * The document as rows, one block after another separated by a blank row — which is
 * `markdown.css`'s `margin-bottom: 16px` on every block element, the one vertical distance in the
 * stylesheet a terminal has a unit for. A block that draws nothing takes no gap.
 */
export function renderTokens(tokens: readonly Token[], layout: IMarkdownLayout, gap = true): ILine[] {
	const rows: ILine[] = [];

	for (const token of tokens) {
		const drawn = block(token, layout);
		if (!drawn.length) {
			continue;
		}
		if (rows.length && gap) {
			rows.push([]);
		}
		rows.push(...drawn);
	}

	return rows;
}

function block(token: Token, layout: IMarkdownLayout): ILine[] {
	const { width, style } = layout;

	switch (token.type) {
		// `Tokens.Space` is the blank line between two blocks, which is already the gap
		// `renderTokens` puts there; `Tokens.Def` is a link reference definition, which upstream
		// renders as nothing at all.
		case 'space':
		case 'def':
			return [];

		case 'heading':
			return heading(token as Tokens.Heading, layout);

		case 'paragraph':
			return wrap(inline((token as Tokens.Paragraph).tokens, {}, style), width);

		// A loose list item's children, and any text `marked` did not promote to a paragraph.
		case 'text':
			return wrap(inline([token], {}, style), width);

		case 'hr':
			return [rule(width, style)];

		case 'blockquote':
			return blockquote(token as Tokens.Blockquote, layout);

		case 'list':
			return list(token as Tokens.List, layout);

		case 'code':
			return layout.code(token as Tokens.Code);

		case 'table':
			return table(token as Tokens.Table, layout);

		// **Raw HTML is drawn as its own source, dimmed.** Nothing here can parse it — that is the
		// whole reason this file exists — and dropping it silently is §17's shape: a block missing
		// from the document with no error anywhere. Shown as written, a reader knows it is there.
		case 'html':
			return (token as Tokens.HTML).raw.replace(/\n+$/, '').split('\n')
				.map(line => [{ text: line, fg: style.muted }]);

		default:
			return wrap([{ text: token.raw ?? '', fg: style.foreground }], width);
	}
}

/** A full-width `1px` border, which is a whole row of `─` once a cell is the smallest thing there is. */
function rule(width: number, style: IMarkdownStyle): ILine {
	return [{ text: RULE.repeat(Math.max(0, width)), fg: style.separator }];
}

/**
 * A heading. **The font scale cannot cross** — a cell grid has one glyph size — so the substitute
 * is bold for every level plus, for `h1` and `h2`, the `border-bottom` `markdown.css` gives exactly
 * those two.
 */
function heading(token: Tokens.Heading, layout: IMarkdownLayout): ILine[] {
	const rows = wrap(inline(token.tokens, { bold: true }, layout.style), layout.width);

	if (token.depth <= 2) {
		rows.push(rule(layout.width, layout.style));
	}

	return rows;
}

/**
 * A blockquote: the `border-left` as a gutter column, and the `background` filled out to the width
 * so the block reads as one box rather than as ragged text. The content is the same walk one level
 * in, so a quote inside a quote gains a second gutter for free.
 */
function blockquote(token: Tokens.Blockquote, layout: IMarkdownLayout): ILine[] {
	const width = Math.max(1, layout.width - QUOTE_GUTTER.length);
	const gutter: ISpan = { text: QUOTE_GUTTER, fg: layout.style.quoteBorder, bg: layout.style.quoteBackground };

	return renderTokens(token.tokens, { ...layout, width })
		.map(row => [gutter, ...fillRow(row, width, layout.style.quoteBackground)]);
}

/**
 * A list. The marker is the indent — `1. `, `10. ` and `• ` are each as wide as they are, and the
 * item's own rows are laid out in what is left, so a nested list steps in by its parent's marker.
 */
function list(token: Tokens.List, layout: IMarkdownLayout): ILine[] {
	const start = typeof token.start === 'number' ? token.start : 1;
	const markers = token.items.map((item, index) => marker(token, start + index, item));
	const indent = markers.reduce((width, text) => Math.max(width, text.length), 0);
	const rows: ILine[] = [];

	for (const [index, item] of token.items.entries()) {
		// A loose list is what `marked` marks when its items are separated by blank lines, and
		// `markdown.css` gives exactly that case its `li > p` margins back.
		if (token.loose && rows.length) {
			rows.push([]);
		}

		// A **tight** item's own blocks get no gap between them: `<li>text<ul>…</ul></li>` has no
		// margin in a browser either, and a blank row between an item and the list nested under it
		// reads as two lists. `markdown.css` gives `li > p` its margins back only for a loose list,
		// which is the same condition one level up.
		const content = renderTokens(item.tokens, { ...layout, width: Math.max(1, layout.width - indent) }, token.loose);
		for (const [row, line] of (content.length ? content : [[]]).entries()) {
			const lead = row === 0 ? markers[index].padEnd(indent) : ' '.repeat(indent);
			rows.push([{ text: lead, fg: layout.style.foreground }, ...line]);
		}
	}

	return rows;
}

/** `1. ` or `• `, and the task-list checkbox `markdown.css` draws as an `input` upstream. */
function marker(token: Tokens.List, ordered: number, item: Tokens.ListItem): string {
	const box = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';

	return `${token.ordered ? `${ordered}.` : BULLET} ${box}`;
}

/**
 * A table, with **auto column widths computed from the cells** — which is what `table-layout: auto`
 * is: an algorithm over the contents rather than a property any resolver answers. `align` is the
 * parser's, off the delimiter row.
 */
function table(token: Tokens.Table, layout: IMarkdownLayout): ILine[] {
	const header = token.header.map(cell => inline(cell.tokens, { bold: true }, layout.style));
	const body = token.rows.map(row => row.map(cell => inline(cell.tokens, {}, layout.style)));
	const widths = columnWidths([header, ...body], layout.width);

	return [
		tableRule(widths, BOX.topLeft, BOX.topJoin, BOX.topRight, layout.style),
		...tableRow(header, widths, token.align, layout),
		tableRule(widths, BOX.midLeft, BOX.midJoin, BOX.midRight, layout.style),
		...body.flatMap(row => tableRow(row, widths, token.align, layout)),
		tableRule(widths, BOX.bottomLeft, BOX.bottomJoin, BOX.bottomRight, layout.style)
	];
}

/** One horizontal rule of the box, with the join glyph the row's position asks for. */
function tableRule(widths: readonly number[], left: string, join: string, right: string, style: IMarkdownStyle): ILine {
	return [{ text: left + widths.map(width => BOX.horizontal.repeat(width + 2)).join(join) + right, fg: style.separator }];
}

/**
 * The column widths: each column as wide as its widest cell, then the widest column shrunk by one
 * until the whole row fits the frame — which is the shape `table-layout: auto` distributes overflow
 * in, and the only one that keeps a narrow column readable when a wide one is prose.
 */
function columnWidths(rows: readonly (readonly ISpan[][])[], frame: number): number[] {
	const columns = rows.reduce((count, row) => Math.max(count, row.length), 0);
	const widths = Array.from({ length: columns }, (_unused, column) =>
		rows.reduce((width, row) => Math.max(width, row[column] ? lineWidth(row[column]) : 0), 1));

	// Each column costs a space either side and a rule between, plus the two outer rules.
	const chrome = columns * 3 + 1;
	while (widths.reduce((total, width) => total + width, chrome) > frame) {
		const widest = widths.indexOf(Math.max(...widths));
		if (widths[widest] <= MIN_COLUMN) {
			break;
		}
		widths[widest]--;
	}

	return widths;
}

/** One table row, as tall as its tallest cell — every cell wrapped to its own column. */
function tableRow(cells: readonly ISpan[][], widths: readonly number[], align: Tokens.Table['align'], layout: IMarkdownLayout): ILine[] {
	const wrapped = widths.map((width, column) => wrap(cells[column] ?? [], width));
	const height = wrapped.reduce((rows, cell) => Math.max(rows, cell.length), 1);
	const edge: ISpan = { text: BOX.vertical, fg: layout.style.separator };
	const rows: ILine[] = [];

	for (let row = 0; row < height; row++) {
		const line: ISpan[] = [edge];
		for (const [column, width] of widths.entries()) {
			const cell = wrapped[column][row] ?? [];
			const slack = width - lineWidth(cell);
			const before = align[column] === 'right' ? slack : align[column] === 'center' ? Math.floor(slack / 2) : 0;

			line.push({ text: ` ${' '.repeat(before)}` }, ...cell, { text: `${' '.repeat(Math.max(0, slack - before))} ` }, edge);
		}
		rows.push(line);
	}

	return rows;
}

/** What an inline walk carries down: the emphasis and colour a span inherits from its ancestors. */
type IInlineStyle = Omit<IMarkdownSpan, 'text'>;

/**
 * The inline tokens as spans. Everything here is expressible in a cell — weight, slant, strike,
 * underline and colour are what an SGR run carries — **except an image**, which becomes its alt
 * text, and a link's href, which upstream does not draw either.
 */
function inline(tokens: readonly Token[], style: IInlineStyle, palette: IMarkdownStyle): ISpan[] {
	const spans: ISpan[] = [];

	for (const token of tokens) {
		switch (token.type) {
			case 'strong':
				spans.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }, palette));
				break;

			case 'em':
				spans.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }, palette));
				break;

			case 'del':
				spans.push(...inline((token as Tokens.Del).tokens, { ...style, strikethrough: true }, palette));
				break;

			case 'link':
				spans.push(...inline((token as Tokens.Link).tokens, { ...style, fg: palette.link, underline: true, href: (token as Tokens.Link).href }, palette));
				break;

			case 'codespan':
				spans.push({ ...style, text: unescape((token as Tokens.Codespan).text), fg: palette.codeForeground, bg: palette.codeBackground });
				break;

			// **An image is its alt text.** Sixel and the kitty protocol are the only ways a cell
			// grid shows a picture and both are out of scope, so this is the substitution rather
			// than a gap — and a bare `![](…)` shows the file it would have loaded.
			case 'image':
				spans.push({ ...style, text: unescape((token as Tokens.Image).text) || (token as Tokens.Image).href, fg: palette.muted });
				break;

			case 'br':
				spans.push(HARD_BREAK);
				break;

			case 'html':
				spans.push({ ...style, text: (token as Tokens.Tag).text, fg: palette.muted });
				break;

			default: {
				const nested = (token as Tokens.Text).tokens;
				if (nested?.length) {
					spans.push(...inline(nested, style, palette));
				} else {
					spans.push({ ...style, text: unescape((token as Tokens.Text).text ?? token.raw ?? ''), fg: style.fg ?? palette.foreground });
				}
			}
		}
	}

	return spans;
}

/**
 * Greedy wrap at word boundaries, which is what `word-wrap: break-word` gives a paragraph.
 *
 * It is not `MonospaceLineBreaksComputerFactory` — the editor's own wrap — because that computes
 * breaks for *one line of a model* and answers in offsets into it, and what is being wrapped here
 * is a span list whose styling has to survive the break.
 */
function wrap(spans: readonly ISpan[], width: number): ILine[] {
	const columns = Math.max(1, width);
	const rows: ILine[] = [];
	let line: ISpan[] = [];
	let used = 0;

	const flush = () => {
		rows.push(line);
		line = [];
		used = 0;
	};
	const put = (span: ISpan, text: string) => {
		const last = line[line.length - 1];
		if (last && sameStyle(last, span)) {
			line[line.length - 1] = { ...last, text: last.text + text };
		} else {
			line.push({ ...span, text });
		}
		used += spanWidth(text);
	};

	for (const span of spans) {
		if (span === HARD_BREAK) {
			flush();
			continue;
		}

		for (const chunk of span.text.split(/(\s+)/)) {
			if (!chunk) {
				continue;
			}
			// Whitespace collapses to one column, as it does in a browser, and never starts a row.
			if (/^\s+$/.test(chunk)) {
				if (used > 0 && used < columns) {
					put(span, ' ');
				}
				continue;
			}

			let word = chunk;
			while (spanWidth(word) > columns - used) {
				if (used === 0) {
					// A word longer than the whole row has nowhere to break, so it is cut at the edge.
					const head = takeColumns(word, columns);
					put(span, head);
					word = word.slice(head.length);
				}
				flush();
			}
			if (word) {
				put(span, word);
			}
		}
	}

	if (line.length || !rows.length) {
		rows.push(line);
	}

	return rows;
}

/** As much of `text` as fits in `columns`, by the same accounting the writer paints it with. */
function takeColumns(text: string, columns: number): string {
	let taken = '';
	for (const character of text) {
		if (spanWidth(taken + character) > columns) {
			break;
		}
		taken += character;
	}

	return taken || text.slice(0, 1);
}

/** Whether two spans differ in anything but their text, which is what lets a wrap merge them. */
function sameStyle(a: IMarkdownSpan, b: IMarkdownSpan): boolean {
	return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic
		&& a.underline === b.underline && a.strikethrough === b.strikethrough && a.dim === b.dim && a.href === b.href;
}

/**
 * A row over a background, padded out to `width` — which is what makes a block with a background a
 * box rather than ragged text. A span that brought its own colour keeps it.
 *
 * Exported because a fenced block is the caller's rows and needs the same treatment: `<pre>`'s
 * `background-color` covers the box, not the text.
 */
export function fillRow(row: ILine, width: number, background: Color | undefined): ISpan[] {
	const remaining = width - lineWidth(row);
	const painted = row.map(span => span.bg ? span : { ...span, bg: background });

	return remaining > 0 ? [...painted, { text: ' '.repeat(remaining), bg: background }] : painted;
}
