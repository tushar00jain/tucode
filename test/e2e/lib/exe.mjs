// Locating the built application, and proving it is not stale.
//
// `CARGO_TARGET_DIR` and a `.cargo/config.toml` `build.target-dir` both move the
// build out of `src-tauri/target`, and both apply to `npm run tauri:build` as much
// as to a bare `cargo build` — the Tauri CLI spawns Cargo with its own environment
// and settles the target directory the way Cargo does. So the same repo can hold a
// release binary in any of the three, including one left behind by a setting that
// has since changed. All three are checked, the newest wins, and the caller is told
// which it got.
//
// Which binary is wanted stays a parameter, even though `tscode` is the only one:
// it is the Cargo package under `src-tauri/apps/`.
//
// The *profile* is the other half of the path, and there is more than one: `release`
// is what `npm run tauri:build` produces, and `dev-small` is what `npm run build:fast`
// produces for this suite — an unoptimised binary that boots the same workbench for a
// fraction of the link time. Both are searched, the newest of all of them wins, and a
// missing-build error names the script that produces the preferred one. `PROFILES` is
// the single home of that list: `scripts/build-fast.mjs` imports it rather than
// spelling `dev-small` a second time.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, resolved from this file rather than from the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The Cargo profiles a run may be made against, in preference order — the first is what
 * a missing-build error tells the caller to build. Each names the script that produces it.
 */
export const PROFILES = {
	'dev-small': { build: 'npm run build:fast' },
	release: { build: 'npm run tauri:build' }
};

/**
 * What `scripts/build-fast.mjs` touches beside the binary when a build completes.
 *
 * The freshness rule below is about *the build*, and the binary's own mtime is only a proxy for
 * it — one that Cargo is right to break: a rebuild whose inputs did not change relinks nothing and
 * leaves the artefact where it was, which then reads as stale against every source edit made since.
 * A frontend-only change is the everyday case of that, and it made the suite unrunnable. The stamp
 * is written only after a build exits 0, so "the build exited 0" still cannot launder an artefact
 * that build did not produce.
 */
export const BUILD_STAMP = '.tscode-build';

const exeName = binary => process.platform === 'win32' ? `${binary}.exe` : binary;

/** Directories whose newest file the binary must be newer than. */
const SOURCE_DIRS = ['src', 'src-tauri/apps', 'src-tauri/crates', 'resources'];

/** Individual files outside those directories that the build also consumes. */
const SOURCE_FILES = [
	'index.html',
	'package.json',
	'product.json',
	'tsconfig.json',
	'vite.config.ts',
	'src-tauri/Cargo.toml'
];

// `gen/` is written by each app's build script *during* the build, so a run that
// counted it would find every binary older than its own build and call it stale.
const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist', 'gen']);

/** When the build that produced a binary ran: its stamp, or the binary itself where there is none. */
function buildTime(path) {
	const stamp = join(dirname(path), BUILD_STAMP);
	return Math.max(statSync(path).mtimeMs, existsSync(stamp) ? statSync(stamp).mtimeMs : 0);
}

function cargoConfigTargetDir(repoRoot) {
	for (const candidate of [join(repoRoot, 'src-tauri', '.cargo', 'config.toml'), join(repoRoot, '.cargo', 'config.toml')]) {
		if (!existsSync(candidate)) {
			continue;
		}
		const match = readFileSync(candidate, 'utf8').match(/^\s*target-dir\s*=\s*["']([^"']+)["']/m);
		if (match) {
			return resolve(repoRoot, match[1]);
		}
	}
	return undefined;
}

/**
 * @param {string} repoRoot
 * @param {string} binary which application to run
 * @returns {{ binary: string, profile: string, path: string, targetDir: string, origin: string, mtimeMs: number }}
 * @throws if no build of that binary exists in any known target directory, under any profile.
 */
export function locateExe(repoRoot, binary) {
	/** @type {{ dir: string, origin: string }[]} */
	const searched = [];
	const add = (dir, origin) => {
		if (dir && !searched.some(entry => entry.dir === dir)) {
			searched.push({ dir, origin });
		}
	};
	add(join(repoRoot, 'src-tauri', 'target'), 'src-tauri/target');
	add(process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : undefined, 'CARGO_TARGET_DIR');
	add(cargoConfigTargetDir(repoRoot), '.cargo/config.toml build.target-dir');

	const candidates = searched.flatMap(entry => Object.keys(PROFILES).map(profile => ({
		...entry,
		profile,
		path: join(entry.dir, profile, exeName(binary))
	})));

	const found = candidates
		.filter(entry => existsSync(entry.path))
		.map(entry => ({
			binary,
			profile: entry.profile,
			targetDir: entry.dir,
			origin: entry.origin,
			path: entry.path,
			mtimeMs: statSync(entry.path).mtimeMs,
			builtMs: buildTime(entry.path)
		}))
		.sort((a, b) => b.builtMs - a.builtMs);

	if (found.length === 0) {
		const list = candidates.map(entry => `  ${entry.path}  (${entry.origin})`).join('\n');
		const [preferred] = Object.keys(PROFILES);
		throw new Error(`no build of ${exeName(binary)} found. Looked in:\n${list}\nBuild it with: ${PROFILES[preferred].build}`);
	}
	return found[0];
}

function newestUnder(path, worst) {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return worst;
	}
	if (stat.isFile()) {
		return stat.mtimeMs > worst.mtimeMs ? { path, mtimeMs: stat.mtimeMs } : worst;
	}
	if (!stat.isDirectory()) {
		return worst;
	}
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
			continue;
		}
		worst = newestUnder(join(path, entry.name), worst);
	}
	return worst;
}

/** The most recently modified source file the build consumes. */
export function newestSource(repoRoot) {
	let newest = { path: repoRoot, mtimeMs: 0 };
	for (const relative of [...SOURCE_DIRS, ...SOURCE_FILES]) {
		newest = newestUnder(join(repoRoot, relative), newest);
	}
	return newest;
}

/**
 * "The build exited 0" has twice meant a stale artefact, so the suite refuses to
 * draw conclusions from a binary older than the sources it was built from.
 */
export function assertFresh(repoRoot, exe) {
	const source = newestSource(repoRoot);
	if (exe.builtMs < source.mtimeMs) {
		throw new Error(
			`stale build: ${exe.path}\n` +
			`  built ${new Date(exe.builtMs).toISOString()}\n` +
			`  but ${source.path} changed ${new Date(source.mtimeMs).toISOString()}\n` +
			`Rebuild with: ${PROFILES[exe.profile].build}`
		);
	}
	return source;
}

/**
 * The binary a run will be made against, proved fresh — and the two together, because they are a
 * pairing that has to travel: locating a binary without checking it is how a run draws conclusions
 * from a stale artefact.
 *
 * **Called before anything expensive.** The freshness refusal used to land after the fixture had
 * been generated, so a run that could never have been valid still spent twenty seconds building a
 * workspace it then threw away — the check is cheap and the refusal is certain, so it goes first.
 */
export function readyExe(repoRoot, binary, log = () => { }) {
	const exe = locateExe(repoRoot, binary);
	const source = assertFresh(repoRoot, exe);
	log(`exe   ${exe.path}`);
	log(`      ${exe.profile}, from ${exe.origin}, built ${new Date(exe.builtMs).toISOString()}`);
	log(`      newest source ${new Date(source.mtimeMs).toISOString()}`);
	return exe;
}
