import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Color } from '../../src/vs/base/common/color.js';
import { editorCursorForeground } from '../../src/vs/editor/common/core/editorColorRegistry.js';
import { editorBackground, editorFindMatchHighlight, editorSelectionBackground,
	diffInserted, diffInsertedLine } from '../../src/vs/platform/theme/common/colors/editorColors.js';
import type { IThemeService } from '../../src/vs/platform/theme/common/themeService.js';
import { layerTextRenderSpans, renderDiffProjectionContent, renderTextProjectionContent } from '../../src/editor/textRender.js';
import type { IDiffProjectionRow, ITextEditorProjectionSnapshot, ITextProjectionRow } from '../../src/editor/textProjection.js';

describe('projected text render layers', () => {
	const base = Color.fromHex('#101010');
	const match = Color.fromHex('#202020');
	const selection = Color.fromHex('#303030');
	const cursor = Color.fromHex('#404040');
	const foreground = Color.white;

	it('paints cursor geometry over the addressed character instead of appending it', () => {
		const line = layerTextRenderSpans([{ text: 'abc', fg: foreground, bg: base }], [
			{ ranges: [{ start: 1, end: 2 }], background: cursor }
		], base);

		assert.deepEqual(line.map(span => [span.text, span.bg]), [['a', base], ['b', cursor], ['c', base]]);
	});

	it('pads empty and end-of-line rows only as far as their projected geometry asks', () => {
		const empty = layerTextRenderSpans([{ text: '', bg: base }], [
			{ ranges: [{ start: 0, end: 1 }], background: cursor }
		], base);
		const selectedBreak = layerTextRenderSpans([{ text: 'ab', bg: base }], [
			{ ranges: [{ start: 0, end: 3 }], background: selection }
		], base);

		assert.deepEqual(empty.map(span => [span.text, span.bg]), [[' ', cursor]]);
		assert.deepEqual(selectedBreak.map(span => [span.text, span.bg]), [['ab ', selection]]);
	});

	it('keeps cursor over selection over search while preserving token styles', () => {
		const colors = new Map<unknown, Color>([
			[editorFindMatchHighlight, match], [editorSelectionBackground, selection], [editorCursorForeground, cursor]
		]);
		const themeService = { getColorTheme: () => ({ getColor: (id: unknown) => colors.get(id) }) } as unknown as IThemeService;
		const row = {
			id: 'row:1', viewLineNumber: 1, modelLineNumber: 1, lineNumber: 1, fold: 'none' as const,
			content: 'abcd',
			runs: [{ start: 0, length: 4, text: 'abcd', style: { foreground: '#ffffff', italic: true } }],
			mapping: [{ viewStart: 0, viewEnd: 4, documentStart: 0, documentEnd: 4, kind: 'linear' as const, affinity: 'both' as const }],
			searchMatches: [{ start: 0, end: 4 }],
			selections: [{ start: 1, end: 4, toEndOfLine: false }],
			carets: [{ column: 2, primary: true }]
		} satisfies ITextProjectionRow;
		const line = renderTextProjectionContent(row, { mode: 'normal' } as ITextEditorProjectionSnapshot, themeService, base);

		assert.deepEqual(line.map(span => [span.text, span.bg]), [['a', match], ['b', selection], ['c', cursor], ['d', selection]]);
		assert.ok(line.every(span => span.fg?.equals(foreground) && span.italic));
	});

	it('splits a token at exact diff inner-change columns in the shared renderer', () => {
		const line = Color.fromHex('#191919');
		const inner = Color.fromHex('#292929');
		const editor = Color.fromHex('#090909');
		const colors = new Map<unknown, Color>([
			[editorBackground, editor], [diffInsertedLine, line], [diffInserted, inner]
		]);
		const themeService = { getColorTheme: () => ({ getColor: (id: unknown) => colors.get(id) }) } as unknown as IThemeService;
		const row = {
			id: 'diff:1', sourceDocumentId: 'modified', side: 'modified' as const, marker: '+' as const,
			viewLineNumber: 1, modelLineNumber: 1, lineNumber: 1, fold: 'none' as const, content: 'abcd',
			runs: [{ start: 0, length: 4, text: 'abcd', style: { foreground: '#ffffff' } }],
			mapping: [{ viewStart: 0, viewEnd: 4, documentStart: 0, documentEnd: 4, kind: 'linear' as const, affinity: 'both' as const }],
			carets: [], selections: [], searchMatches: [],
			decorations: [{ start: 0, end: 4, kind: 'line' as const }, { start: 1, end: 3, kind: 'inner-change' as const }]
		} satisfies IDiffProjectionRow;
		const rendered = renderDiffProjectionContent(row, themeService, false);

		assert.deepEqual(rendered.spans.map(span => [span.text, span.bg]), [['a', line], ['bc', inner], ['d', line]]);
		assert.equal(rendered.background, line);
	});
});
