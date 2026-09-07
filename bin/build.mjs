// The build: the Rust host, the TypeScript emit, and the assets the compiler does not emit.
//
// The three write disjoint trees — `cargo` writes `src-tauri/target/`, `tsc` writes
// `out/**/*.js` from `**/*.ts`, `copy-assets.mjs` writes the non-`.ts` files under `src/` — so
// they run concurrently rather than in sequence. `tsc` is the long pole and the other two
// finish inside it, so a one-file-edit rebuild costs `tsc` rather than the sum of three (§13.2).
//
// `tsc` is spawned as `node …/typescript/bin/tsc`, not through `node_modules/.bin/tsc`, which
// on Windows is a `.cmd` shim and costs a `cmd.exe` process.
//
// Upstream counterpart: vite.config.ts

import { spawn } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What `tsc` reads: the two trees in `include`, and the files that say how to compile them. */
const SOURCES = ['src', 'test'];
const CONFIGS = ['tsconfig.json', 'tsconfig.build.json', 'package.json', 'package-lock.json'];

/**
 * When this script last compiled the tree successfully.
 *
 * Ours rather than `out/.tsbuildinfo`, and the difference is measured: `tsc` compares file
 * *contents*, so a source whose mtime moved and whose text did not leaves the build info untouched —
 * which makes it a record of the last change rather than of the last run, and the gate below would
 * never close.
 */
const STAMP = 'out/.build-stamp';

/** The newest mtime under `paths`, or `Infinity` for anything that is not there to stat. */
function newest(paths, recursive) {
	let latest = 0;

	for (const path of paths) {
		try {
			if (!recursive) {
				latest = Math.max(latest, statSync(join(root, path)).mtimeMs);
				continue;
			}
			for (const entry of readdirSync(join(root, path), { recursive: true, withFileTypes: true })) {
				if (entry.isFile()) {
					latest = Math.max(latest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
				}
			}
		} catch {
			return Infinity;
		}
	}

	return latest;
}

/**
 * The stamp's mtime, or `0` when there is none.
 *
 * **A missing stamp is a build, never a skip**, which is the opposite of what `newest` answers and
 * is why it is not read through it: `newest` returns `Infinity` for a path it cannot stat because
 * an unreadable *source* has to force a compile, and the same answer on this side of the comparison
 * made a deleted `out/` read as newer than everything and compile nothing. The symptom was a build
 * that printed "nothing to compile" and left no `out/src/main.js` behind — a gate that passes
 * while measuring nothing, which is §17's shape to check for.
 */
function stamped() {
	try {
		return statSync(join(root, STAMP)).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Whether `out/` already holds this tree compiled.
 *
 * `tsc` is incremental and still costs about five seconds, because what it cannot skip is *parsing*
 * the 1,700-file program — and every `npm run e2e`, `npm run start` and
 * `npm run test:host` pays it whether or not anything changed. Stating the same question in mtimes
 * costs about 300 ms over 3,200 files, so a loop that edits nothing gets its build back.
 *
 * It is deliberately conservative in both directions: a *source* that cannot be stat'd answers
 * `Infinity` and a missing *stamp* answers `0`, so either one is a build. What it cannot see is a
 * *deleted* source, which leaves its stale `.js` in `out/` — the same blind spot `tsc --incremental`
 * has, and the reason `out/` is disposable.
 */
function fresh() {
	return stamped() > Math.max(newest(SOURCES, true), newest(CONFIGS, false));
}

/** Resolves when the child exits 0, and rejects naming the step otherwise. */
function run(name, command, args) {
	return new Promise((fulfil, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: 'inherit' });

		child.on('error', error => reject(new Error(`${name} could not start: ${error.message}`)));
		child.on('exit', (code, signal) => {
			if (code === 0) {
				fulfil();
			} else {
				reject(new Error(`${name} failed — ${signal ?? `exit ${code}`}`));
			}
		});
	});
}

const compiled = fresh();
if (compiled) {
	console.log('tsc: out/ is newer than every source, so nothing to compile');
}

// Started together, then awaited together: a failing step must not stop the others from
// reporting, because a build that only ever shows the first failure costs a loop per failure.
const steps = [
	// `cargo` answers the same question itself, in about half a second. `dev-small` rather than
	// `debug` because the two profiles differ only in debug info and symbols, which nothing here
	// reads, and `debug` is 1.9 GB of target directory that `npm run build` grows on every run;
	// `-j 8` leaves the rest of the machine responsive while it builds.
	run('cargo', 'cargo', ['build', '--profile', 'dev-small', '-j', '8', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'tscode-host']),
	compiled ? Promise.resolve() : run('tsc', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']),
	// `copy-assets.mjs` does its work at module scope, so importing it is running it.
	import('./copy-assets.mjs')
];

const failed = (await Promise.allSettled(steps)).filter(step => step.status === 'rejected');

for (const { reason } of failed) {
	console.error(reason instanceof Error ? reason.message : String(reason));
}

if (failed.length > 0) {
	process.exitCode = 1;
} else {
	writeFileSync(join(root, STAMP), '');
}
