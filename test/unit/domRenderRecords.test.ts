import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TerminalElement } from '../../src/tui/terminal/dom/document.js';
import { paint } from '../../src/tui/terminal/dom/paint.js';
import { interpretDom, interpretSegmentedDom, projectRenderRecords } from '../../src/tui/terminal/dom/renderRecords.js';
import { addStylesheet } from '../../src/tui/terminal/dom/style.js';
import { Color } from '../../src/vs/base/common/color.js';
import { applyRenderState, lineRenderRecords } from '../../src/render/domRecords.js';

addStylesheet(`
	.projection-fixture { color: #112233; background: #ddeeff; }
	.projection-fixture .hidden { display: none; }
	.projection-fixture .decorated::before { content: "M"; margin-right: 4px; font-family: codicon; }
	.projection-fixture .secondary { opacity: .7; font-style: italic; }
`);

const theme = { getColor: () => undefined } as any;
function fixture(): TerminalElement {
	const root = new TerminalElement('div');
	root.className = 'projection-fixture';
	const name = new TerminalElement('span');
	name.className = 'decorated';
	name.textContent = 'alpha';
	const hidden = new TerminalElement('span');
	hidden.className = 'hidden';
	hidden.textContent = 'never';
	const detail = new TerminalElement('span');
	detail.className = 'secondary';
	detail.textContent = 'beta';
	root.append(name, hidden, detail);
	return root;
}

describe('neutral DOM render records', () => {
	it('carries semantic state on a styled span without changing its painted text', () => {
		const records = lineRenderRecords([
			{ text: 'Aa', accessibleLabel: 'Match Case on', bold: true },
			{ text: ' ab', accessibleLabel: ' Match Whole Word off' }
		]);
		assert.equal(records.runs.map(run => run.text).join(''), 'Aa ab');
		assert.equal(records.accessibleLabel, 'Match Case on Match Whole Word off');
		assert.equal('accessibleLabel' in records.runs[0].style, false, 'AX semantics leaked into paint style');
	});

	it('uses one semantic extraction for ANSI spans', () => {
		const root = fixture();
		const records = interpretDom(root, theme);
		const spans = paint(root, theme);
		assert.deepEqual(spans, records.runs.map(({ text, style }) => {
			return { ...style, text };
		}));

		assert.equal(spans.map(span => span.text).join(''), 'M alphabeta');
		assert.equal(records.accessibleLabel, 'alphabeta', 'generated icon glyph leaked into semantic text');
	});

	it('uses explicit labels and excludes aria-hidden and icon spans without changing visual runs', () => {
		const root = new TerminalElement('div');
		const icon = new TerminalElement('span'); icon.className = 'codicon codicon-file'; icon.textContent = '\uea7b';
		const name = new TerminalElement('span'); name.textContent = 'golden';
		const suffix = new TerminalElement('span'); suffix.textContent = '.txt';
		const hidden = new TerminalElement('span'); hidden.setAttribute('aria-hidden', 'true'); hidden.textContent = 'ignored';
		root.append(icon, name, suffix, hidden);
		const records = interpretDom(root, theme);
		assert.equal(records.accessibleLabel, 'golden.txt');
		assert.equal(records.runs.map(run => run.text).join(''), '\uea7bgolden.txtignored');

		root.setAttribute('aria-label', 'Golden source file');
		assert.equal(interpretDom(root, theme).accessibleLabel, 'Golden source file');
	});

	it('deterministically reflects insert, remove and reorder without retaining an old snapshot', () => {
		const root = fixture();
		const [name, hidden, detail] = [...root.children];
		const first = interpretDom(root, theme);
		root.removeChild(hidden);
		root.replaceChildren(detail, name);
		const second = interpretDom(root, theme);
		assert.equal(first.runs.map(run => run.text).join(''), 'M alphabeta');
		assert.equal(second.runs.map(run => run.text).join(''), 'betaM alpha');
		assert.notEqual(first, second);
		assert.equal(first.runs.map(run => run.text).join(''), 'M alphabeta');
	});

	it('derives compressed semantic hit ranges from the same rendered record text', () => {
		const root = new TerminalElement('div');
		for (const [index, label] of ['src', 'feature', 'file.ts'].entries()) {
			const segment = new TerminalElement('a');
			segment.setAttribute('data-icon-label-index', String(index));
			if (index === 2) { segment.setAttribute('aria-label', 'TypeScript file'); }
			segment.textContent = label;
			root.append(segment);
			if (index < 2) { root.append('/'); }
		}
		const records = interpretSegmentedDom(root, theme, element => element.getAttribute('data-icon-label-index') ?? undefined);
		assert.equal(records.runs.map(run => run.text).join(''), 'src/feature/file.ts');
		assert.deepEqual(records.segments, [
			{ id: '0', start: 0, length: 3, accessibleLabel: 'src' },
			{ id: '1', start: 4, length: 7, accessibleLabel: 'feature' },
			{ id: '2', start: 12, length: 7, accessibleLabel: 'TypeScript file' }
		]);
	});

	it('applies selection/focus as projection state beneath semantic DOM styles', () => {
		const root = fixture();
		const base = { fg: Color.fromHex('#ff00ff'), bg: Color.fromHex('#112233'), bold: true };
		assert.deepEqual(projectRenderRecords(interpretDom(root, theme), base), paint(root, theme, base));
		assert.deepEqual(applyRenderState(interpretDom(root, theme), base).runs.map(({ text, style }) => ({ ...style, text })),
			paint(root, theme, base));
	});

	it('keeps repeated extraction linear and free of retained render history', () => {
		const root = fixture();
		let interpretations = 0;
		for (let index = 0; index < 20; index++) {
			root.children.item(0)!.textContent = `row-${index}`;
			const records = interpretDom(root, theme); interpretations++;
			assert.ok(records.runs.length > 0);
		}
		assert.equal(interpretations, 20);
		assert.match(interpretDom(root, theme).runs.map(run => run.text).join(''), /row-19/);
	});
});
