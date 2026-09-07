// Source-reading helpers used by scripts/keymap-drift.mjs.
import { REPO } from '../docs/provenance/args.mjs';
import { injectedKeys } from '../docs/keyboard/injected.mjs';
export { injectedKeys } from '../docs/keyboard/injected.mjs';
import { closure, resolveSpec } from '../docs/keyboard/closure.mjs';
import { loadTypeScript, scanner } from '../docs/keyboard/registrations.mjs';

/** Where upstream states, in one table, which `KeyCode` is labelled what. */
const KEY_CODES = 'src/vs/base/common/keyCodes.ts';

/**
 * The four `KeyMod` bits as the modifiers they mean on this platform. `decodeKeybinding` reads
 * The terminal key model treats `CtrlCmd` as control and `WinCtrl` as meta independently of the
 * host operating system.
 */
const MODIFIERS = { CtrlCmd: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', WinCtrl: 'metaKey' };

/** `_simpleAsString`'s order, which is what every label upstream draws is built in. */
const ORDER = [['ctrlKey', 'Ctrl'], ['shiftKey', 'Shift'], ['altKey', 'Alt'], ['metaKey', 'Meta']];


/* ------------------------------------------------------------------ reading the key expressions */

/** Splits on `separator` at bracket depth zero, so an argument list is never cut in half. */
function split(text, separator) {
	const parts = [''];
	let depth = 0;
	for (const character of text) {
		if ('([{'.includes(character)) depth++;
		if (')]}'.includes(character)) depth--;
		if (character === separator && depth === 0) parts.push('');
		else parts[parts.length - 1] += character;
	}
	return parts;
}

/** Whether the bracket the text opens with is the one it ends with, rather than an earlier one. */
function wrapped(text) {
	let depth = 0;
	for (let at = 0; at < text.length; at++) {
		if ('([{'.includes(text[at])) depth++;
		else if (')]}'.includes(text[at]) && --depth === 0) return at === text.length - 1;
	}
	return false;
}

/** An expression without the parentheses around it, which a cut leaves behind everywhere. */
const bare = (text) => {
	let out = String(text ?? '').trim();
	while (out.startsWith('(') && wrapped(out)) out = out.slice(1, -1).trim();
	return out;
};

/**
 * Every `KeyCode` and the string upstream labels it with, read out of the `mappings` table in
 * `keyCodes.ts` — the rows `KeyCodeUtils.toString` answers from, and therefore the rows
 * `USLayoutResolvedKeybinding.getLabel` draws a key with. Reading them is what keeps this file
 * from holding a second, drifting copy of a hundred-key table.
 */
export function keyCodeLabels(tree) {
	const body = tree.read(KEY_CODES);
	if (body === null) {
		throw new Error(`${KEY_CODES}: not readable in ${tree.name} — the label table has moved`);
	}

	const labels = new Map();
	for (const [, member, label] of body.matchAll(/,\s*KeyCode\.(\w+),\s*'((?:[^'\\]|\\.)*)'/g)) {
		if (label && !labels.has(member)) labels.set(member, label.replace(/\\(.)/g, '$1'));
	}
	if (labels.size < 100) {
		throw new Error(`${KEY_CODES}: only ${labels.size} labels found — the mappings table has changed shape`);
	}
	return labels;
}

/** One chord — the modifiers and the key — from `KeyMod.CtrlCmd | KeyCode.KeyW`, or null. */
function chord(expression, labels) {
	const parsed = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, keyLabel: null };

	for (const part of split(expression, '|')) {
		const text = bare(part);
		const modifier = /^KeyMod\.(\w+)$/.exec(text);
		if (modifier && MODIFIERS[modifier[1]]) {
			parsed[MODIFIERS[modifier[1]]] = true;
			continue;
		}
		const code = /^KeyCode\.(\w+)$/.exec(text);
		const label = code && code[1] !== 'Unknown' ? labels.get(code[1]) : undefined;
		if (!label || parsed.keyLabel) return null;
		parsed.keyLabel = label;
	}

	return parsed.keyLabel ? parsed : null;
}

/**
 * `0` and `undefined` are upstream's own way of writing "no default key on this platform", so an
 * expression that is one of them states an **absence**, which is a different answer from a chord
 * this cannot read and must never be reported as one.
 */
const stated = (expression) => {
	const text = bare(expression);
	return text && text !== '0' && text !== 'undefined' ? text : undefined;
};

/**
 * The chords a `primary`/`secondary` expression produces, or null for one with no static answer —
 * kept as null rather than guessed at, the same policy the item table applies to a computed id. An
 * expression `stated` calls absent is null too, and callers tell the two apart by asking `stated`.
 */
export function parseChords(expression, labels) {
	const text = stated(expression);
	if (!text) return null;

	// `!isFirefox ? (KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP) : undefined` — a key present on
	// one platform only. The arm that is a key is the key; two real arms have no single answer.
	const question = split(text, '?');
	if (question.length === 2) {
		const arms = split(question[1], ':');
		if (arms.length !== 2) return null;
		const [first, second] = arms.map(arm => parseChords(arm, labels));
		return first && second ? null : first ?? second;
	}

	const chorded = /^KeyChord\((.*)\)$/s.exec(text);
	if (chorded) {
		const parts = split(chorded[1], ',').map(part => chord(part, labels));
		return parts.length === 2 && parts.every(Boolean) ? parts : null;
	}

	const single = chord(text, labels);
	return single ? [single] : null;
}

/** A chord sequence as the label upstream would print for it — `Ctrl+K Ctrl+S`. */
export const chordLabel = (chords) => chords
	.map(part => [...ORDER.filter(([field]) => part[field]).map(([, name]) => name), part.keyLabel].join('+'))
	.join(' ');

/**
 * Every binding a rule states: its primary first, then the secondaries, in declaration order.
 *
 * `chords` is null for an expression with no static answer, and the label carries that expression
 * behind a `?` so a reader can see *what* was not read. **A caller must tell the two apart**: a
 * chord that could not be read is not a chord the app does not have, and comparing the label as
 * though it were one reports the scan's own limit as the app's behaviour.
 */
export function bindings(record, labels) {
	const all = [record.key, ...split(bare(record.secondary ?? '').replace(/^\[(.*)\]$/s, '$1'), ',')];
	const out = [];

	for (const expression of all) {
		const text = stated(expression);
		if (!text) continue;
		const chords = parseChords(expression, labels);
		out.push(chords
			? { label: chordLabel(chords), chords }
			: { label: `?${text}`, chords: null });
	}
	return out;
}

/* --------------------------------------------------------------------------------- the guards */

const andTerms = (when) => {
	const text = bare(when ?? '');
	if (!text || text === 'undefined') return [];
	const and = /^ContextKeyExpr\.and\((.*)\)$/s.exec(text);
	return (and ? split(and[1], ',') : [text]).map(bare).filter(term => term && term !== 'undefined');
};

/**
 * What has to hold for a rule to fire. Two of the terms are `registerPaneCommand`'s — the pane has
 * to be the focused view, and, unless the key carries a modifier, its input must not be swallowing
 * keys — and the rest are the rule's own `when` clause, kept as the source wrote them: a term
 * resolved to a context-key name would be this file deciding what an upstream expression means.
 */
export function guard(record) {
	return [
		...(record.view ? [`FocusedViewContext.isEqualTo('${record.view}')`] : []),
		...(record.view && !record.whileEditing ? ['InputFocusedContext.negate()'] : []),
		...andTerms(record.when)
	];
}

const negated = (term) => /\.(?:negate|toNegated)\(\)$/.test(term);
const positive = (term) => term.replace(/\.(?:negate|toNegated)\(\)$/, '');

/** A guard term as the map writes it: the `Context` suffix dropped and a negation led with `!`. */
export const termLabel = (term) => {
	const equals = /^FocusedViewContext\.isEqualTo\('(.*)'\)$/.exec(term);
	if (equals) return `FocusedView == ${equals[1]}`;
	const has = /^ContextKeyExpr\.has\('(.*)'\)$/.exec(term);
	if (has) return `has ${has[1]}`;
	return (negated(term) ? '!' : '') + positive(term).replace(/Context$/, '');
};

export const guardLabel = (terms) => terms.map(termLabel).join(' · ') || 'everywhere';

/* ---------------------------------------------------------------------------- reading the rules */

/** The fork's own files: everything outside the vendored tree. Same rule the functionality page uses. */
const isOurs = (rel) => rel.startsWith('src/') && !rel.startsWith('src/vs/');

export function rules(tree, roots) {
	const { scan } = scanner(loadTypeScript(REPO), injectedKeys(roots));
	const reached = closure(tree, roots);
	const edge = (spec, from) => resolveSpec(tree, spec, from);
	const out = [];

	for (const rel of reached.keys()) {
		if (rel.endsWith('.ts')) out.push(...scan(rel, tree, edge));
	}
	return out;
}

/**
 * One row per command this fork answers a key for, in the order the source declares them.
 *
 * A command declared for the status line but bound by an upstream file — the palette's two — has
 * no rule of ours, so its row is that upstream rule as it runs here. That is not a drift in the
 * binding; the drift is *which of its bindings a terminal can send*, which is the `deliverable`
 * field and the reason `F1` is on the status line while `Ctrl+Shift+P` is the primary.
 *
 * **`isFork` is which files count as the fork's**, and it is a parameter because the answer moves
 * with the tree. `isOurs` — everything outside `src/vs` — is right for this repository and answers
 * with three rules when the tree is *tscode*, whose keyboard is VS Code's with a keep-set over it
 * and whose own layer lives inside the vendored tree. `scripts/keymap-drift.mjs` reads that tree
 * whole, so it passes its own.
 */
export function rows(forkRules, upstreamKey, labels, isDeliverable, isFork = isOurs) {
	const ours = forkRules.filter(record => record.key && isFork(record.file));
	const declared = forkRules.filter(record => record.declaresOnly);
	const mine = new Set(ours.map(record => record.id));
	// A rule the fork declares but does not bind is answered by whichever vendored rule carries the
	// key here, which is the one the resolver would run.
	const vendored = new Map();
	for (const record of forkRules) {
		if (record.key && !isFork(record.file) && !vendored.has(record.id)) vendored.set(record.id, record);
	}

	const out = new Map();
	for (const record of [...ours, ...declared.map(record => vendored.get(record.id)).filter(Boolean)]) {
		const keys = bindings(record, labels);
		const row = out.get(record.id) ?? {
			id: record.id,
			ours: [],
			guard: [],
			at: [],
			mine: mine.has(record.id),
			upstream: upstreamKey(record.id)
		};

		for (const one of keys) {
			row.ours.push({ label: one.label, read: !!one.chords, deliverable: one.chords ? isDeliverable({ getChords: () => one.chords }) : null });
		}
		// Nine keys under one guard is one condition, not nine: the digits are the live case.
		const terms = guard(record);
		if (!row.guard.some(other => other.join(' ') === terms.join(' '))) row.guard.push(terms);
		if (!row.at.includes(record.file)) row.at.push(record.file);
		out.set(record.id, row);
	}

	for (const row of out.values()) {
		row.keys = row.ours.map(one => one.label).join(' · ');
		// The two halves a comparison has to keep apart: the chords that were read, and the
		// expressions that were not. Neither is a subset of the other's meaning.
		row.chords = row.ours.filter(one => one.read).map(one => one.label);
		row.unread = row.ours.filter(one => !one.read).map(one => one.label);
		row.drift = drifted(row.upstream, row.keys);
		row.deliverable = row.ours.some(one => one.deliverable !== false);
	}
	return [...out.values()];
}

/**
 * Whether a key here is a decision rather than a copy. tscode having no such command is not a
 * drift — there is nothing to have drifted from — but tscode having it and reaching it some other
 * way is: a key put on an unbound command is exactly the choice this map exists to record.
 */
export const drifted = (upstream, keys) => upstream !== ABSENT && upstream !== keys;

/** What tscode answers for a command it has no key for, and for one it does not have at all. */
export const ABSENT = '—';

