/*---------------------------------------------------------------------------------------------
 *  The source control graph as text — the terminal counterpart of `renderSCMHistoryItemGraph`.
 *
 *  `scmHistory.ts` decides everything about the graph except the marks: `toISCMHistoryItemViewModelArray`
 *  assigns the swimlanes and their colours, and `renderSCMHistoryItemGraph` walks a row's input
 *  swimlanes deciding, per column, whether it continues, curves into another column, or is the row's
 *  own node. **That walk is the model, and this file is the same walk with a character where
 *  upstream appends an SVG path** — the branches below are in upstream's order, carrying its own
 *  comments, so a row's shape here is decided by the same conditions rather than by a second reading
 *  of what the graph looks like.
 *
 *  Two things a terminal cell cannot carry, recorded rather than approximated:
 *
 *  - **A curve is one character.** Upstream's curve spans half a row's height; a terminal row is one
 *    line, so a column that curves into another is the box-drawing glyph for that turn and the run
 *    between the two columns is a horizontal rule.
 *  - **A circle has one shape.** Upstream draws four — HEAD, incoming/outgoing changes, multi-parent
 *    and plain — out of nested circles and a dash pattern. Here HEAD is `@`, as `sl` marks the
 *    working directory parent, and every other node is `o`, which is `TextRenderer`'s own default.
 *
 *  The glyphs are `renderText.ts`'s, so the two graphs in this frontend read alike. That table is
 *  `GLYPHYS`, which ISL's file does not export — and `renderText.ts` is a verbatim copy of it, so
 *  exporting it would be an edit to a file whose whole value is that it has none.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/scm/browser/scmHistory.ts
 *--------------------------------------------------------------------------------------------*/

import { ColorIdentifier } from '../../../../platform/theme/common/colorUtils.js';
import { historyItemRefColor } from '../browser/scmHistory.js';
import { ISCMHistoryItemGraphNode, ISCMHistoryItemViewModel } from '../common/history.js';

/**
 * `box_drawing.rs`'s glyphs, as `renderText.ts` spells them: two columns per swimlane, which is what
 * leaves room for the horizontal run a curve needs.
 */
const GLYPHS = {
	SPACE: '  ',
	HORIZONTAL: '──',
	PARENT: '│ ',
	MERGE_LEFT: '╯ ',
	JOIN_RIGHT: '├─',
	JOIN_BOTH: '┼─',
	FORK_LEFT: '╮ '
} as const;

/** The node character, for the two shapes a terminal keeps of upstream's four circles. */
const NODE = { head: '@ ', node: 'o ' } as const;

/** One swimlane column of one row: two characters, in the colour that swimlane is drawn in. */
export interface ISCMHistoryTextCell {
	readonly text: string;
	readonly color?: ColorIdentifier;
}

/** `findLastIndex` in `scmHistory.ts`, which is where the remaining parents' columns come from. */
function findLastIndex(nodes: ISCMHistoryItemGraphNode[], id: string): number {
	for (let i = nodes.length - 1; i >= 0; i--) {
		if (nodes[i].id === id) {
			return i;
		}
	}

	return -1;
}

/**
 * `renderSCMHistoryItemGraph`, as cells. The `circleIndex` and `circleColor` derivations, the loop
 * over the input swimlanes, the remaining-parents pass and the node are upstream's; what each branch
 * emits is a glyph rather than a path.
 */
export function renderSCMHistoryItemGraphText(historyItemViewModel: ISCMHistoryItemViewModel): ISCMHistoryTextCell[] {
	const historyItem = historyItemViewModel.historyItem;
	const inputSwimlanes = historyItemViewModel.inputSwimlanes;
	const outputSwimlanes = historyItemViewModel.outputSwimlanes;

	// Find the history item in the input swimlanes
	const inputIndex = inputSwimlanes.findIndex(node => node.id === historyItem.id);

	// Circle index - use the input swimlane index if present, otherwise add it to the end
	const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;

	// Circle color - use the output swimlane color if present, otherwise the input swimlane color
	const circleColor = circleIndex < outputSwimlanes.length ? outputSwimlanes[circleIndex].color :
		circleIndex < inputSwimlanes.length ? inputSwimlanes[circleIndex].color : historyItemRefColor;

	const cells: ISCMHistoryTextCell[] = [];
	for (let index = 0; index < Math.max(inputSwimlanes.length, outputSwimlanes.length, circleIndex + 1); index++) {
		cells.push({ text: GLYPHS.SPACE });
	}

	/** A column, unless something is already drawn there — the paths' own overlap order. */
	const draw = (index: number, text: string, color?: ColorIdentifier) => {
		if (cells[index].text === GLYPHS.SPACE) {
			cells[index] = { text, color };
		}
	};

	/** The run a curve needs, between two columns. A crossing is the junction glyph, as it is in `sl`. */
	const rule = (from: number, to: number, color?: ColorIdentifier) => {
		for (let index = Math.min(from, to) + 1; index < Math.max(from, to); index++) {
			cells[index] = cells[index].text === GLYPHS.PARENT
				? { text: GLYPHS.JOIN_BOTH, color: cells[index].color }
				: { text: GLYPHS.HORIZONTAL, color };
		}
	};

	let outputSwimlaneIndex = 0;
	for (let index = 0; index < inputSwimlanes.length; index++) {
		const color = inputSwimlanes[index].color;

		// Current commit
		if (inputSwimlanes[index].id === historyItem.id) {
			// Base commit
			if (index !== circleIndex) {
				// Draw / and -
				draw(index, GLYPHS.MERGE_LEFT, color);
				rule(index, circleIndex, color);
			} else {
				outputSwimlaneIndex++;
			}
		} else {
			// Not the current commit
			if (outputSwimlaneIndex < outputSwimlanes.length &&
				inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id) {
				if (index === outputSwimlaneIndex) {
					// Draw |
					draw(index, GLYPHS.PARENT, color);
				} else {
					// Draw |, / and - : the column moves left into the one it joins
					draw(index, GLYPHS.MERGE_LEFT, color);
					rule(index, outputSwimlaneIndex, color);
					draw(outputSwimlaneIndex, GLYPHS.JOIN_RIGHT, color);
				}

				outputSwimlaneIndex++;
			}
		}
	}

	// Add remaining parent(s)
	for (let i = 1; i < historyItem.parentIds.length; i++) {
		const parentOutputIndex = findLastIndex(outputSwimlanes, historyItem.parentIds[i]);
		if (parentOutputIndex === -1) {
			continue;
		}

		// Draw -\
		draw(parentOutputIndex, GLYPHS.FORK_LEFT, outputSwimlanes[parentOutputIndex].color);
		rule(circleIndex, parentOutputIndex, outputSwimlanes[parentOutputIndex].color);
	}

	// Draw *
	cells[circleIndex] = {
		text: historyItemViewModel.kind === 'HEAD' ? NODE.head : NODE.node,
		color: circleColor
	};

	return cells;
}
