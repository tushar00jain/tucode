import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownTokens } from '../../src/editor/markdownProjection.js';
import { IMarkdownSpan, renderTokens } from '../../src/tui/editor/markdownRows.js';
import { lineWidth } from '../../src/tui/terminal/screen.js';

const render = (source: string, width: number) => renderTokens(markdownTokens('file:///README.md', source).tokens, {
	width, style: {}, code: token => token.text.split('\n').map(text => [{ text }])
});
const text = (source: string, width: number) => render(source, width).map(row => row.map(span => span.text).join('').trimEnd());

test('native Markdown retains nested headings, task lists, fences and hard line breaks', () => {
	const rows = text('> ## Nested\n>\n> - [x] outer\n>   - inner\n>\n> ```ts\n> const nested = 1;\n> ```\n\none  \ntwo', 32);
	assert.ok(rows.includes('▌ Nested'));
	assert.ok(rows.includes('▌ ' + '─'.repeat(30)));
	assert.ok(rows.includes('▌ • [x] outer'));
	assert.ok(rows.some(row => /^▌\s+• inner$/.test(row)));
	assert.ok(rows.includes('▌ const nested = 1;'));
	assert.deepEqual(rows.slice(-2), ['one', 'two']);
});

test('native Markdown rewraps tables and paragraphs while retaining link hit targets', () => {
	const source = '| left | right |\n| :--- | ---: |\n| [long linked words](guide.md) | several other words |\n\n[one two three four five](guide.md)';
	const wide = render(source, 60); const narrow = render(source, 24);
	assert.ok(narrow.length > wide.length, 'narrower geometry adds wrapped rows');
	assert.ok(narrow.every(row => lineWidth(row) <= 24));
	const table = narrow.filter(row => row[0]?.text === '│');
	assert.ok(table.length > 2, 'table cells wrap beneath the header');
	assert.ok(table.every(row => lineWidth(row) === lineWidth(table[0])), 'wrapped cell rows retain one table frame');
	const links = narrow.flatMap(row => row as readonly IMarkdownSpan[]).filter(span => span.href);
	assert.ok(links.length > 2);
	assert.ok(links.every(span => span.href === 'guide.md' && span.underline));
	assert.match(links.map(span => span.text).join(''), /long linked words/);
});
