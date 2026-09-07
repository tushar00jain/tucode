/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Duplication over the hand-written surface — the `tauri/` directories, and nothing else.
 *
 * `npm run dup` cannot see this code. Its config ignores `src/vs/**`, which is right for the
 * vendored tree (upstream's duplication is not ours to police) and wrong for the directories
 * inside it that are ours: every `**\/tauri\/**` file is hand-written, and it is the only surface
 * where a clone is a defect we introduced. jscpd's `ignore` does not honour a negation, so the
 * scan is expressed the way the tool actually supports it — the directories as positional
 * arguments, discovered rather than listed, so a new one is covered the day it appears.
 *
 * **This gates.** It reported for one build while the clones it found were triaged; the ones that
 * were genuine extractions are gone and the ones that are stock's own duplication, carried by a
 * copy, were left where they are — so the threshold in `.jscpd.tauri.json` is what survived that
 * reading rather than what happened to be there. Like `npm run dup` it ratchets down, never up.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';


/** Every `tauri/` directory under `src/vs`, found rather than enumerated. */
function tauriDirs(root) {
	const found = [];

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		// Forward slashes, not `join`'s: jscpd resolves these through a glob matcher, and a
		// Windows separator makes it match nothing at all — silently, with a zero-file scan that
		// reads exactly like a clean result.
		const path = `${root}/${entry.name}`;
		if (entry.name === 'tauri') {
			found.push(path);
		} else {
			found.push(...tauriDirs(path));
		}
	}

	return found;
}

const dirs = tauriDirs('src/vs');
console.log(`Scanning ${dirs.length} \`tauri\` directories — the hand-written surface \`npm run dup\` cannot see.\n`);

// A gate that scans nothing passes everything, and jscpd says so only in a table nobody reads on a
// green run. Discovery finding no directory is the way that happens here — the tree moved, or the
// script is being run from somewhere other than the repository root.
if (dirs.length === 0) {
	console.error('No `tauri` directories under `src/vs`: the scan would analyse nothing and pass.');
	process.exit(1);
}

// `shell: true` because npx is a `.cmd` on Windows, which `spawnSync` will not resolve without it.
const result = spawnSync('npx', ['--yes', 'jscpd@4.0.5', '-c', '.jscpd.tauri.json', ...dirs], {
	stdio: 'inherit',
	shell: true
});

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

// jscpd's own exit code: 1 when the duplication is over `.jscpd.tauri.json`'s threshold. A signal
// leaves `status` null, which is a run that did not answer and so is not a pass.
process.exit(result.status ?? 1);
