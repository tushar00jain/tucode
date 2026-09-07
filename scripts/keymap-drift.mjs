/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The keymap instrument: `keymap.ts` against the keys **tscode** actually registers, and against
 * the rules a frontend of this repository registers for itself.
 *
 * **Why it exists.** The same keyboard is declared three times — here as `KEYMAP`, in
 * `tui/workbench/commands.ts` and the panes as `registerTuiCommand`/`registerPaneCommand` calls,
 * and in tscode as `registerAction2`/`KeybindingsRegistry` calls — and declarations drift. A survey
 * read fifteen rows by hand and found them agreeing, which is reassurance rather than evidence;
 * this is the mechanical answer, and it goes on being one once a declaration becomes an import,
 * because tscode's set is still moving underneath all of them.
 *
 * **What it used to measure.** It resolved a sibling directory *named* `tucode` and found this
 * repository, so `upstreamRules` and `forkRules` read one tree and three of its seven checks
 * compared this repo with itself. Two of them could not report anything by construction — nothing
 * is undeclared when both lists come from the registrations one declaration describes — and a third
 * quoted this fork's own rules back at it as *upstream keeps `Tab` on `tscode.focusNextView`*. The
 * real measurement inside it, `KEYMAP`'s column against the `registerTuiCommand` calls in the same
 * tree, is kept and is now a gate of its own. Everything that says *upstream* reads a tscode
 * checkout now, resolved and asserted by `docs/provenance/baseline.mjs` — by the checkout's own
 * name, which is the one check a renamed directory cannot defeat.
 *
 * **One scanner does the reading.** `scripts/keymap-bindings.mjs` already knows how to find a
 * registration, follow a constant across an import, and label a chord the way upstream labels one.
 * Reading those files again from here would be a second extractor with a second set of bugs, so
 * this imports that one and points it at both trees. It is imported from *this* repo rather than
 * from the measured checkout, because tscode has no copy of it: the scanner suite is this fork's
 * own, and the tree it reads is the variable.
 *
 * **Nine checks.** The first five are mechanical, so they gate; the last four are readings a
 * person makes, so they list.
 *
 * | check | what a finding means | gates |
 * | --- | --- | --- |
 * | the column against the registrations | the table declares a chord for this surface and this surface's boot closure registers another | yes |
 * | the tuple diff | one id, two registrations, and a chord, a scope or a count of guard terms that disagrees with tscode | yes |
 * | stale reasons | a `surfaceDrift` entry explaining a divergence that is no longer measured | yes |
 * | undeclared ids | tscode answers a key this map does not declare at all | yes |
 * | dangling rules | a row binds a command nothing in this frontend's boot closure registers | yes |
 * | values the scan could not read | **an expression with no static answer**, and every comparison withheld because of one | no |
 * | the guard, both ways | the two spellings of one guard, side by side | no |
 * | the keep-set hazard | **a chord upstream answers with more than one command** — the `pastePwsh` shape, where naming one of them silently changed which paste ran | no |
 * | extra chords | a kept command keeps upstream's own chord alongside the one the map declares | no |
 *
 * **Two things it cannot read, stated rather than quietly dropped.** `args` — it is declared on
 * both sides (`tscode.showViewContainer` is `args: 0` either way) and the scanner does not record
 * it, so the fourth field of the tuple is read here only. And a *guard's meaning*: what the scan
 * hands back is the source that builds a `ContextKeyExpression`, over constants declared elsewhere,
 * so resolving the two spellings to one vocabulary would be a table of what each expression means —
 * the judgement that scanner refuses to make, and rightly. What is compared is the structure the
 * two expansions are built from: the view, the not-typing term, and how many terms are left over.
 *
 * `npm run keymap` reports and exits 0; `npm run keymap -- --gate` exits 1 on a gated finding with
 * no written reason. **The pre-commit hook does not run it** — turning an instrument from triage
 * into a gate is a standing rule and therefore the user's, and this one has open findings against
 * tscode that are readings rather than defects.
 *
 * It **skips, with a message that says how to point it somewhere**, when there is no tscode
 * checkout: a clone with only this repo in it is the ordinary case and must not fail.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { baselineRoot, HOW } from '../docs/provenance/baseline.mjs';
import * as closure from '../docs/keyboard/closure.mjs';
import * as keybindings from './keymap-bindings.mjs';
import * as registrations from '../docs/keyboard/registrations.mjs';
import * as tree from '../docs/provenance/tree.mjs';
import { editorIdOf, expandTuiScope, KeymapDrift, keysFor, rowsFor, viewIdOf } from '../src/vs/workbench/browser/tauri/keymap.js';
import { chordLabel as label } from './chordLabel.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The boot file that makes a closure a closure, per frontend. tscode's is `src/main.ts` too, which
 * is what lets one entry answer for both sides of the comparison.
 */
const ROOTS = { tui: ['src/main.ts'] };

/** The frontend being measured — which closure is walked, and which column of the table is read. */
const SURFACE = 'tui';

/** "The user is not typing", as the scanned guard writes it — `keybindings.mjs`'s `guard`. */
const NOT_TYPING = 'InputFocusedContext.negate()';

/**
 * A file tscode wrote rather than inherited: outside VS Code's tree, or in one of the `tauri/`
 * directories the copy scripts leave alone. It is what scopes the undeclared check — a stock VS
 * Code key this map does not declare is the keep-set doing its job, not a gap in the map.
 */
const forkLayer = (rel) => !rel.startsWith('src/vs/') || rel.includes('/tauri/');

/** How the scanned guard states the view a rule is scoped to. */
const VIEW_TERM = /^FocusedViewContext\.isEqualTo\('(.*)'\)$/;

/**
 * Every rule in tscode's boot closure, as `(id, chords, view, whileEditing, when)`.
 *
 * **`rows()` does the reading, and this takes it whole.** It resolves a command that is *declared*
 * rather than bound to the rule that carries its key, and turns a `primary`/`secondary` pair into
 * chord labels. This module used to do both again, and the second was wrong: it split `secondary`
 * on every comma, so a `[KeyChord(a, b)]` came apart into two halves that parse as nothing and the
 * chord vanished — which is how `workbench.action.openGlobalKeybindings` was measured as `?` alone
 * with `Ctrl+K Ctrl+S` bound beside it. A second extractor with a second set of bugs is exactly
 * what this file's header says not to build.
 *
 * The two arguments this does not need are answered flat: the upstream key of a command is what
 * the tuple diff computes for itself, and every chord is deliverable in a window.
 */
function tscodeRules(root) {
	const theirs = tree.workingTree(root);
	const labels = keybindings.keyCodeLabels(theirs);
	const out = new Map();

	// The fifth argument is the one that matters: `rows()` defaults to the files outside `src/vs`,
	// because the drift inventory compares this fork's keys against tscode's — and asked of tscode
	// that filter answers with three rules. What a tscode window resolves for a command is the
	// whole closure, so every file in it counts here.
	for (const row of keybindings.rows(keybindings.rules(theirs, ROOTS.tui), () => keybindings.ABSENT, labels, () => true, () => true)) {
		if (typeof row.id !== 'string' || row.id.startsWith('?')) {
			continue;
		}

		// **The guard is read as the borrowed instrument reads it, then taken apart the same way
		// the scope is put together here.** `registerPaneCommand` states the view and the
		// not-typing term as arguments, `registerTuiCommand` states them in the `when` — which is
		// one guard written two ways, and comparing the spellings would report the design as drift.
		const entry = { id: row.id, chords: row.chords, unread: row.unread, views: new Set(), notTyping: false, extra: new Set(), guard: undefined, files: new Set(row.at) };
		for (const terms of row.guard) {
			entry.guard ??= keybindings.guardLabel(terms);
			entry.views.add(terms.map(term => VIEW_TERM.exec(term)?.[1]).find(Boolean) ?? null);
			entry.notTyping ||= terms.includes(NOT_TYPING);
			for (const term of terms.filter(one => !one.startsWith('FocusedViewContext.isEqualTo(') && one !== NOT_TYPING)) {
				entry.extra.add(keybindings.termLabel(term));
			}
		}
		out.set(row.id, entry);
	}

	return out;
}

/** Every keybinding rule in the measured frontend's boot closure, and every command id it registers. */
function hereRules(root, roots) {
	const here = tree.workingTree(root);
	const labels = keybindings.keyCodeLabels(here);
	const { scan } = registrations.scanner(registrations.loadTypeScript(root), keybindings.injectedKeys(roots));
	const reached = closure.closure(here, roots);
	const edge = (spec, from) => closure.resolveSpec(here, spec, from);

	const rules = [];
	const registered = new Set();
	const unread = new Map();

	for (const rel of reached.keys()) {
		if (!rel.endsWith('.ts')) {
			continue;
		}

		// This repo's own registrar wrapper, which the borrowed scanner has no entry for: it passes
		// the id down to `CommandsRegistry.registerCommand` as a parameter, so the scan sees a
		// computed id at the registry and a call it does not know at the wrapper. The three `/`
		// commands are registered this way and nothing else is.
		for (const [, id] of (here.read(rel) ?? '').matchAll(/registerViewRootCommand\('([^']+)'/g)) {
			registered.add(id);
		}

		for (const record of scan(rel, here, edge)) {
			if (typeof record.id !== 'string' || record.id.startsWith('?')) {
				continue;
			}
			// `^filesExplorer.paste` is upstream's "let this one bubble" form; the resolver strips
			// the caret, so the keep-set and this both see the bare id.
			registered.add(record.id.replace(/^\^/, ''));
			if (!record.key) {
				continue;
			}

			// `bindings()` does the splitting, because a `[KeyChord(a, b)]` secondary comes apart into
			// two unparseable halves on a bare `split(',')` and the chord vanishes — the second
			// extractor this file's header says not to build, caught the first time it was asked a
			// question with a chorded answer in it.
			const id = record.id.replace(/^\^/, '');
			for (const one of keybindings.bindings(record, labels)) {
				if (one.chords) {
					rules.push({
						chord: one.label,
						id,
						when: String(record.when ?? '').replace(/\s+/g, ' ').trim(),
						file: record.file
					});
				} else {
					unread.set(id, [...new Set([...(unread.get(id) ?? []), one.label])]);
				}
			}
		}
	}

	return { rules, registered, unread };
}

/**
 * The commands `keymap.contribution.ts` implements itself — `IMPLEMENTED_COMMAND_IDS`, read out of
 * the source rather than imported, because importing that module means importing the workbench.
 *
 * **The scanner cannot see these registered.** They reach `CommandsRegistry` from a loop over
 * `COMMANDS`, so the id at the call site is `command.id` rather than a literal and a static scan
 * records a computed id as unreadable. Reading the array's own `id:` lines is the same set out of
 * the same file, and it is what keeps the dangling check from calling every one of them dangling.
 *
 * **It describes the `gui` surface and neither frontend here**, which is why the dangling check
 * still reports four rows under `--surface tui`: `keymap.contribution.ts` is what a *window*
 * registers, and this repository's frontends register their commands elsewhere. The set is read
 * anyway because a row it names is not dangling *anywhere* — a wrapper that exists is a wrapper —
 * and the four it does not cover are the finding rather than the tool's mistake.
 */
async function implementedIds() {
	const { readFile } = await import('node:fs/promises');
	const source = await readFile(resolve(REPO_ROOT, 'src/vs/workbench/browser/tauri/keymap.contribution.ts'), 'utf8');

	return new Set([...source.matchAll(/^\t+id: '([^']+)',$/gm)].map(match => match[1]));
}

/** The command a row's rule binds here, which is `guiRuleId`'s answer. */
const boundId = (row, implemented) => implemented.has(row.id) ? row.id : row.forwards ?? row.id;

/** One finding, in the form a reader can act on: the row, both sides, and whether a reason exists. */
const finding = (check, id, said, against, reason) => ({ check, id, said, against, reason });

/** The unreadable expressions a table of rules holds, as the `id -> texts` map the checks ask. */
const holes = (table) => new Map([...table]
	.filter(([, entry]) => entry.unread.length)
	.map(([id, entry]) => [id, entry.unread]));

/**
 * Every id an unreadable expression was found under, and what could not be read — merged over both
 * sides, because a hole in either reading is a hole in the comparison between them.
 */
function unreadable(...maps) {
	const out = new Map();

	for (const map of maps) {
		for (const [id, texts] of map) {
			out.set(id, [...new Set([...(out.get(id) ?? []), ...texts])]);
		}
	}

	return out;
}

/**
 * **Two declarations that disagree and a value that could not be read are different findings**, and
 * only the first is evidence of anything. So a finding about an id whose registrations hold an
 * expression the scan could not follow is withheld from the check that raised it: the comparison
 * ran over an incomplete reading, and a difference across a hole says nothing about the app.
 *
 * The withheld ones are still reported — a blind spot nobody sees is the worse failure — and they do
 * not gate, which is what keeps the gate's remaining findings worth acting on. Writing a `reason`
 * for one instead would be the trap this exists to close: it launders a measurement failure as
 * declared divergence, and every later reader believes the key genuinely differs.
 *
 * **`unread` is the holes on the side the check actually read**, and only that side. The column
 * check reads this frontend's own registrations and the tuple diff reads tscode's; withholding one
 * check's findings for the other side's holes would hide real drift, which is the same disservice in
 * the other direction.
 */
const withhold = (findings, unread) => ({
	drift: findings.filter(one => !unread.has(one.id)),
	held: findings.filter(one => unread.has(one.id)).map(one => finding(one.check, one.id, one.said,
		`${one.against}, measured without ${unread.get(one.id).join(' · ')}`, one.reason))
});

/**
 * The unreadable category itself: what was withheld, and every id with a hole in it that nothing
 * disagreed across — because the hole is the finding whether or not a difference fell into it.
 */
function unreadableFindings(unread, held, rows) {
	const out = [...held];

	for (const [id, texts] of unread) {
		if (!out.some(one => one.id === id)) {
			out.push(finding('unreadable', id, (rows.get(id)?.chords ?? []).join(' · ') || '(none)', texts.join(' · '), undefined));
		}
	}

	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * **The column against the registrations** — the one measurement the instrument made while it was
 * pointed at itself, kept and named.
 *
 * `KEYMAP` declares a chord per surface and the surface's own files register one; nothing generates
 * either from the other. This is what makes the column a description of the app rather than a wish:
 * for every id both sides name, the chords have to be the same set.
 *
 * A row nothing registers is the dangling check's, and an id registered without a row is the
 * undeclared check's; this is only about the rows where both sides spoke.
 */
function columnAgainstRegistrations(rows, registeredChords) {
	const findings = [];

	for (const row of rows.values()) {
		// The row's own id first: a forwarding row is registered here *at its own id* and the command
		// it forwards to is registered by whoever owns it, at whatever chord that owner chose.
		const theirs = registeredChords.get(row.id) ?? registeredChords.get(row.bound);
		if (row.stock || !theirs) {
			continue;
		}

		const declared = [...row.chords].sort();
		const measured = [...new Set(theirs)].sort();
		if (declared.join(' · ') !== measured.join(' · ')) {
			findings.push(finding(KeymapDrift.Chord, row.id, declared.join(' · ') || '(none)', measured.join(' · ') || '(none)', row.reason));
		}
	}

	return findings;
}

/**
 * The tuple diff — `(id, chord, scope, args)` per row, this frontend's expansion against tscode's.
 * The guard is compared as the scope it came from rather than as a serialized `when`: the one thing
 * the two declarations cannot spell alike is the guard, which is why `scope` is symbolic in the
 * first place, so a string comparison of two `when`s would report the design as drift.
 *
 * A difference is answered by the row's `surfaceDrift` entry for *that* comparison, and by nothing
 * else: `reason` covers the drifts a row declares — `only` and `guiKeys` — and a
 * chord split legitimately declared there would otherwise launder a guard nobody explained.
 *
 * **A row the measured surface does not carry is not compared.** Its command exists somewhere else
 * and nowhere here, so tscode having a rule for it is the row working, not drifting.
 */
function tupleDiff(rows, theirRules) {
	const findings = [];
	const list = terms => [...terms].sort().join(' · ') || '(none)';
	const why = (tuple, kind) => tuple.surfaceDrift?.[kind] ?? tuple.reason;

	for (const [id, tuple] of rows) {
		const theirs = theirRules.get(id);
		if (!theirs) {
			continue;
		}

		const theirChords = [...new Set(theirs.chords)].sort();
		if (tuple.chords.join(' · ') !== theirChords.join(' · ')) {
			findings.push(finding(KeymapDrift.Chord, id, tuple.chords.join(' · ') || '(none)', theirChords.join(' · ') || '(none)', why(tuple, KeymapDrift.Chord)));
		}

		const theirView = [...theirs.views].filter(Boolean).sort().join(',');
		if ((tuple.view ?? '') !== theirView) {
			findings.push(finding(KeymapDrift.Scope, id, tuple.view ?? '(global)', theirView || '(global)', why(tuple, KeymapDrift.Scope)));
		}
		if (tuple.notTyping !== theirs.notTyping) {
			findings.push(finding(KeymapDrift.Typing, id, String(tuple.notTyping), String(theirs.notTyping), why(tuple, KeymapDrift.Typing)));
		}
		if (tuple.extra.length !== theirs.extra.size) {
			findings.push(finding(KeymapDrift.Guard, id, list(tuple.extra), list(theirs.extra), why(tuple, KeymapDrift.Guard)));
		}
	}

	return findings;
}

/**
 * The rule's other direction: **a reason with nothing left to explain.** A `surfaceDrift` entry is
 * prose about a divergence that is currently measured, so once the measurement stops finding it the
 * entry is a claim about something that is not there — and a table whose explanations outlive the
 * things they explain is how a keymap stops being a description of the app.
 *
 * `keymap.test.ts` cannot ask this: what makes an entry owed is a measurement of a registration
 * outside this repo, which is the whole reason this instrument exists. It gates, because a stale
 * reason costs a keystroke of deletion and its absence costs a reader's trust in every other one.
 */
function staleReasons(rows, drifted) {
	const answered = new Set(drifted.map(one => `${one.id}\t${one.check}`));

	return [...rows.values()].flatMap(row => Object.keys(row.surfaceDrift ?? {})
		.filter(kind => !answered.has(`${row.id}\t${kind}`))
		.map(kind => finding(kind, row.id, `a written reason for ${JSON.stringify(kind)}`, 'nothing measured differs there', undefined)));
}

/**
 * The guard's *spelling*, side by side, for every shared row that carries an extra term. This is
 * the one field of the tuple that cannot be compared: one side writes a `ContextKeyExpression` and
 * the other writes the source that builds one, and resolving either to the other's vocabulary means
 * a table of names that decides what an expression *means* — which is the judgement the borrowed
 * instrument refuses to make, and rightly. So it is listed for a reader, and the count of terms is
 * what gates.
 */
function guardSpellings(rows, theirRules) {
	return [...rows.values()]
		.map(row => ({ row, theirs: theirRules.get(row.id) }))
		.filter(({ row, theirs }) => theirs && (row.extra.length > 0 || theirs.extra.size > 0))
		.map(({ row, theirs }) => finding('guard', row.id, row.guard, theirs.guard, row.reason));
}

/** A row whose rule binds a command nothing registers: a key that silently does nothing. */
function dangling(rows, registered) {
	return [...rows.values()]
		.filter(row => !row.stock && !registered.has(row.bound))
		.map(row => finding('dangling', row.id, `binds ${row.bound}`, 'nothing in the boot closure registers it', row.reason));
}

/**
 * The keep-set hazard: **a chord upstream answers with more than one command.** That is the
 * `pastePwsh` shape — the keep-set names commands, so a chord with two of them keeps whichever was
 * named and silently changes which one wins. The hazard is a property of the chord, not of either
 * rule, so it is reported per chord with every command on it.
 *
 * It is listed rather than gated because the third column cannot be filled in from here: whether a
 * command is kept for `text-input`, `quick-input` or `accessibility-overlay` is a question about its
 * `when`, and what the scan hands back is the *source* that builds one — `ContextKeyExpr.and(…)`
 * over constants declared elsewhere. Resolving those to key names is a table of what each expression
 * means, which is the judgement the borrowed scanner refuses to make. The ids that are kept by name
 * are marked; the rest say "by guard, unread".
 *
 * **The chords claimed are the `gui` column's**, because the keep-set is a window's filter over a
 * window's defaults: what it decides is which of tscode's own rules survive, and a chord a terminal
 * cannot even receive never reaches it.
 */
function keepSetHazards(rows, upstream, keptById) {
	const byChord = new Map();
	for (const rule of upstream) {
		byChord.set(rule.chord, [...new Set([...(byChord.get(rule.chord) ?? []), rule.id])]);
	}

	const claimed = new Map();
	for (const row of rows.values()) {
		for (const chord of row.guiChords) {
			claimed.set(chord, [...(claimed.get(chord) ?? []), row.id]);
		}
	}

	return [...claimed]
		.map(([chord, byRows]) => ({ chord, byRows, ids: byChord.get(chord) ?? [] }))
		.filter(entry => entry.ids.length > 1)
		.sort((a, b) => a.chord.localeCompare(b.chord))
		.map(({ chord, byRows, ids }) => finding(
			'keep-set',
			chord,
			`claimed by ${[...new Set(byRows)].join(' · ')}`,
			`upstream answers it with ${ids.map(id => `${id} (${keptById(id) ? 'kept by name' : 'by guard, unread'})`).join(', ')}`,
			undefined));
}

/**
 * The extra-chord set: the keep-set names *commands*, so a kept command keeps upstream's own chord
 * beside the one the map declares. Every row of this is legal — it is what naming a command means —
 * and it is listed rather than gated so that the set is a thing someone has read.
 */
function extraChords(rows, upstream) {
	const byId = new Map();
	for (const rule of upstream) {
		byId.set(rule.id, [...(byId.get(rule.id) ?? []), rule.chord]);
	}

	return [...rows.values()]
		.filter(row => !row.stock)
		.map(row => ({ row, extra: [...new Set(byId.get(row.bound) ?? [])].filter(chord => !row.guiChords.includes(chord)) }))
		.filter(entry => entry.extra.length > 0)
		.map(({ row, extra }) => finding('extra chord', row.id, row.guiChords.join(' · '), `upstream keeps ${extra.join(' · ')} on ${row.bound}`, row.reason));
}

function report(title, findings, gated) {
	console.log(`\n=== ${title} — ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}${gated ? '' : ' (reported, not gated)'}`);
	for (const one of findings) {
		console.log(`  ${one.id}`);
		console.log(`      here: ${one.said}`);
		console.log(`      there: ${one.against}`);
		console.log(`      reason: ${one.reason ?? '(none written)'}`);
	}
}

/**
 * The table, collapsed to one entry per command id — nine digit rows are one command with nine
 * keys, and a finding about `tscode.showViewContainer` is one finding.
 *
 * `chords` is the measured surface's column and `guiChords` is always the `gui` one, because the
 * two answer different questions: what this frontend delivers, and what a window's keep-set filter
 * sees.
 */
function collapse(surface, implemented) {
	const rows = new Map();

	// `rowsFor` is the module's own answer to which rows a surface has, and it is what this asks: a
	// row a surface does not carry is not a row that surface can drift on.
	for (const row of rowsFor(surface)) {
		const entry = rows.get(row.id) ?? {
			id: row.id,
			bound: boundId(row, implemented),
			chords: [],
			guiChords: [],
			view: viewIdOf(row.scope) ?? editorIdOf(row.scope),
			notTyping: false,
			extra: [],
			guard: undefined,
			args: row.args,
			stock: true,
			reason: row.reason,
			surfaceDrift: undefined
		};
		entry.chords.push(...keysFor(row, surface).map(label));
		if (row.only !== 'tui') {
			entry.guiChords.push(...keysFor(row, 'gui').map(label));
		}
		entry.notTyping ||= !row.whileEditing;
		for (const term of row.extraWhen?.serialize().split(' && ') ?? []) {
			if (!entry.extra.includes(term)) {
				entry.extra.push(term);
			}
		}
		entry.guard ??= expandTuiScope(row)?.serialize() ?? '(everywhere)';
		entry.stock &&= !!row.stock;
		entry.reason ??= row.reason;
		// Nine rows of one command are one row's worth of reasons: the digits carry none, and the
		// one row that does would be lost to a `??=` if a later row of the same id had none.
		entry.surfaceDrift = { ...row.surfaceDrift, ...entry.surfaceDrift };
		rows.set(row.id, entry);
	}

	for (const entry of rows.values()) {
		entry.chords = [...new Set(entry.chords)].sort();
		entry.guiChords = [...new Set(entry.guiChords)];
	}

	return rows;
}

async function main() {
	if (!ROOTS[SURFACE]) {
		console.log(`keymap: no frontend called ${JSON.stringify(SURFACE)} — pass \`--surface ${Object.keys(ROOTS).join('\` or \`--surface ')}\`.`);

		return 1;
	}

	const root = baselineRoot('keymap');
	if (!root) {
		console.log(`        ${HOW}`);

		return 0;
	}
	console.log(`keymap: --surface ${SURFACE}, from ${ROOTS[SURFACE].join(', ')}, against ${root}`);

	const implemented = await implementedIds();
	const rows = collapse(SURFACE, implemented);

	const theirs = tscodeRules(root);
	const { rules: here, registered, unread: hereUnread } = hereRules(REPO_ROOT, ROOTS[SURFACE]);
	for (const id of implemented) {
		registered.add(id);
	}
	const theirUnread = holes(theirs);

	/** What this frontend's own closure binds, per command id — the other half of the column check. */
	const registeredChords = new Map();
	for (const rule of here) {
		registeredChords.set(rule.id, [...(registeredChords.get(rule.id) ?? []), rule.chord]);
	}

	// The keep-set's id-based half, asked the way the filter asks it — the map's own commands are
	// declared to it here exactly as `keymap.contribution.ts` declares them at boot.
	const takeover = await import('../src/vs/workbench/services/keybinding/tauri/keyboardTakeover.js');
	for (const row of rows.values()) {
		if (!row.stock) {
			takeover.registerTakeoverKeepCommand(row.bound);
		}
	}
	const keptById = id => takeover.keepReason({ command: id, when: undefined }) !== undefined;

	const shared = [...rows.keys()].filter(id => theirs.has(id));
	const unknown = [...theirs].filter(([id, entry]) => !rows.has(id) && [...entry.files].some(forkLayer)).map(([id]) => id);
	console.log(`        ${rows.size} ids on this surface, ${theirs.size} ids in tscode's closure, ${shared.length} shared`);
	console.log(`        ${here.length} rules in this frontend's closure, ${registered.size} command ids registered`);
	console.log('        args is declared on both sides and readable on neither by the borrowed scanner — compared here only.');

	const column = withhold(columnAgainstRegistrations(rows, registeredChords), hereUnread);
	const diff = withhold(tupleDiff(rows, theirs), theirUnread);
	const held = unreadableFindings(unreadable(hereUnread, theirUnread), [...column.held, ...diff.held], rows);
	// `staleReasons` is asked about the withheld findings too: a reason for a divergence that was
	// withheld still explains something, and calling it stale would be the same mistake twice.
	const drifted = [...diff.drift, ...diff.held];
	const gates = [
		[`the ${SURFACE} column against the registrations`, column.drift],
		['the tuple diff against tscode', diff.drift],
		['reasons with nothing left to explain', staleReasons(rows, drifted)],
		['ids tscode answers that this map does not declare', unknown.map(id => finding('undeclared', id, '(not in KEYMAP)', [...theirs.get(id).chords].join(' · '), undefined))],
		['dangling rules', dangling(rows, registered)]
	];
	const listed = [
		['values the scan could not read', held],
		['the guard, spelled both ways', guardSpellings(rows, theirs)],
		['the keep-set hazard', keepSetHazards(rows, here, keptById)],
		['extra chords', extraChords(rows, here)]
	];

	for (const [title, findings] of gates) {
		report(title, findings, true);
	}
	for (const [title, findings] of listed) {
		report(title, findings, false);
	}

	const unreasoned = gates.flatMap(([, findings]) => findings).filter(one => !one.reason);
	console.log(`\nkeymap: ${gates.flatMap(([, findings]) => findings).length} gated findings, ${unreasoned.length} of them with no written reason.`);

	return process.argv.includes('--gate') && unreasoned.length > 0 ? 1 : 0;
}

process.exitCode = await main();
