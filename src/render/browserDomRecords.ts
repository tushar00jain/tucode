/*---------------------------------------------------------------------------------------------
 * Mechanical serialization of browser-rendered DOM for a non-DOM painter.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../vs/base/common/color.js';
import type { IDomRenderRecords, IDomRenderRun, IRenderStyle } from './domRecords.js';

function color(value: string): Color | undefined {
	if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') { return undefined; }
	try { return Color.Format.CSS.parse(value) ?? undefined; } catch { return undefined; }
}

function styleOf(element: Element, pseudo?: '::before' | '::after'): IRenderStyle {
	const style = getComputedStyle(element, pseudo);
	return Object.freeze({
		fg: color(style.color),
		bg: color(style.backgroundColor),
		bold: Number.parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === 'bold' || undefined,
		dim: Number.parseFloat(style.opacity) < 1 || undefined,
		italic: style.fontStyle === 'italic' || undefined,
		underline: style.textDecorationLine.includes('underline') || undefined,
		strikethrough: style.textDecorationLine.includes('line-through') || undefined
	});
}

function pseudoText(element: Element, pseudo: '::before' | '::after'): string {
	const content = getComputedStyle(element, pseudo).content;
	if (!content || content === 'none' || content === 'normal') { return ''; }
	if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) {
		return content.slice(1, -1);
	}
	return content;
}

function append(runs: IDomRenderRun[], text: string, style: IRenderStyle): void {
	if (!text) { return; }
	const previous = runs.at(-1);
	if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) {
		runs[runs.length - 1] = Object.freeze({ text: previous.text + text, style });
	} else {
		runs.push(Object.freeze({ text, style }));
	}
}

/** Converts exactly what VS Code's browser renderer wrote; it owns no row semantics. */
export function browserDomRenderRecords(root: HTMLElement): IDomRenderRecords {
	const runs: IDomRenderRun[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			append(runs, node.textContent ?? '', styleOf(node.parentElement ?? root));
			return;
		}
		if (!(node instanceof Element)) { return; }
		const computed = getComputedStyle(node);
		if (computed.display === 'none' || computed.visibility === 'hidden'
			|| node.getAttribute('aria-hidden') === 'true') { return; }
		append(runs, pseudoText(node, '::before'), styleOf(node, '::before'));
		for (const child of node.childNodes) { walk(child); }
		append(runs, pseudoText(node, '::after'), styleOf(node, '::after'));
	};
	walk(root);
	return Object.freeze({
		root: styleOf(root),
		runs: Object.freeze(runs),
		accessibleLabel: root.getAttribute('aria-label') ?? root.textContent ?? ''
	});
}
