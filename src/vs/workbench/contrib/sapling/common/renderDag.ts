/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copied from `addons/isl/src/RenderDag.tsx` by `scripts/copy-from-sapling.ps1` - the declarations in it that owe nothing to React. Do
// not edit: a run rewrites this file. Everything below the preamble is upstream's text,
// unchanged; ``saplingRowRenderer.ts`` is where the components around it are rebuilt against the DOM.

import { LinkLine } from './render.js';
/**
 * Represent a line within a box (-1,-1) to (1,1).
 * For example, x1=0, y1=-1, x2=0, y2=1 draws a vertical line in the middle.
 * Default x y values are 0.
 * Flag can be used to draw special lines.
 */
export type Edge = {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  flag?: number;
  color?: string;
};

export enum EdgeFlag {
  Dash = 1,
  IntersectGap = 2,
}

const defaultTileWidth = 20;
const defaultStrokeWidth = 2;

const YOU_ARE_HERE_COLOR = 'var(--button-primary-hover-background)';
const DEFAULT_GLYPH_RADIUS = (defaultTileWidth * 7) / 20;

function linkLineToEdges(linkLine: LinkLine, color?: string, colorLine?: LinkLine): Edge[] {
  const bits = linkLine.valueOf();
  const colorBits = colorLine?.valueOf() ?? 0;
  const edges: Edge[] = [];
  const considerEdge = (parentBits: number, ancestorBits: number, edge: Partial<Edge>) => {
    const present = (bits & (parentBits | ancestorBits)) !== 0;
    const useColor = (colorBits & (parentBits | ancestorBits)) !== 0;
    const dashed = (bits & ancestorBits) !== 0;
    if (present) {
      const flag = edge.flag ?? 0 | (dashed ? EdgeFlag.Dash : 0);
      edges.push({...edge, flag, color: useColor ? color : undefined});
    }
  };
  considerEdge(LinkLine.VERT_PARENT, LinkLine.VERT_ANCESTOR, {
    y1: -10,
    y2: 10,
    flag: bits & (LinkLine.HORIZ_PARENT | LinkLine.HORIZ_ANCESTOR) ? EdgeFlag.IntersectGap : 0,
  });
  considerEdge(LinkLine.HORIZ_PARENT, LinkLine.HORIZ_ANCESTOR, {x1: -10, x2: 10});
  considerEdge(LinkLine.LEFT_MERGE_PARENT, LinkLine.LEFT_MERGE_ANCESTOR, {x1: -10, y2: -10});
  considerEdge(LinkLine.RIGHT_MERGE_PARENT, LinkLine.RIGHT_MERGE_ANCESTOR, {x1: 10, y2: -10});
  considerEdge(LinkLine.LEFT_FORK_PARENT | LinkLine.LEFT_FORK_ANCESTOR, 0, {x1: -10, y2: 10});
  considerEdge(LinkLine.RIGHT_FORK_PARENT | LinkLine.RIGHT_FORK_ANCESTOR, 0, {x1: 10, y2: 10});
  return edges;
}

function authorToSvgPatternId(author: string) {
  return 'avatar-pattern-' + author.replace(/[^A-Z0-9a-z]/g, '_');
}

export { defaultTileWidth, defaultStrokeWidth, YOU_ARE_HERE_COLOR, DEFAULT_GLYPH_RADIUS, linkLineToEdges, authorToSvgPatternId };
