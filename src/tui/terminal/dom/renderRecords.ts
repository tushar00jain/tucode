/*---------------------------------------------------------------------------------------------
 *  Neutral interpretation of the shared terminal DOM.
 *
 *  This resolves cascade, hidden nodes, pseudo-elements and box separation into immutable
 *  text/style records for terminal painting.
 *--------------------------------------------------------------------------------------------*/

import type { IColorTheme } from '../../../vs/platform/theme/common/themeService.js';
import type { TerminalElement, TerminalNode, TerminalText } from './document.js';
import type { ICellStyle } from './style.js';

import { Color } from '../../../vs/base/common/color.js';
import { asCssVariableName, getColorRegistry } from '../../../vs/platform/theme/common/colorUtils.js';
import { blend } from '../../../render/colors.js';
import { accessibleText } from '../../../render/domRecords.js';
import type { IDomRenderRun, IDomRenderRecords, IDomRenderSegment, IRenderStyle, ISegmentedDomRenderRecords } from '../../../render/domRecords.js';
export type { IDomRenderRun, IDomRenderRecords, IDomRenderSegment, IRenderStyle, ISegmentedDomRenderRecords } from '../../../render/domRecords.js';
export { projectRenderRecords } from '../../../render/domRecords.js';
import { resolvePseudo, resolveStyle } from './style.js';


/** A semantic span line as the same immutable frontend-neutral record used by DOM renderers. */
export { lineRenderRecords } from '../../../render/domRecords.js';

let identifiers: Map<string, string> | undefined;
const VARIABLE = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/;

function colorIdentifier(variable: string): string | undefined {
	identifiers ??= new Map(getColorRegistry().getColors().map(color => [asCssVariableName(color.id), color.id]));
	return identifiers.get(variable);
}

export function colorOf(value: string | undefined, theme: IColorTheme): Color | undefined {
	if (!value) { return undefined; }
	const variable = VARIABLE.exec(value);
	if (variable) {
		const identifier = colorIdentifier(variable[1]);
		return (identifier ? theme.getColor(identifier) : undefined) ?? colorOf(variable[2]?.trim(), theme);
	}
	if (!/^(#|rgba?\()/.test(value)) { return undefined; }
	try { return Color.Format.CSS.parse(value) ?? undefined; } catch { return undefined; }
}

export function mergeRenderStyle(inherited: IRenderStyle, cell: ICellStyle, theme: IColorTheme): IRenderStyle {
	const bg = blend(colorOf(cell.background, theme), inherited.bg) ?? inherited.bg;
	return {
		fg: blend(colorOf(cell.color, theme), bg) ?? inherited.fg,
		bg,
		bold: cell.bold ?? inherited.bold,
		dim: cell.dim ?? inherited.dim,
		italic: cell.italic ?? inherited.italic,
		underline: cell.underline ?? inherited.underline,
		strikethrough: cell.strikethrough ?? inherited.strikethrough
	};
}

function separate(runs: IDomRenderRun[], style: IRenderStyle): void {
	const last = runs[runs.length - 1];
	if (last && !last.text.endsWith(' ')) { runs.push({ style, text: ' ' }); }
}

function pseudo(element: TerminalElement, at: 'before' | 'after', theme: IColorTheme,
	inherited: IRenderStyle, runs: IDomRenderRun[]): void {
	const style = resolvePseudo(element, at);
	if (!style || style.hidden) { return; }
	if (style.spaceBefore) { separate(runs, inherited); }
	runs.push({ style: mergeRenderStyle(inherited, style, theme), text: style.content! });
	if (style.spaceAfter) { separate(runs, inherited); }
}

function walk(node: TerminalNode, theme: IColorTheme, inherited: IRenderStyle, runs: IDomRenderRun[]): void {
	if (node.nodeType === 3) {
		const text = (node as TerminalText).data;
		if (text) { runs.push({ style: inherited, text }); }
		return;
	}
	const element = node as TerminalElement;
	const style = resolveStyle(element);
	if (style.hidden) { return; }
	const start = runs.length;
	if (style.spaceBefore) { separate(runs, inherited); }
	const painted = runs.length;
	const inner = mergeRenderStyle(inherited, style, theme);
	pseudo(element, 'before', theme, inner, runs);
	for (const child of element.childNodes) { walk(child, theme, inner, runs); }
	pseudo(element, 'after', theme, inner, runs);
	if (runs.length === painted) { runs.length = start; return; }
	if (style.spaceAfter) { separate(runs, inherited); }
}

export function interpretDom(element: TerminalElement, theme: IColorTheme, base: IRenderStyle = {}): IDomRenderRecords {
	const root = mergeRenderStyle(base, resolveStyle(element), theme);
	if (resolveStyle(element).hidden) { return { root, runs: [], accessibleLabel: '' }; }
	const runs: IDomRenderRun[] = [];
	walk(element, theme, base, runs);
	return { root, runs, accessibleLabel: accessibleText(element, node => node.nodeType !== 3 && !!resolveStyle(node as TerminalElement).hidden) };
}

/**
 * The same single walk plus stable semantic hit ranges. `segmentId` identifies only elements the
 * shared renderer marked (compressed Explorer label anchors); projectors never parse label text.
 */
export function interpretSegmentedDom(element: TerminalElement, theme: IColorTheme,
	segmentId: (element: TerminalElement) => string | undefined, base: IRenderStyle = {}): ISegmentedDomRenderRecords {
	const records = interpretDom(element, theme, base);
	const segments: IDomRenderSegment[] = [];
	const text = records.runs.map(run => run.text).join('');
	let cursor = 0;
	const visit = (node: TerminalNode): void => {
		if (node.nodeType === 3) { return; }
		const child = node as TerminalElement;
		const id = segmentId(child);
		if (id) {
			const rendered = interpretDom(child, theme, base).runs.map(run => run.text).join('');
			const start = text.indexOf(rendered, cursor);
			if (start >= 0) {
				segments.push(Object.freeze({ id, start, length: rendered.length,
					accessibleLabel: accessibleText(child, node => node.nodeType !== 3 && !!resolveStyle(node as TerminalElement).hidden) }));
				cursor = start + rendered.length;
			}
			return;
		}
		for (const nested of child.childNodes) { visit(nested); }
	};
	visit(element);
	return Object.freeze({ root: records.root, runs: records.runs, accessibleLabel: records.accessibleLabel, segments: Object.freeze(segments) });
}
