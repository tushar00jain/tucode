/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copied from `addons/isl/src/responsive.tsx` by `scripts/copy-from-sapling.ps1` - the widths its layout switches on. Do
// not edit: a run rewrites this file. Everything below the preamble is upstream's text,
// unchanged; ``saplingViewPane.ts`` compares them against the pane, where upstream compares a ``ResizeObserver`` on its main content area.


export const NARROW_COMMIT_TREE_WIDTH = 800;
export const NARROW_COMMIT_TREE_WIDTH_WHEN_COMPACT = 300;
