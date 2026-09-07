/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { relativeDate } from '../common/relativeDate.js';
import { ExtendedGraphRow, NodeLine, PadLine } from '../common/render.js';
import { DEFAULT_GLYPH_RADIUS, Edge, EdgeFlag, YOU_ARE_HERE_COLOR, defaultStrokeWidth, defaultTileWidth, linkLineToEdges } from '../common/renderDag.js';
import { CommitInfo, SuccessorInfo } from '../common/types.js';
import { ISaplingRow } from './saplingDagModel.js';

/**
 * `RenderDag.tsx` and `Commit.tsx` in `addons/isl`, rebuilt against the DOM: the same element
 * tree, the same class names, and — through `../common/renderDag.ts` — the same geometry, so
 * that the stylesheets copied beside it into `../media/` are what styles the result.
 *
 * Every row is built and left in the document, as `RenderDag` leaves it: a smartlog is bounded
 * by construction — the interesting bookmarks, the draft heads and "." — so upstream renders
 * the whole of it and nothing states a row's height in advance. A row is as tall as its commit
 * body, and the `.grow` pad lines above and below the node grow into it.
 */

/** Y scales upstream passes each kind of line at its call site. Height is `defaultTileWidth * scaleY`. */
const PAD_SCALE_Y = 0.1;
const STACK_PADDING_SCALE_Y = 0.3;
const TERM_PAD_SCALE_Y = 0.25;
const ANCESTRY_SCALE_Y = 0.6;

/** The scale `DagRowInner` gives the node line beside an irregular glyph, which sets its own height. */
const IRREGULAR_SCALE_Y = 0.5;

interface ITileOptions {
	/** Y scale. Default 1. Decides height. */
	readonly scaleY?: number;
	/** Take the height of the flex parent, with `defaultTileWidth * scaleY` as the minimum. */
	readonly stretchY?: boolean;
	/** Dash array. Default '3,2'. */
	readonly strokeDashArray?: string;
	/** Extra SVG children, drawn inside the stroked group. */
	readonly children?: SVGElement[];
}

/**
 * A tile is a rectangle with edges in it — `TileInner` in `RenderDag.tsx`, including the gap fix
 * that closes the seams scaling and non-integer rounding leave between adjacent tiles.
 */
function tile(edges: readonly Edge[], options: ITileOptions = {}): SVGElement {
	const { scaleY = 1, stretchY = false, strokeDashArray = '3,2', children = [] } = options;
	const height = defaultTileWidth * scaleY;

	// Fill the gap caused by scaling, non-integer rounding.
	// When 'x' is at the border (abs >= 10) and 'y' is at the center, use the "gap fix".
	const getGapFix = (x: number, y: number) => y === 0 && Math.abs(x) >= 10 ? 0.5 * Math.sign(x) : 0;

	const paths = edges.map(({ x1 = 0, y1 = 0, x2 = 0, y2 = 0, flag = 0, color }) => {
		const fx1 = getGapFix(x1, y1);
		const fx2 = getGapFix(x2, y2);
		const fy1 = getGapFix(y1, x1);
		const fy2 = getGapFix(y2, x2);

		const sY = scaleY;
		let d: string;
		if (flag & EdgeFlag.IntersectGap) {
			// This vertical line intersects with a horizontal line visually but it does not mean
			// they connect. Leave a small gap in the middle.
			d = `M ${x1 + fx1} ${y1 * sY + fy1} L 0 -2 M 0 2 L ${x2 + fx2} ${y2 * sY + fy2}`;
		} else if (y1 === y2 || x1 === x2) {
			// Straight line (-----).
			d = `M ${x1 + fx1} ${y1 * sY + fy1} L ${x2 + fx2} ${y2 * sY + fy2}`;
		} else {
			// Curved line (towards center).
			d = `M ${x1 + fx1} ${y1 * sY + fy1} L ${x1} ${y1 * sY} Q 0 0 ${x2} ${y2 * sY} L ${x2 + fx2} ${y2 * sY + fy2}`;
		}

		return $.SVG<SVGPathElement>('path', {
			d,
			'stroke-dasharray': flag & EdgeFlag.Dash ? strokeDashArray : undefined,
			stroke: color
		});
	});

	const group = $.SVG<SVGGElement>('g', { stroke: 'var(--foreground)', fill: 'none', 'stroke-width': defaultStrokeWidth }, ...paths, ...children);
	// The class goes through the attribute map, not the emmet description: `$.SVG` shares
	// `_$` with `$`, which assigns `element.className` — read-only on an SVG element, so a
	// class in the description throws and takes the whole row's render with it.
	const svg = $.SVG<SVGSVGElement>('svg', {
		class: 'render-dag-tile',
		viewBox: `-10 -${scaleY * 10} 20 ${scaleY * 20}`,
		height,
		width: defaultTileWidth,
		preserveAspectRatio: stretchY || scaleY < 1 ? 'none' : undefined
	}, group);

	if (stretchY) {
		svg.style.height = '100%';
		svg.style.minHeight = `${height}px`;
	}

	return svg;
}

/** `NodeTile` in `RenderDag.tsx`. */
function nodeTile(line: NodeLine, row: ExtendedGraphRow, glyph: SVGElement | undefined, aboveNodeColor: string | undefined, options: ITileOptions = {}): SVGElement {
	switch (line) {
		case NodeLine.Ancestor:
			return tile([{ y1: -10, y2: 10, flag: EdgeFlag.Dash }], options);
		case NodeLine.Parent:
			// 10.5 is used instead of 10 to avoid small gaps when the page is zoomed.
			return tile([{ y1: -10, y2: 10.5 }], options);
		case NodeLine.Node: {
			const edges: Edge[] = [];
			if (!row.isHead) {
				edges.push({ y1: -10.5, color: aboveNodeColor });
			}
			if (!row.isRoot) {
				edges.push({ y2: 10.5 });
			}
			return tile(edges, { ...options, children: glyph ? [glyph] : [] });
		}
		default:
			return tile([], options);
	}
}

/** `PadTile` in `RenderDag.tsx`. */
function padTile(line: PadLine, options: ITileOptions & { color?: string } = {}): SVGElement {
	switch (line) {
		case PadLine.Ancestor:
			return tile([{ y1: -10, y2: 10, flag: EdgeFlag.Dash, color: options.color }], options);
		case PadLine.Parent:
			return tile([{ y1: -10, y2: 10, color: options.color }], options);
		default:
			return tile([], options);
	}
}

/** `TermTile` in `RenderDag.tsx` — the "~" of an anonymous parent. */
function termTile(): SVGElement {
	return tile([], {
		children: [
			$.SVG<SVGPathElement>('path', { d: 'M 0 -10 L 0 -5', 'stroke-dasharray': '3,2' }),
			$.SVG<SVGPathElement>('path', { d: 'M -7 -5 Q -3 -8, 0 -5 T 7 -5' })
		]
	});
}

/** `RegularGlyphInner` in `RenderDag.tsx`, without the avatar patterns this port has no source for. */
function glyphFor(info: CommitInfo): SVGElement[] {
	const stroke = info.isDot ? YOU_ARE_HERE_COLOR : 'var(--foreground)';
	const strokeWidth = defaultStrokeWidth * 0.9;
	const isObsoleted = info.successorInfo !== undefined;

	// Upstream fills a draft commit's disc with its author's avatar; with no avatar source the
	// disc is left hollow instead, which is what keeps a draft distinguishable from a public
	// commit — and what makes the obsoleted "/" inside it readable.
	let fill = info.phase === 'draft' ? 'var(--background)' : 'var(--foreground)';
	const elements: SVGElement[] = [];

	if (info.phase === 'draft' && isObsoleted) {
		// "/" inside the circle (similar to "x" in CLI) to indicate "obsoleted".
		fill = 'var(--background)';
		const pos = DEFAULT_GLYPH_RADIUS / Math.sqrt(2) - strokeWidth;
		elements.push($.SVG<SVGPathElement>('path', {
			d: `M ${-pos} ${pos} L ${pos} ${-pos}`,
			stroke,
			'stroke-width': strokeWidth,
			'stroke-linecap': 'round'
		}));
	}

	elements.unshift($.SVG<SVGCircleElement>('circle', { cx: 0, cy: 0, r: DEFAULT_GLYPH_RADIUS, fill, stroke, 'stroke-width': strokeWidth }));

	return elements;
}

/** One of `DagRowInner`'s left-side parts: a line of tiles under the class upstream names it by. */
function leftSideLine(name: string, ...tiles: Element[]): HTMLElement {
	return $(`.render-dag-row-left-side-line.${name}`, undefined, ...tiles);
}

/** `preNodeLinePart` and `postNodeLinePart` — the stretching pad lines that grow around the node. */
function padLine(name: string, lines: readonly PadLine[], nodeColumn: number, color: string | undefined): HTMLElement {
	const line = leftSideLine(name, ...lines.map((line, i) => padTile(line, {
		scaleY: PAD_SCALE_Y,
		stretchY: true,
		color: i === nodeColumn ? color : undefined
	})));
	// `preNodeLinePart` carries it upstream; `postNodeLinePart` does not, but the attribute is
	// inert either way and one builder emitting it keeps the two lines the same shape.
	line.dataset.nodecolumn = String(nodeColumn);
	return line;
}

/** `DivRow` in `RenderDag.tsx`. Both sides are always emitted, as upstream emits them. */
function divRow(parent: HTMLElement, className: string, hash?: string): { left: HTMLElement; right: HTMLElement } {
	const row = append(parent, $(`.render-dag-row${className}`, { 'data-commit-hash': hash }));
	return { left: append(row, $('.render-dag-row-left-side')), right: append(row, $('.render-dag-row-right-side')) };
}

/** `linkLinePart`, `termLinePart`, `stackPaddingPart` and `ancestryLinePart`, in upstream's order. */
function extraLines(row: ExtendedGraphRow, color: string | undefined): HTMLElement[] {
	const lines: HTMLElement[] = [];
	let stackPadding: HTMLElement | undefined;

	if (row.linkLine) {
		lines.push(leftSideLine('link-line',
			...row.linkLine.map((line, i) => tile(linkLineToEdges(line, color, row.linkLineFromNode?.[i])))));

		if (row.linkLine.length <= 2) {
			stackPadding = leftSideLine('stack-padding',
				// One less than the extra indent the link line normally adds.
				...row.linkLine.slice(0, -1).map(() => padTile(PadLine.Parent, { scaleY: STACK_PADDING_SCALE_Y, color })));
		}
	}

	if (row.termLine) {
		const termLine = row.termLine;
		lines.push(leftSideLine('term-line-pad',
			...termLine.map((isTerm, i) => padTile(isTerm ? PadLine.Ancestor : (row.ancestryLine.at(i) ?? PadLine.Blank), { scaleY: TERM_PAD_SCALE_Y }))));
		lines.push(leftSideLine('term-line-term',
			...termLine.map((isTerm, i) => isTerm ? termTile() : padTile(row.ancestryLine.at(i) ?? PadLine.Blank))));
	}

	// The stack padding sits *after* the term lines, not beside the link line it is derived
	// from — `DagRowInner` composes row 2 as link, term, stack padding, ancestry.
	if (stackPadding) {
		lines.push(stackPadding);
	}

	if (row.hasIndirectAncestor) {
		lines.push(leftSideLine('ancestry-line',
			...row.ancestryLine.map((line, i) => padTile(line, {
				scaleY: ANCESTRY_SCALE_Y,
				strokeDashArray: '0,2,3,0',
				color: row.parentColumns.includes(i) ? color : undefined
			}))));
	}

	return lines;
}

/**
 * A bookmark, as `Bookmark.tsx` renders one: `isl-components`' `Tag` widened by
 * `.bookmarkTag`. `sapling-remote-bookmark` carries no rules — ISL styles a local and a
 * remote bookmark identically, and only a *stable* one, which this port does not fetch,
 * differs — but it is what says which kind a row is drawing.
 */
function bookmark(name: string, remote: boolean): HTMLElement {
	return $(`span.tag.bookmarkTag${remote ? '.sapling-remote-bookmark' : ''}`, undefined, name);
}

/** `NUM_TO_SHOW` in `Bookmark.tsx`, for a row with no full-repo branch — which this port has none of. */
const NUM_BOOKMARKS_TO_SHOW = 3;

/**
 * `AllBookmarksTruncated` in `Bookmark.tsx`: the local and remote bookmarks are **one** list for
 * the purpose of truncation, three of them are rendered, and the rest collapse into a `+N more`
 * tag. Upstream hangs a tooltip column of the hidden ones off that tag; here they are the tag's
 * `title`, which is the same information without a hover component to port.
 */
function bookmarks(info: CommitInfo): HTMLElement[] {
	const all = [
		...info.bookmarks.map(name => ({ name, remote: false })),
		...info.remoteBookmarks.map(name => ({ name, remote: true }))
	];

	const shown = all.slice(0, NUM_BOOKMARKS_TO_SHOW).map(({ name, remote }) => bookmark(name, remote));
	const hidden = all.slice(NUM_BOOKMARKS_TO_SHOW);

	if (hidden.length > 0) {
		shown.push($('span.tag', { title: hidden.map(({ name }) => name).join('\n') },
			localize('sapling.moreBookmarks', "+{0} more", hidden.length)));
	}

	return shown;
}

/**
 * `SuccessorInfoToDisplay` in `Commit.tsx` — what an obsolete commit says on its second row.
 * Upstream's map, with its own fallback for a mutation nobody enumerated.
 *
 * The hover-highlight and the education tip around it are not rendered: both are ISL chrome
 * this port has no counterpart for, and neither carries information the sentence does not.
 */
function successorInfoText(successorInfo: SuccessorInfo): string {
	switch (successorInfo.type) {
		case 'pushrebase':
		case 'land':
			return localize('sapling.successor.land', "Landed as a newer commit");
		case 'amend':
			return localize('sapling.successor.amend', "Amended as a newer commit");
		case 'rebase':
			return localize('sapling.successor.rebase', "Rebased as a newer commit");
		case 'split':
			return localize('sapling.successor.split', "Split as a newer commit");
		case 'fold':
			return localize('sapling.successor.fold', "Folded as a newer commit");
		case 'histedit':
			return localize('sapling.successor.histedit', "Histedited as a newer commit");
		default:
			return localize('sapling.successor.rewritten', "Rewritten as a newer commit");
	}
}

/**
 * `Commit.tsx`'s element tree — what `renderCommit` puts on the row's right side, in upstream's
 * order: the drag target, the title, the bookmarks and the date. The bookmarks are children of
 * `.commit-details` rather than of a wrapper, because that is where `AllBookmarksTruncated` puts
 * them and where the row's gap applies.
 *
 * The drag target is emitted although nothing drags yet — it is the surface drag-to-rebase
 * attaches to, and it is part of what the copied rules lay out. The author is not rendered at
 * all, as upstream does not: it draws the author as an avatar in the glyph, and a name in its
 * place is what pushed the date off the row.
 */
function commitBody(info: CommitInfo): HTMLElement {
	const details = $('.commit-details', undefined,
		$('.commit-wide-drag-target'),
		$('span.commit-title', { title: info.description || info.title }, $('span', undefined, info.title)),
		...bookmarks(info),
		commitDate(info)
	);

	const rows = $('.commit-rows', undefined, details);

	// `DivIfChildren className="commit-second-row"`: emitted only when something fills it, which
	// here is the obsolescence sentence alone — the diff badge, the inline operation progress and
	// the diff follower beside it upstream each need a subsystem this port does not have.
	if (info.successorInfo) {
		append(rows, $('.commit-second-row', undefined, successorInfoText(info.successorInfo)));
	}

	return $(`.commit${info.isDot ? '.head-commit' : ''}${info.successorInfo ? '.obsolete' : ''}`,
		{ 'data-testid': `commit-${info.hash}` },
		rows);
}

/** `CommitDate` in `Commit.tsx`: the short relative form, with the absolute date as its tooltip. */
function commitDate(info: CommitInfo): HTMLElement {
	return $('span.commit-date', { title: info.date.toLocaleString() },
		relativeDate(info.date, { useShortVariant: true }));
}

/** The wrapper `DagRow` puts around every row group, with the attributes upstream identifies it by. */
function rowGroup(hash: string): HTMLElement {
	return $('.render-dag-row-group', { 'data-reorder-id': hash, 'data-testid': `dag-row-group-${hash}` });
}

/** `DagRowInner`'s regular layout: the commit on row 1, the lines it needs below it on row 2. */
function commitRowGroup({ info, row }: ISaplingRow): HTMLElement {
	const group = rowGroup(info.hash);

	// `DagRowInner`'s `color` is the *working copy's* colour and is undefined on every real
	// commit, so only the pre-node line and the edge above the circle take the highlight —
	// which is what keeps it to the segment between "." and the label above it.
	const dotColor = info.isDot ? YOU_ARE_HERE_COLOR : undefined;

	// Row 1: the pad lines grow around the node line, so the "o" sits at the centre of the
	// commit body no matter how tall that body is.
	const glyph = glyphFor(info);
	const { left, right } = divRow(group, '.render-dag-row-commit', info.hash);
	append(left,
		padLine('pre-node-line.grow', row.preNodeLine, row.nodeColumn, dotColor),
		leftSideLine('node-line',
			...row.nodeLine.map(line => nodeTile(line, row, line === NodeLine.Node ? $.SVG<SVGGElement>('g', undefined, ...glyph) : undefined, dotColor))),
		padLine('post-node-line.grow', row.postNodeLine, row.nodeColumn, undefined)
	);
	append(right, commitBody(info));

	// Row 2: the link, term and ancestry lines.
	const { left: extrasLeft } = divRow(group, '');
	append(extrasLeft, ...extraLines(row, undefined));

	return group;
}

/**
 * The "You are here" row — `DagRowInner`'s *irregular* layout, which is what a glyph that decides
 * its own size ('replace-tile') gets: the label takes the node's place on a row of its own, and
 * the pad line below carries the coloured edge down towards the working directory parent.
 *
 * It is a row of its own because the commit it labels is one upstream: `CommitTreeList.tsx` adds
 * `YOU_ARE_HERE_VIRTUAL_COMMIT` to the dag as a child of ".", so the curve from the label into
 * that commit's circle is the link line between the two — geometry `render.ts` derives, rather
 * than anything drawn here.
 */
function youAreHereRowGroup({ info, row }: ISaplingRow): HTMLElement {
	const group = rowGroup(info.hash);

	// `YouAreHereLabel.tsx`, with `YouAreHereGlyph`'s own offset — which pulls the label back
	// over the stroke width it replaces. Upstream titles the label from the virtual commit's
	// description and falls back to "You are here"; nothing here writes that description.
	const label = $('.you-are-here-container', { style: `margin-left: ${-defaultStrokeWidth * 1.5}px` },
		$('.inline-badge.badge-primary', undefined, info.description || localize('sapling.youAreHere', "You are here")));

	const { left: labelLeft } = divRow(group, '');
	append(labelLeft, leftSideLine('node-line',
		...row.nodeLine.map(line => line === NodeLine.Node
			? label
			: nodeTile(line, row, undefined, undefined, { scaleY: IRREGULAR_SCALE_Y, stretchY: true }))));

	const { left: padLeft } = divRow(group, '');
	append(padLeft, padLine('post-node-line.grow', row.postNodeLine, row.nodeColumn, YOU_ARE_HERE_COLOR));

	const { left: extrasLeft } = divRow(group, '');
	append(extrasLeft, ...extraLines(row, YOU_ARE_HERE_COLOR));

	return group;
}

/**
 * The graph, as `RenderDag` builds it: one `.render-dag-row-group` per row, in the order
 * `renderToRows` produced them. `SvgPatternList` has no counterpart here — it defines the avatar
 * patterns a glyph fills itself with, and this port has no avatar source.
 */
export function renderDagRows(rows: readonly ISaplingRow[]): HTMLElement[] {
	return rows.map(element => element.info.isYouAreHere ? youAreHereRowGroup(element) : commitRowGroup(element));
}
