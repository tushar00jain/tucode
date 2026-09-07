/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The keymap instrument: `keymap.ts` against the keys a sibling checkout actually registers, and
 * against upstream's own default set.
 *
 * **Why it exists.** Where the same keyboard is declared in two places — once here as `KEYMAP`,
 * once there as `registerTuiCommand`/`registerPaneCommand` calls — the two declarations drift. A
 * survey read fifteen rows by hand and found them agreeing, which is reassurance rather than
 * evidence; this is the mechanical answer, and it goes on being one once the sibling's copy becomes
 * an import, because upstream's set is still moving underneath both.
 *
 * **The sibling's own scanner does the reading.** Its `scripts/keymap-bindings.mjs` already
 * knows how to find a registration, follow a constant across an import, and label a chord the way
 * upstream labels one. Reading those files again from here would be a second extractor with a
 * second set of bugs, so this imports that one — and points it at *this* tree too, for the upstream
 * set. That is the one property of this instrument worth protecting.
 *
 * **Five checks**, each of which found something real when the sweep ran them by hand. The first
 * four are mechanical, so they gate; the rest are readings a person makes, so they list.
 *
 * | check | what a finding means | gates |
 * | --- | --- | --- |
 * | the tuple diff | one id, two registrations, and a chord, a scope or a count of guard terms that disagrees | yes |
 * | stale reasons | a `surfaceDrift` entry explaining a divergence that is no longer measured | yes |
 * | undeclared ids | the sibling answers a key this map does not declare at all | yes |
 * | dangling rules | a row binds a command nothing in this app's boot closure registers | yes |
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
 * no written reason, **and the pre-commit hook runs it**. It went in once the three rows it opened
 * with were settled: one was this script's own defect, and the other two were real differences the
 * row format could not record until `surfaceDrift` arrived — which is the shape a first run's
 * findings take, and why a gate is wired after the instrument has been believed rather than before.
 *
 * It **skips, with a message that says how to point it somewhere**, when there is no sibling
 * checkout: a clone with only this repo in it is the ordinary case and must not fail.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { editorIdOf, expandTuiScope, KEYMAP, KeymapDrift, keysFor, viewIdOf } from '../src/vs/workbench/browser/tauri/keymap.js';
import { chordLabel as label } from './chordLabel.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCANNER_MODULES = ['scripts/keymap-bindings.mjs', 'docs/keyboard/closure.mjs',
	'docs/keyboard/registrations.mjs', 'docs/provenance/tree.mjs'];

/** The boot file that makes a closure a closure, on both sides. */
const ROOTS = ['src/main.ts'];


/** "The user is not typing", as the scanned guard writes it — `keybindings.mjs`'s `guard`. */
const NOT_TYPING = 'InputFocusedContext.negate()';

const flag = name => {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? undefined : process.argv[at + 1];
};

/**
 * The checkout to measure against: an argument, then the environment, then the sibling layout —
 * the precedence `scripts/vscode-source.ps1` resolves a VS Code checkout with, because it is the
 * same question. `undefined` when there is none, which is a skip and not a failure.
 */
function forkRoot() {
	const named = flag('tucode') ?? process.env.TSCODE_TUCODE_ROOT ?? resolve(REPO_ROOT, '..', 'tucode');
	const root = resolve(named);

	return existsSync(resolve(root, SCANNER_MODULES[0])) ? root : undefined;
}


/** The sibling's scanner and tree reader, imported rather than reimplemented. */
async function forkTools(root) {
	const at = name => pathToFileURL(resolve(root, name)).href;
	const [keybindings, closure, registrations, tree] = await Promise.all(
		SCANNER_MODULES.map(name => import(at(name))));

	return { keybindings, closure, registrations, tree };
}

/** How the scanned guard states the view a rule is scoped to. */
const VIEW_TERM = /^FocusedViewContext\.isEqualTo\('(.*)'\)$/;

/**
 * Every rule the measured checkout's own files declare, as `(id, chords, view, whileEditing, when)`.
 *
 * **`rows()` is that checkout's own reading of its own rules, and this takes it whole.** It already
 * excludes the vendored copy of this tree, resolves a command that is *declared* rather than bound
 * to the upstream rule that carries its key, and turns a `primary`/`secondary` pair into chord
 * labels. This module used to do all three again, and the third of them was wrong: it split
 * `secondary` on every comma, so a `[KeyChord(a, b)]` came apart into two halves that parse as
 * nothing and the chord vanished — which is how `workbench.action.openGlobalKeybindings` was
 * measured as `?` alone with `Ctrl+K Ctrl+S` bound beside it. A second extractor with a second set
 * of bugs is exactly what this file's header says not to build.
 *
 * The two arguments it takes and this does not need are answered flat: the upstream key of a
 * command is what the tuple diff computes for itself, and every chord is deliverable here because
 * what a terminal's wire can carry is not this app's question.
 */
function forkRules({ keybindings, tree }, root) {
	const fork = tree.workingTree(root);
	const labels = keybindings.keyCodeLabels(fork);
	const out = new Map();

	for (const row of keybindings.rows(keybindings.rules(fork, ROOTS), () => keybindings.ABSENT, labels, () => true)) {
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

/**
 * Every keybinding rule in *this* app's boot closure, and every command id it registers. The
 * expressions it could not read come back too, for the caller that gates on a comparison over them
 * — which here is none: what this feeds is the keep-set and the extra-chord list, both readings.
 */
function upstreamRules({ keybindings, closure, registrations, tree }, root) {
	const here = tree.workingTree(root);
	const labels = keybindings.keyCodeLabels(here);
	const { scan } = registrations.scanner(registrations.loadTypeScript(root), keybindings.injectedKeys(ROOTS));
	const reached = closure.closure(here, ROOTS);
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
 * **`unread` is the holes on the side the check actually read**, and only that side. The tuple diff
 * reads the sibling's registrations; withholding its findings for a hole in this app's own closure
 * would hide real drift, which is the same disservice in the other direction.
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
 * The tuple diff — `(id, chord, scope, args)` per row, this frontend's expansion against the
 * fork's. The guard is compared as the scope it came from rather than as a serialized `when`: the
 * one thing the two declarations cannot spell alike is the guard, which is why `scope` is symbolic
 * in the first place, so a string comparison of two `when`s would report the design as drift.
 *
 * A difference is answered by the row's `surfaceDrift` entry for *that* comparison, and by nothing
 * else: `reason` covers the drifts a row declares — `only` and `guiKeys` — and a chord split
 * legitimately declared there would otherwise launder a guard nobody explained.
 */
function tupleDiff(rows, fork) {
	const findings = [];
	const list = terms => [...terms].sort().join(' · ') || '(none)';
	const why = (tuple, kind) => tuple.surfaceDrift?.[kind] ?? tuple.reason;

	for (const [id, tuple] of rows) {
		const theirs = fork.get(id);
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
function guardSpellings(rows, fork) {
	return [...rows.values()]
		.map(row => ({ row, theirs: fork.get(row.id) }))
		.filter(({ row, theirs }) => theirs && (row.extra.length > 0 || theirs.extra.size > 0))
		.map(({ row, theirs }) => finding('guard', row.id, row.guard, theirs.guard, row.reason));
}

/** A row whose rule binds a command nothing registers: a key that silently does nothing. */
function dangling(rows, registered) {
	return [...rows.values()]
		.filter(row => !row.stock && row.only !== 'tui' && !registered.has(row.bound))
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
 */
function keepSetHazards(rows, upstream, keptById) {
	const byChord = new Map();
	for (const rule of upstream) {
		byChord.set(rule.chord, [...new Set([...(byChord.get(rule.chord) ?? []), rule.id])]);
	}

	const claimed = new Map();
	for (const row of rows.values()) {
		if (row.only === 'tui') {
			continue;
		}
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
		.filter(row => !row.stock && row.only !== 'tui')
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

async function main() {
	const root = forkRoot();
	if (!root) {
		console.log('keymap: no sibling checkout found, so the two declarations cannot be compared — skipped.');
		console.log('        Pass `--tucode <path>`, set `TSCODE_TUCODE_ROOT`, or clone it beside this repo.');
		return 0;
	}
	console.log(`keymap: comparing against ${root}`);

	const tools = await forkTools(root);
	const implemented = await implementedIds();
	const rows = new Map();

	for (const row of KEYMAP) {
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
			only: row.only,
			reason: row.reason,
			surfaceDrift: undefined
		};
		if (row.only !== 'gui') {
			entry.chords.push(...keysFor(row, 'tui').map(label));
		}
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

	const fork = forkRules(tools, root);
	const { rules: upstream, registered } = upstreamRules(tools, REPO_ROOT);
	for (const id of implemented) {
		registered.add(id);
	}
	// The keep-set's id-based half, asked the way the filter asks it — the map's own commands are
	// declared to it here exactly as `keymap.contribution.ts` declares them at boot.
	const takeover = await import('../src/vs/workbench/services/keybinding/tauri/keyboardTakeover.js');
	for (const row of rows.values()) {
		if (!row.stock && row.only !== 'tui') {
			takeover.registerTakeoverKeepCommand(row.bound);
		}
	}
	const keptById = id => takeover.keepReason({ command: id, when: undefined }) !== undefined;

	const shared = [...rows.keys()].filter(id => fork.has(id));
	const unknown = [...fork.keys()].filter(id => !rows.has(id));
	console.log(`        ${KEYMAP.length} rows / ${rows.size} ids here, ${fork.size} ids there, ${shared.length} shared`);
	console.log(`        ${upstream.length} upstream rules in this app's closure, ${registered.size} command ids registered`);
	console.log('        args is declared on both sides and readable on neither by the borrowed scanner — compared here only.');

	const forkUnread = holes(fork);
	const diff = withhold(tupleDiff(rows, fork), forkUnread);
	const held = unreadableFindings(forkUnread, diff.held, rows);
	// `staleReasons` is asked about the withheld findings too: a reason for a divergence that was
	// withheld still explains something, and calling it stale would be the same mistake twice.
	const drifted = [...diff.drift, ...diff.held];
	const gates = [
		['the tuple diff', diff.drift],
		['reasons with nothing left to explain', staleReasons(rows, drifted)],
		['ids the sibling answers that this map does not declare', unknown.map(id => finding('undeclared', id, '(not in KEYMAP)', [...fork.get(id).chords].join(' · '), undefined))],
		['dangling rules', dangling(rows, registered)]
	];
	const listed = [
		['values the scan could not read', held],
		['the guard, spelled both ways', guardSpellings(rows, fork)],
		['the keep-set hazard', keepSetHazards(rows, upstream, keptById)],
		['extra chords', extraChords(rows, upstream)]
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
