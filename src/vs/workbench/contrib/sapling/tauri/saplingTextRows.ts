/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/sapling/tauri/saplingRowRenderer.ts
 *--------------------------------------------------------------------------------------------*/

// Type-only, and it has to say so, for `saplingDagModel.ts`'s reason: these tests run on Node's
// type stripping rather than through a compiler.
import type { CommitInfo } from '../common/types.js';

import { relativeDate } from '../common/relativeDate.js';
import { TextRenderer } from '../common/renderText.js';
import { reservedHash, walkForRendering } from './saplingDagModel.js';

/**
 * The smartlog as lines of text — `saplingRowRenderer.ts`'s sibling for a terminal.
 *
 * **Every glyph comes out of `TextRenderer`**, which is Sapling's own translation of
 * `fbcode/eden/scm/lib/renderdag/src/box_drawing.rs` and is the renderer the ASCII smartlog `sl`
 * prints goes through. `walkForRendering` supplies the edges, exactly as it supplies them to the
 * graphical renderer, so nothing here works out a column, a curve or a dash.
 *
 * What is left for this file is the text beside the graph, which is `nextRow`'s `message`
 * argument: the three things `Commit.tsx` puts on a commit row — the title, the bookmarks and the
 * short relative date.
 */

/** One commit and the lines `TextRenderer` emitted for it. */
export interface ISaplingTextRow {
	readonly info: CommitInfo;
	readonly lines: readonly string[];
}

/**
 * The character at the node column. `TextRenderer` takes it from the caller, as `renderdag`'s Rust
 * does, and the three values are `sl`'s own rather than ours: `@` marks the working directory
 * parent, `x` an obsolete commit — which is what `RenderDag.tsx`'s comment names beside the `/` it
 * draws inside the circle instead — and `o` is `nextRow`'s own default for everything else.
 */
function glyphFor(info: CommitInfo): string {
	if (info.isDot) {
		return '@';
	}

	return info.successorInfo !== undefined ? 'x' : 'o';
}

/**
 * `Commit.tsx`'s row, as one line of text: the title, then the bookmarks, then the date, which is
 * upstream's order. The author is not on the row upstream either — it draws one as an avatar in
 * the glyph — and the date is `CommitDate`'s `relativeDate(date, { useShortVariant: true })`.
 */
function message(info: CommitInfo): string {
	return [
		info.title,
		...info.bookmarks,
		...info.remoteBookmarks,
		relativeDate(info.date, { useShortVariant: true })
	].filter(part => part.length > 0).join('  ');
}

/**
 * The smartlog, drawn. Pass `subsetForRendering`'s answer rather than the fetched list: hiding a
 * row changes which columns the rows below it claim, so the subset has to be taken first.
 */
export function renderToTextRows(commits: readonly CommitInfo[]): ISaplingTextRow[] {
	const renderer = new TextRenderer();
	const reserved = reservedHash(commits);
	if (reserved !== undefined) {
		renderer.reserve(reserved);
	}

	const rows: ISaplingTextRow[] = [];

	for (const { info, hash, parents } of walkForRendering(commits)) {
		// **The virtual working-copy row is ISL's, not `sl`'s.** A text smartlog marks "." with
		// `@` instead of putting a "You are here" badge on a row above it, and `TextRenderer`
		// takes no `NextRowOptions` — so the `forceLastColumn` that keeps that row out of the
		// commits' columns cannot cross, and rendering it anyway would move them. See `§7.4` in
		// `docs/ARCHITECTURE.md`.
		if (info.isYouAreHere) {
			continue;
		}

		// `nextRow` returns the row's lines joined by "\n", each one terminated — so the split
		// leaves a trailing empty string, and never an empty line of the graph's own.
		const text = renderer.nextRow(hash, parents, message(info), glyphFor(info));
		rows.push({ info, lines: text.split('\n').slice(0, -1) });
	}

	return rows;
}
