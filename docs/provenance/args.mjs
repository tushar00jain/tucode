// Shared CLI options for the generated documentation.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, from this file's location — so no tool needs to be run from a fixed directory. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const flag = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
};

export const options = (defaultOut) => ({
	rev: flag('rev', 'origin/vendor'),
	tscode: flag('tscode', undefined),
	upstream: flag('upstream', flag('tscode', undefined)),
	out: process.argv[2] && !process.argv[2].startsWith('--')
		? process.argv[2]
		: resolve(dirname(fileURLToPath(import.meta.url)), defaultOut)
});
