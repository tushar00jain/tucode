import { diffEditorDefaultOptions } from '../vs/editor/common/config/diffEditor.js';
import { OffsetRange } from '../vs/editor/common/core/ranges/offsetRange.js';
import { linesDiffComputers } from '../vs/editor/common/diff/linesDiffComputers.js';
import { DetailedLineRangeMapping, RangeMapping } from '../vs/editor/common/diff/rangeMapping.js';

export const enum Side { Original, Modified, Unchanged }
export interface IDiffRow { readonly side: Side; readonly lineNumber: number; readonly highlights: readonly OffsetRange[] }

export function computeDiff(original: string[], modified: string[]): readonly DetailedLineRangeMapping[] {
	return linesDiffComputers.getDefault().computeDiff(original, modified, {
		ignoreTrimWhitespace: diffEditorDefaultOptions.ignoreTrimWhitespace,
		maxComputationTimeMs: diffEditorDefaultOptions.maxComputationTime,
		computeMoves: diffEditorDefaultOptions.experimental.showMoves
	}).changes;
}

export function unifiedRows(changes: readonly DetailedLineRangeMapping[], modifiedLineCount: number): IDiffRow[] {
	const rows: IDiffRow[] = [];
	let modifiedLine = 1;
	const unchangedUpTo = (exclusive: number) => { for (; modifiedLine < exclusive; modifiedLine++) { rows.push({ side: Side.Unchanged, lineNumber: modifiedLine, highlights: [] }); } };
	for (const change of changes) {
		unchangedUpTo(change.modified.startLineNumber);
		for (let line = change.original.startLineNumber; line < change.original.endLineNumberExclusive; line++) { rows.push({ side: Side.Original, lineNumber: line, highlights: innerChanges(change.innerChanges, line, true) }); }
		for (let line = change.modified.startLineNumber; line < change.modified.endLineNumberExclusive; line++) { rows.push({ side: Side.Modified, lineNumber: line, highlights: innerChanges(change.innerChanges, line, false) }); }
		modifiedLine = change.modified.endLineNumberExclusive;
	}
	unchangedUpTo(modifiedLineCount + 1);
	return rows;
}

export function innerChanges(inner: readonly RangeMapping[] | undefined, line: number, original: boolean): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	for (const mapping of inner ?? []) {
		const range = original ? mapping.originalRange : mapping.modifiedRange;
		if (line < range.startLineNumber || line > range.endLineNumber) { continue; }
		const start = line === range.startLineNumber ? range.startColumn - 1 : 0;
		const end = line === range.endLineNumber ? range.endColumn - 1 : Number.MAX_SAFE_INTEGER;
		if (end > start) { ranges.push(new OffsetRange(start, end)); }
	}
	return ranges;
}
