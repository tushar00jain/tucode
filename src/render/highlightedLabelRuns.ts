import type { IMatch } from '../vs/base/common/filters.js';
import type { IDomRenderRun, IRenderStyle } from './domRecords.js';

/** HighlightedLabel.render's substring walk, emitting native runs instead of DOM spans. */
export function highlightedLabelRuns(text: string, highlights: readonly IMatch[], style: IRenderStyle, highlightStyle: IRenderStyle): IDomRenderRun[] {
	const children: IDomRenderRun[] = [];
	let pos = 0;
	for (const highlight of highlights) {
		if (highlight.end === highlight.start) { continue; }
		if (pos < highlight.start) {
			children.push({ text: text.substring(pos, highlight.start), style });
			pos = highlight.start;
		}
		children.push({ text: text.substring(pos, highlight.end), style: { ...style, ...highlightStyle } });
		pos = highlight.end;
	}
	if (pos < text.length) { children.push({ text: text.substring(pos), style }); }
	return children;
}
