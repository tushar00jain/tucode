import { Color } from '../vs/base/common/color.js';
import { editorCursorForeground, editorLineHighlight } from '../vs/editor/common/core/editorColorRegistry.js';
import { editorBackground, editorFindMatchHighlight, editorSelectionBackground,
	diffInserted, diffInsertedLine, diffRemoved, diffRemovedLine } from '../vs/platform/theme/common/colors/editorColors.js';
import type { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { blend } from '../render/colors.js';
import type { IDiffProjectionRow, ITextEditorProjectionSnapshot, ITextProjectionRow } from './textProjection.js';

export interface ITextRenderSpan {
	readonly text: string;
	readonly fg?: Color;
	readonly bg?: Color;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
}

export type ITextRenderLine = readonly ITextRenderSpan[];

export interface ITextRenderRange {
	readonly start: number;
	readonly end: number;
}

export interface ITextRenderLayer {
	readonly ranges: readonly ITextRenderRange[];
	readonly background: Color | undefined;
}

export interface IDiffRenderContent {
	readonly spans: readonly ITextRenderSpan[];
	readonly background: Color | undefined;
}

function color(value: string | undefined): Color | undefined {
	if (!value) { return undefined; }
	try { return Color.Format.CSS.parse(value) ?? undefined; } catch { return undefined; }
}

/**
 * A projected text row's content, including the editor layers shared by every frontend. The
 * frontend supplies only the already-resolved row background: terminal cells, native attributed
 * strings and any later renderer can project these same spans into their own output protocol.
 */
export function renderTextProjectionContent(
	row: Readonly<ITextProjectionRow>,
	projection: Readonly<ITextEditorProjectionSnapshot>,
	themeService: IThemeService,
	rowBackground?: Color
): ITextRenderSpan[] {
	const content = row.runs.map(run => ({
		text: run.text,
		fg: color(run.style.foreground),
		bg: color(run.style.background) ?? rowBackground,
		bold: run.style.bold,
		italic: run.style.italic,
		underline: run.style.underline,
		strikethrough: run.style.strikethrough
	}));
	if (projection.mode === 'viewer') { return content; }

	const theme = themeService.getColorTheme();
	return layerTextRenderSpans(content, [
		{ ranges: row.searchMatches, background: theme.getColor(editorFindMatchHighlight) },
		{ ranges: row.selections.map(selection => ({
			start: selection.start,
			end: selection.toEndOfLine ? row.content.length + 1 : selection.end
		})), background: blend(theme.getColor(editorSelectionBackground), rowBackground ?? theme.getColor(editorBackground)) },
		{ ranges: row.carets.filter(caret => caret.primary).map(caret => ({ start: caret.column, end: caret.column + 1 })),
			background: theme.getColor(editorCursorForeground) }
	], rowBackground);
}

/** Diff line/inner-change composition shared by every frontend. */
export function renderDiffProjectionContent(
	row: Readonly<IDiffProjectionRow>,
	themeService: IThemeService,
	focused: boolean
): IDiffRenderContent {
	const theme = themeService.getColorTheme();
	const removed = row.side === 'original';
	const changed = row.side !== 'unchanged';
	const line = changed ? theme.getColor(removed ? diffRemovedLine : diffInsertedLine) : undefined;
	const inner = changed ? theme.getColor(removed ? diffRemoved : diffInserted) : undefined;
	const base = blend(line, theme.getColor(editorBackground)) ?? theme.getColor(editorBackground);
	const background = focused ? blend(activeLineHighlight(themeService), base) : line && base;
	const content = row.runs.map(run => ({
		text: run.text,
		fg: color(run.style.foreground),
		bg: background,
		bold: run.style.bold,
		italic: run.style.italic,
		underline: run.style.underline,
		strikethrough: run.style.strikethrough
	}));
	const highlight = blend(inner, base);
	const ranges = row.decorations.filter(decoration => decoration.kind === 'inner-change');
	return Object.freeze({ spans: Object.freeze(layerTextRenderSpans(content, [{ ranges, background: highlight }], background)), background });
}

/**
 * Paint column-addressed backgrounds over token runs, padding the row when a caret or a selection
 * reaches the virtual cell after its text. Later layers win, so a caret remains visible inside a
 * selection and a selection remains visible over a search match.
 */
export function layerTextRenderSpans(
	spans: readonly ITextRenderSpan[],
	layers: readonly ITextRenderLayer[],
	paddingBackground?: Color
): ITextRenderSpan[] {
	const visible = layers.filter(layer => layer.background && layer.ranges.some(range => range.end > range.start));
	if (!visible.length) {
		return [...spans];
	}

	const width = spans.reduce((total, span) => total + span.text.length, 0);
	const asked = Math.max(width, ...visible.flatMap(layer => layer.ranges.map(range => range.end)));
	const source = asked > width ? [...spans, { text: ' '.repeat(asked - width), bg: paddingBackground }] : spans;
	const result: ITextRenderSpan[] = [];
	let offset = 0;

	for (const span of source) {
		for (const character of span.text) {
			const bg = visible.reduce<Color | undefined>((current, layer) =>
				layer.ranges.some(range => range.start <= offset && offset < range.end) ? layer.background : current, span.bg);
			const next = { ...span, text: character, bg };
			const previous = result[result.length - 1];
			if (previous && sameTextRenderStyle(previous, next)) {
				result[result.length - 1] = { ...previous, text: previous.text + character };
			} else {
				result.push(next);
			}
			offset += character.length;
		}
	}

	return result;
}

function sameTextRenderStyle(left: ITextRenderSpan, right: ITextRenderSpan): boolean {
	return left.fg === right.fg && left.bg === right.bg && left.bold === right.bold && left.italic === right.italic
		&& left.underline === right.underline && left.strikethrough === right.strikethrough;
}

export function activeLineHighlight(themeService: IThemeService): Color | undefined {
	return themeService.getColorTheme().getColor(editorLineHighlight);
}
