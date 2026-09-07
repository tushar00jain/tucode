/*---------------------------------------------------------------------------------------------
 *  Upstream's stylesheets, read for the part of them a cell can carry.
 *
 *  Running upstream's renderers produces upstream's class names, and T01 deleted the 286
 *  stylesheets that gave them meaning. They come back **verbatim** from `vendor`, at their
 *  upstream paths, and arrive here through the `import '../../dom/media/*.css'` every widget already
 *  carries — `bin/bundler-imports.mjs` turns that import into a call to `addStylesheet`. So the
 *  values are upstream's and track it on re-copy, rather than being a table of ours: the eight
 *  sheets behind the row stack hold 293 rules, of which 134 carry a declaration with cell meaning.
 *
 *  Two things are interpreted, and everything else is ignored the way `node/` code is ignored:
 *  the selector subset in `selector.ts`, and the eleven declarations below. The `:hover` rules
 *  describe gestures neither frontend has a form for, so skipping them is the design rather than a
 *  gap.
 *
 *  A `<style>` element's `sheet` lands here too, which is what makes `createCSSRule` — the way
 *  `DecorationStyles` publishes a decoration's colour and badge — reach a row.
 *
 *  Upstream counterpart: none — stands in for the browser's CSSOM and cascade, over upstream's own stylesheets restored from `vendor`.
 *--------------------------------------------------------------------------------------------*/

import type { TerminalElement } from './document.js';
import type { ISelector, Pseudo } from './selector.js';

import { camelCase } from './document.js';
import { unescapeCss as unescape } from '../../../render/css.js';
import { matchesSelector, parseSelector } from './selector.js';

/** What a declaration can mean in a cell. Colours stay as written; `paint.ts` resolves them. */
export interface ICellStyle {
	color?: string;
	background?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	dim?: boolean;
	/** `display: none` or `visibility: hidden` — the subtree is not painted at all. */
	hidden?: boolean;
	/** Kept separate during cascade: display cannot override visibility, or conversely. */
	displayNone?: boolean;
	visibilityHidden?: boolean;
	/**
	 * Whether the sheet puts horizontal space on this element's left or right. It is a **presence
	 * toggle**, not a second px→cell conversion: a terminal separates two boxes by one column or by
	 * none, so `margin-left: 6px` and `margin-left: 0.5em` both mean *one space*. Without it the
	 * count badge upstream separates by margin lands as `Changes45`, since a multi-element row
	 * carries every one of its gaps in the stylesheet and none of them in its text.
	 */
	spaceBefore?: boolean;
	spaceAfter?: boolean;
	/** `content`, on a `::before` or `::after` rule. Text, or an icon font's codepoint. */
	content?: string;
}

interface IRule {
	readonly selector: ISelector;
	readonly style: ICellStyle;
	readonly order: number;
}

/**
 * Rules bucketed on the rightmost compound's most selective part, so an element considers the
 * handful of rules that could name it rather than all 293.
 */
const buckets = new Map<string, IRule[]>();
const ANY = '*';
let order = 0;

/** Declarations with no cell meaning, applied to `target`. Returns whether any of them had one. */
function interpret(target: ICellStyle, property: string, value: string): boolean {
	switch (property) {
		case 'color':
			return assignColour(target, 'color', value);
		case 'background':
		case 'background-color':
			return assignColour(target, 'background', value);
		case 'font-weight':
			target.bold = value === 'bold' || value === 'bolder' || Number(value) >= 600;

			return true;
		case 'font-style':
			target.italic = value === 'italic' || value === 'oblique';

			return true;
		case 'text-decoration':
		case 'text-decoration-line':
			target.underline = value.includes('underline');
			target.strikethrough = value.includes('line-through');

			return true;
		case 'opacity':
			target.dim = Number(value) < 1;

			return true;
		case 'margin':
		case 'padding': {
			// `margin: t r b l`, and the 1-, 2- and 3-value forms CSS folds into it.
			const sides = value.split(/\s+/);
			const [right, left] = sides.length === 1 ? [sides[0], sides[0]] : [sides[1], sides[3] ?? sides[1]];

			return separate(target, left, right);
		}
		case 'margin-left':
		case 'padding-left':
			return separate(target, value, undefined);
		case 'margin-right':
		case 'padding-right':
			return separate(target, undefined, value);
		case 'display':
			if (!['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid'].includes(value)) {
				return false;
			}
			target.displayNone = value === 'none';

			return true;
		case 'visibility':
			if (value !== 'hidden' && value !== 'visible') {
				return false;
			}
			target.visibilityHidden = value === 'hidden';

			return true;
		case 'content':
			return assignContent(target, value);
		default:
			return false;
	}
}

const QUOTED = /^(['"])([\s\S]*)\1$/;

/**
 * What a resolved box's glyph is drawn as, for a frontend that cannot draw the codepoint itself.
 *
 * A terminal cannot load a stylesheet's icon font, so `glyphSubstitutes.ts` maps known private-use
 * codepoints to printable characters.
 *
 * It sits at *resolution* rather than at parse so that a sheet read before the icon theme loaded
 * still draws the theme's icons afterwards.
 */
let substituteGlyphs: (style: ICellStyle) => ICellStyle = style => style;

export function setGlyphSubstitution(substitution: (style: ICellStyle) => ICellStyle): void {
	substituteGlyphs = substitution;
}

/**
 * A pseudo-element's text. Only a quoted string is one: `attr()`, `none` and the counter
 * functions describe content there is no source for here. What the sheet wrote is kept exactly as
 * the sheet wrote it, a Private Use Area codepoint included, because which of those can be drawn
 * is the terminal renderer's question and not this parser's.
 */
function assignContent(target: ICellStyle, value: string): boolean {
	const quoted = QUOTED.exec(value.trim());
	if (!quoted) {
		return false;
	}

	target.content = unescape(quoted[2]);

	return true;
}

/** Whether a length puts anything between two boxes. `auto` does; `0` and `0px` do not. */
function separates(value: string | undefined): boolean {
	return !!value && !/^(0[a-z%]*|none|initial|inherit)$/.test(value);
}

/**
 * Margin and padding are independent, so either one separating is enough — and a side named with
 * no length is a side this declaration says nothing about.
 */
function separate(target: ICellStyle, left: string | undefined, right: string | undefined): boolean {
	if (left !== undefined) {
		target.spaceBefore = separates(left) || !!target.spaceBefore;
	}
	if (right !== undefined) {
		target.spaceAfter = separates(right) || !!target.spaceAfter;
	}

	return true;
}

/** A colour a terminal can paint: a registry variable, or a literal. `inherit` is the default. */
function assignColour(target: ICellStyle, property: 'color' | 'background', value: string): boolean {
	if (value === 'inherit' || value === 'initial' || value === 'unset' || value === 'transparent' || value === 'none') {
		return false;
	}

	target[property] = value;

	return true;
}

/** The declaration block, as the subset with cell meaning. `undefined` when none of it has any. */
function parseDeclarations(body: string): ICellStyle | undefined {
	const style: ICellStyle = {};
	let meaningful = false;

	for (const declaration of body.split(';')) {
		const colon = declaration.indexOf(':');
		if (colon === -1) {
			continue;
		}

		const property = declaration.slice(0, colon).trim().toLowerCase();
		const value = declaration.slice(colon + 1).replace(/!important/g, '').trim();
		meaningful = interpret(style, property, value) || meaningful;
	}

	return meaningful ? style : undefined;
}

/** The bucket a rule is filed under: its rightmost compound's id, first class, or tag. */
function bucketKey(selector: ISelector): string {
	const compound = selector.compounds[selector.compounds.length - 1];

	return compound.id ? `#${compound.id}` : compound.classes[0] ? `.${compound.classes[0]}` : compound.tag ?? ANY;
}

/**
 * One rule block filed into the buckets, as the rules it produced — a comma-separated prelude is
 * several. Returning them is what lets a sheet take one back out again; a stylesheet reached
 * through an `import` never does, and a `<style>` element's `deleteRule` always can.
 */
function file(prelude: string, body: string): IRule[] {
	const style = parseDeclarations(body);
	if (!style) {
		return [];
	}

	const filed: IRule[] = [];
	for (const part of prelude.split(',')) {
		const selector = parseSelector(part);
		if (!selector) {
			continue;
		}

		const key = bucketKey(selector);
		const bucket = buckets.get(key) ?? [];
		const rule = { selector, style, order: order++ };
		bucket.push(rule);
		buckets.set(key, bucket);
		filed.push(rule);
	}

	return filed;
}

function unfile(rules: readonly IRule[]): void {
	for (const rule of rules) {
		const bucket = buckets.get(bucketKey(rule.selector));
		const at = bucket?.indexOf(rule) ?? -1;
		if (at !== -1) {
			bucket!.splice(at, 1);
		}
	}
}

/**
 * A stylesheet, at the point its widget's `import '../../dom/x.css'` runs. At-rules are skipped
 * whole — viewport, animation, and font-loading rules have no terminal-cell meaning.
 */
export function addStylesheet(css: string): void {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');

	for (let at = 0; at < text.length;) {
		const open = text.indexOf('{', at);
		if (open === -1) {
			break;
		}

		const prelude = text.slice(at, open).trim();
		const close = text.indexOf('}', open);
		if (close === -1) {
			break;
		}

		if (prelude.startsWith('@')) {
			const end = skipBlock(text, open);
			at = end;
			continue;
		}

		at = close + 1;
		file(prelude, text.slice(open + 1, close));
	}
}

/**
 * The CSSOM a `<style>` element carries, which is the half of it `domStylesheets.ts` writes
 * through: `createCSSRule` inserts and `removeCSSRulesContainingSelector` deletes by
 * `selectorText`. `DecorationStyles` publishes a decoration's colour and badge this way, so
 * without it a `gitDecoration.*` colour has a class name on the row and no rule behind it.
 */
export class TerminalStyleSheet {

	readonly cssRules: { readonly cssText: string; readonly selectorText: string; readonly filed: readonly IRule[] }[] = [];

	insertRule(rule: string, index = 0): number {
		const open = rule.indexOf('{');
		const close = rule.lastIndexOf('}');
		if (open === -1 || close < open) {
			return index;
		}

		const selectorText = rule.slice(0, open).trim();
		this.cssRules.splice(index, 0, { cssText: rule, selectorText, filed: file(selectorText, rule.slice(open + 1, close)) });

		return index;
	}

	deleteRule(index: number): void {
		const [removed] = this.cssRules.splice(index, 1);
		if (removed) {
			unfile(removed.filed);
		}
	}
}

/** The index just past the block `open` opens, counting nested braces. */
function skipBlock(text: string, open: number): number {
	let depth = 0;
	for (let at = open; at < text.length; at++) {
		if (text[at] === '{') {
			depth++;
		} else if (text[at] === '}' && --depth === 0) {
			return at + 1;
		}
	}

	return text.length;
}

/** The declarations that could name `element`'s box or one of its pseudo-elements, in cascade order. */
function rulesFor(element: TerminalElement, pseudo: Pseudo | undefined): IRule[] {
	const candidates: IRule[] = [];
	for (const key of [`#${element.id}`, element.tagName, ANY, ...[...element.className.split(' ')].map(name => `.${name}`)]) {
		const bucket = buckets.get(key);
		if (bucket) {
			candidates.push(...bucket.filter(rule => rule.selector.pseudo === pseudo));
		}
	}

	return candidates.sort((a, b) => a.selector.specificity - b.selector.specificity || a.order - b.order);
}

const INLINE = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'opacity', 'display', 'visibility', 'margin-left', 'margin-right'];

/** What the sheets say about one box — the element's own, or one of its two pseudo-elements. */
function cascade(element: TerminalElement, pseudo: Pseudo | undefined): ICellStyle {
	const style: ICellStyle = {};

	for (const rule of rulesFor(element, pseudo)) {
		if (matchesSelector(element, rule.selector)) {
			Object.assign(style, rule.style);
		}
	}

	return style;
}

/**
 * A pseudo-element's box, or `undefined` when the sheets give it no text. `content` is what makes
 * one exist at all — a `::before` that only sets a background image is a file icon contributed as
 * an image rather than as a font glyph, and there is nothing in a cell for that.
 */
export function resolvePseudo(element: TerminalElement, pseudo: Pseudo): ICellStyle | undefined {
	const style = resolveVisibility(cascade(element, pseudo));
	if (!style.content) {
		return undefined;
	}

	// A substitution can answer *nothing* — a codepoint the frontend can neither draw nor stand in
	// for — and a box with no text is not a box, which is the same thing the check above says.
	const drawn = substituteGlyphs(style);

	return drawn.content ? drawn : undefined;
}

/** `element`'s own style: what the sheets say about it, then what its `style` attribute says. */
export function resolveStyle(element: TerminalElement): ICellStyle {
	const style = cascade(element, undefined);

	const inline = element.style as unknown as Record<string, string | undefined>;
	for (const property of INLINE) {
		const value = inline[camelCase(property)];
		if (value !== undefined) {
			interpret(style, property, value);
		}
	}

	return resolveVisibility(style);
}

function resolveVisibility(style: ICellStyle): ICellStyle {
	const { displayNone, visibilityHidden, ...resolved } = style;
	if (displayNone !== undefined || visibilityHidden !== undefined) { resolved.hidden = !!displayNone || !!visibilityHidden; }
	return resolved;
}
