/*---------------------------------------------------------------------------------------------
 *  The selector subset a terminal can answer, parsed once and matched against the tree.
 *
 *  Class, compound (`.a.b`), descendant (`.a .b`) and child (`.a > .b`), with an optional tag or
 *  id in a compound, `:not(…)` on any of them, and a trailing `::before`/`::after` on the last one.
 *  Everything else is skipped rather than approximated — `:hover`, `:focus` and attribute selectors
 *  describe gestures a grid of cells has no form for, and a wrong answer would be worse than no
 *  answer.
 *
 *  Both readers of a selector go through here: `querySelector` on the element tree and the
 *  stylesheet resolver. Two matchers would disagree at exactly the interesting places.
 *
 *  Upstream counterpart: none — stands in for the browser's selector matching.
 *--------------------------------------------------------------------------------------------*/

import { unescapeCss as unescape } from '../../../render/css.js';

/** What matching needs of an element, which is less than an element is. */
export interface ISelectorTarget {
	readonly tagName: string;
	readonly id: string;
	readonly parentNode: ISelectorTarget | null;
	hasClass(name: string): boolean;
}

interface ICompound {
	readonly tag?: string;
	readonly id?: string;
	readonly classes: readonly string[];
	/** `:not(…)`, as the compounds none of which may match. */
	readonly not?: readonly ICompound[];
}

export type Combinator = 'descendant' | 'child';

/** The two pseudo-elements that carry text, which is the part of one a cell can hold. */
export type Pseudo = 'before' | 'after';

export interface ISelector {
	/** Left to right, as written. */
	readonly compounds: readonly ICompound[];
	/** `combinators[i]` joins `compounds[i]` to `compounds[i + 1]`. */
	readonly combinators: readonly Combinator[];
	/** Set when the selector names a pseudo-element rather than the element itself. */
	readonly pseudo?: Pseudo;
	/** CSS specificity, as the one number an ordering needs. */
	readonly specificity: number;
}

const PSEUDO_ELEMENT = /::?(before|after)$/;

/**
 * CSS's own escape — `\.` for a literal dot, `\31 ` for a leading digit. A stylesheet spells a
 * codepoint no keyboard types the same way, so `style.ts` reads a `content` string through this
 * too: two unescapers would disagree at exactly the interesting places.
 */
/**
 * An identifier's characters, escapes included. They are load-bearing rather than exotic: a file
 * icon theme names a file by its name, so `CSS.escape` writes about a hundred of seti's selectors
 * as `.readme\.md-name-file-icon` — and a compound that will not parse is a rule that never
 * applies, which is an icon silently missing from a row.
 */
const IDENT = String.raw`(?:[\w-]|\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[\s\S])`;

const COMPOUND = new RegExp(String.raw`^([a-zA-Z][\w-]*)?((?:[.#]${IDENT}+)*)$`);

const COMPOUND_PARTS = new RegExp(String.raw`[.#]${IDENT}+`, 'g');

/**
 * `:not(…)`, which is in the subset because the alignment of every file row in the explorer turns
 * on one rule that uses it twice — `views.css:8`'s
 * `.monaco-tl-twistie:not(.force-twistie):not(.collapsible)`, the rule that takes the twistie's
 * width away from a row that has an icon instead. Its argument is a selector list of compounds,
 * which is CSS Level 3's own restriction and covers every use of it in these sheets.
 */
const NOT = /:not\(([^()]*)\)/g;

function parseCompound(text: string): ICompound | undefined {
	const not: ICompound[] = [];
	for (const negation of text.matchAll(NOT)) {
		for (const argument of negation[1].split(',')) {
			const compound = parseCompound(argument.trim());
			if (!compound) {
				return undefined;
			}
			not.push(compound);
		}
	}

	const match = COMPOUND.exec(not.length ? text.replace(NOT, '') : text);
	if (!match || (!match[1] && !match[2] && !not.length)) {
		return undefined;
	}

	const classes: string[] = [];
	let id: string | undefined;
	for (const part of match[2].match(COMPOUND_PARTS) ?? []) {
		if (part[0] === '.') {
			classes.push(unescape(part.slice(1)));
		} else {
			id = unescape(part.slice(1));
		}
	}

	return { tag: match[1]?.toUpperCase(), id, classes, not: not.length ? not : undefined };
}

/** A compound's own weight, which is also what `:not()` contributes — its argument's. */
function specificityOf(compound: ICompound): number {
	return (compound.id ? 100 : 0) + compound.classes.length * 10 + (compound.tag ? 1 : 0)
		+ (compound.not?.reduce((sum, negation) => sum + specificityOf(negation), 0) ?? 0);
}

/** The parsed selector, or `undefined` for anything outside the subset above. */
export function parseSelector(text: string): ISelector | undefined {
	const compounds: ICompound[] = [];
	const combinators: Combinator[] = [];
	let pending: Combinator = 'descendant';

	// The pseudo-element is written on the rightmost compound and matches the element that
	// compound names, so it comes off before the compounds are read and travels beside them.
	const trimmed = text.trim();
	const pseudo = PSEUDO_ELEMENT.exec(trimmed)?.[1] as Pseudo | undefined;

	for (const token of trimmed.replace(PSEUDO_ELEMENT, '').split(/\s*(>)\s*|\s+/).filter(token => !!token)) {
		if (token === '>') {
			pending = 'child';
			continue;
		}

		const compound = parseCompound(token);
		if (!compound) {
			return undefined;
		}
		if (compounds.length) {
			combinators.push(pending);
		}
		compounds.push(compound);
		pending = 'descendant';
	}

	if (!compounds.length) {
		return undefined;
	}

	let specificity = pseudo ? 1 : 0;
	for (const compound of compounds) {
		specificity += specificityOf(compound);
	}

	return { compounds, combinators, pseudo, specificity };
}

function matchesCompound(target: ISelectorTarget, compound: ICompound): boolean {
	if (compound.tag && compound.tag !== target.tagName) {
		return false;
	}
	if (compound.id && compound.id !== target.id) {
		return false;
	}
	if (compound.not?.some(negation => matchesCompound(target, negation))) {
		return false;
	}

	return compound.classes.every(name => target.hasClass(name));
}

/**
 * Whether `target` matches, read right to left. A descendant step takes the nearest matching
 * ancestor and does not backtrack, which is exact for every sheet in this subset.
 */
export function matchesSelector(target: ISelectorTarget, selector: ISelector): boolean {
	let index = selector.compounds.length - 1;
	let node: ISelectorTarget | null = target;

	if (!matchesCompound(node, selector.compounds[index])) {
		return false;
	}

	while (index > 0) {
		const combinator = selector.combinators[index - 1];
		index--;
		node = node!.parentNode;

		if (combinator === 'child') {
			if (!node || !matchesCompound(node, selector.compounds[index])) {
				return false;
			}
		} else {
			while (node && !matchesCompound(node, selector.compounds[index])) {
				node = node.parentNode;
			}
			if (!node) {
				return false;
			}
		}
	}

	return true;
}
