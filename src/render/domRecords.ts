import { Color } from '../vs/base/common/color.js';
import { blend } from './colors.js';

export interface IRenderStyle {
	readonly fg?: Color;
	readonly bg?: Color;
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
}
export interface IDomRenderRun { readonly text: string; readonly style: IRenderStyle }
export interface IDomRenderRecords { readonly root: IRenderStyle; readonly runs: readonly IDomRenderRun[]; readonly accessibleLabel: string }
export interface IDomRenderSegment { readonly id: string; readonly actionId?: string; readonly start: number; readonly length: number; readonly accessibleLabel: string }
export interface ISegmentedDomRenderRecords extends IDomRenderRecords { readonly segments: readonly IDomRenderSegment[] }

/** Converts an already-semantic span line without introducing a frontend-owned interpreter. */
export function lineRenderRecords(line: readonly ({ readonly text: string; readonly accessibleLabel?: string; readonly actionId?: string } & IRenderStyle)[]): ISegmentedDomRenderRecords {
	let offset = 0;
	const segments: IDomRenderSegment[] = [];
	for (const span of line) {
		if (span.actionId) {
			const previous = segments.at(-1);
			if (previous?.actionId === span.actionId && previous.start + previous.length === offset) {
				segments[segments.length - 1] = { ...previous, length: previous.length + span.text.length,
					accessibleLabel: previous.accessibleLabel + (span.accessibleLabel ?? span.text) };
			} else {
				segments.push({ id: `pane-header:${span.actionId}`, actionId: span.actionId, start: offset,
					length: span.text.length, accessibleLabel: span.accessibleLabel ?? span.text });
			}
		}
		offset += span.text.length;
	}
	return Object.freeze({ root: Object.freeze({}), runs: Object.freeze(line.map(({ text, accessibleLabel: _accessibleLabel, actionId: _actionId, ...style }) =>
		Object.freeze({ text, style: Object.freeze(style) }))), accessibleLabel: line.map(span => span.accessibleLabel ?? span.text).join(''),
		segments: Object.freeze(segments.map(segment => Object.freeze(segment))) });
}

/** ANSI's scalar span projection of immutable render records. */
export function renderRecordsLine(records: IDomRenderRecords): readonly ({ readonly text: string } & IRenderStyle)[] {
	return Object.freeze(records.runs.map(run => Object.freeze({ text: run.text, ...run.style })));
}

/** Applies a base style while retaining the immutable render-record shape. */
export function applyRenderState(records: IDomRenderRecords, base: IRenderStyle = {}): IDomRenderRecords {
	return Object.freeze({ root: Object.freeze({ ...records.root, ...base }), runs: Object.freeze(projectRenderRecords(records, base)
		.map(({ text, ...style }) => Object.freeze({ text, style: Object.freeze(style) }))), accessibleLabel: records.accessibleLabel });
}

/** Minimal DOM shape needed to derive semantic accessible text without owning a DOM implementation. */
export interface IAccessibleTextNode {
	readonly nodeType: number;
	readonly data?: string;
	readonly childNodes?: readonly IAccessibleTextNode[];
	readonly classList?: { contains(name: string): boolean };
	getAttribute?(name: string): string | null;
}

/**
 * The single semantic text walk for render records. CSS-generated icon glyphs are never content;
 * explicit labels win, and DOM-hidden/decorative/icon spans contribute no spoken text.
 */
export function accessibleText(node: IAccessibleTextNode, hidden: (node: IAccessibleTextNode) => boolean = () => false): string {
	if (node.nodeType === 3) { return node.data ?? ''; }
	if (hidden(node) || node.getAttribute?.('aria-hidden') === 'true') { return ''; }
	const explicit = node.getAttribute?.('aria-label');
	if (explicit !== null && explicit !== undefined) { return explicit; }
	if (node.classList?.contains('codicon') || node.classList?.contains('icon')) { return ''; }
	return [...(node.childNodes ?? [])].map(child => accessibleText(child, hidden)).join('');
}

/** Applies frontend row state beneath already-resolved semantic DOM styles. */
export function projectRenderRecords(records: IDomRenderRecords, base: IRenderStyle = {}): readonly (IRenderStyle & { readonly text: string })[] {
	return records.runs.map(({ text, style }) => {
		const bg = blend(style.bg, base.bg) ?? base.bg;
		const fg = blend(style.fg, bg) ?? base.fg;
		const projected = {
			...base, ...style, fg, bg,
			bold: style.bold ?? base.bold, dim: style.dim ?? base.dim, italic: style.italic ?? base.italic,
			underline: style.underline ?? base.underline, strikethrough: style.strikethrough ?? base.strikethrough
		};
		return { ...projected, text };
	});
}
