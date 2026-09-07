/*---------------------------------------------------------------------------------------------
 *  What an icon font's codepoint is drawn as when the frontend cannot load the font.
 *
 *  Everything a file icon theme contributes is a codepoint in an icon font's Private Use Area —
 *  `seti.woff` for the file icons, `codicon.ttf` for a decoration's bubble badge. A terminal loads
 *  no font file, so a cell holds whatever the user's own terminal font happens to have there, which is
 *  usually nothing. This is the stand-in, and the whole of it is the terminal's.
 *
 *  **Nothing imports this except the terminal's own boot**, through `workbench/iconGlyphs.ts`,
 *  which is what fills the table from the loaded theme. Importing it is the switch: its module
 *  scope installs the substitution into `style.ts`.
 *
 *  It imports nothing but `style.ts`, for the same reason `coalescingRefresh.ts` imports nothing:
 *  that is what keeps it inside `test:unit`, which strips types rather than compiling them and
 *  chokes on the first decorator it reaches.
 *
 *  Upstream counterpart: none — a browser loads the font and draws the glyph, so there is nothing
 *  upstream to stand in for it.
 *--------------------------------------------------------------------------------------------*/

import type { ICellStyle } from './style.js';

import { setGlyphSubstitution } from './style.js';

/** A glyph an icon font owns: one of seti's `fontCharacter`s, or a codicon. */
const PRIVATE_USE = /^[\ue000-\uf8ff]+$/;

/**
 * What one of those is drawn as. Seti's entries are read from the icon theme's own definitions by
 * `loadGlyphSubstitutes`; the one seeded here is the single codicon that reaches a cell —
 * `DecorationRule` writes `circle-filled` as a folder's bubble badge. A codepoint with no
 * substitute is not drawn at all, which is what every one of them did before this table existed.
 */
const substitutes = new Map<string, string>([['\uea71', '●']]);

export function addGlyphSubstitutes(entries: Iterable<readonly [string, string]>): void {
	for (const [glyph, substitute] of entries) {
		substitutes.set(glyph, substitute);
	}
}

/** `tscode.iconFont` — the user's answer, since nothing in this process can measure it. */
let iconFont = false;

export function setIconFont(present: boolean): void {
	iconFont = present;
}

/**
 * The box a terminal actually draws: the sheet's own text, unless it is a codepoint the cell has
 * no glyph for, in which case it is the stand-in — or nothing, which is a box that is not painted.
 */
export function substituteGlyphs(style: ICellStyle): ICellStyle {
	if (!iconFont && style.content && PRIVATE_USE.test(style.content)) {
		style.content = substitutes.get(style.content)!;
	}

	return style;
}

setGlyphSubstitution(substituteGlyphs);
