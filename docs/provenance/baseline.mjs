// Resolve and validate a local upstream checkout for reports and keymap checks.
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { REPO, flag } from './args.mjs';
import { execFileSync } from 'node:child_process';
import { gitTree, workingTree } from './tree.mjs';

/** The environment variable that names a checkout when the sibling layout is not the one on disk. */
export const ENV = 'TUCODE_TSCODE_ROOT';

/** What a checkout has to call itself before anything is measured against it. */
const NAME = 'tscode';

/** How every tool spells the skip, so a reader is told the same thing wherever it comes from. */
export const HOW = `Pass \`--tscode <path>\`, set \`${ENV}\`, or clone tscode beside this repo.`;

/** The checkout to measure against: a flag, then the environment, then the sibling layout. */
export const tscodeRoot = () => resolve(flag('tscode', process.env[ENV] ?? resolve(REPO, '..', NAME)));

/** Whether `root` is tscode, which is the assertion above and the only thing that admits a tree. */
export function isTscode(root) {
	try {
		return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === NAME;
	} catch {
		return false;
	}
}

/**
 * The checkout, or `undefined` after saying why there is none — the resolution and its guard in
 * one call, so no tool spells the skip a second way.
 *
 * **A checkout must never resolve to itself.** That is stated separately from the name assertion
 * because it is the failure that actually happened, and a reader of the message deserves to be
 * told which of the two it hit.
 */
export function baselineRoot(what) {
	const root = tscodeRoot();

	if (root === REPO) {
		console.log(`${what}: the checkout to measure against resolved to this repo, which would compare a tree with itself — skipped. ${HOW}`);

		return undefined;
	}
	if (!isTscode(root)) {
		console.log(`${what}: no tscode checkout at ${root}, so there is nothing to measure against — skipped. ${HOW}`);

		return undefined;
	}

	return root;
}

/** Select one explicit comparison tree; no machine-specific path is stored in the report. */
export function comparisonSource(root, rev = 'origin/vendor', localRoot) {
	if (localRoot) {
		localRoot = realpathSync(resolve(localRoot));
		if (localRoot === realpathSync(root)) throw new Error('The upstream checkout must be separate from this repository');
	}
	const commit = execFileSync('git', ['-C', localRoot ?? root, 'rev-parse', '--verify', `${localRoot ? 'HEAD' : rev}^{commit}`],
		{ encoding: 'utf8', timeout: 10_000 }).trim();
	return { baseline: { ref: localRoot ? 'local upstream working tree' : rev, commit },
		tree: localRoot ? workingTree(localRoot) : gitTree(root, commit) };
}
