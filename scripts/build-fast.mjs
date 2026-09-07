// The build the test loop runs on: `vite build`, `cargo build --profile dev-small`, and the
// resource copying the bundler would otherwise have done.
//
// `tauri build` has no `--profile` — verified against the CLI, which offers `--debug`,
// `--target`, `--features`, `--bundles` and `--no-bundle` and nothing else — so a profile
// tuned for link speed cannot be selected through it. It does not have to be: the suite
// needs `<target>/<profile>/tscode.exe` and the frontend bundle, and nothing the NSIS step
// produces. So this drives the two halves the CLI would have driven, in the same order.
//
// The two things the CLI does that a bare `cargo build` does not:
//
// - the frontend has to exist *before* Cargo runs, because `tauri::generate_context!`
//   embeds `frontendDist` at compile time;
// - `bundle.resources` are read at runtime out of `resourceDir()`, which for an unbundled
//   binary is the directory the binary is in. The bundler places them; here they are
//   copied. The list is read out of `tauri.conf.json` rather than restated, so it cannot
//   drift from what a real bundle would ship.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BUILD_STAMP, PROFILES, REPO_ROOT } from '../test/e2e/lib/exe.mjs';

/** The profile this builds. First in `PROFILES` is the one the suite prefers. */
const [PROFILE] = Object.keys(PROFILES);

const TAURI_CONF = join(REPO_ROOT, 'src-tauri', 'apps', 'tscode', 'tauri.conf.json');

const run = (what, command, args, options) => {
	const started = Date.now();
	// Inherited, never piped: a long-running build read through a buffering filter is a
	// build whose hang is indistinguishable from its slow parts.
	const result = spawnSync(command, args, { stdio: 'inherit', ...options });
	if (result.status !== 0) {
		throw new Error(`${what} failed (${result.status ?? result.signal})`);
	}
	const ms = Date.now() - started;
	return ms;
};

const capture = (command, args, options) => {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.status !== 0) {
		throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
	}
	return result.stdout;
};

/** Where Cargo itself says the build lands — the same answer `.cargo/config.toml` gives it. */
function targetDirectory() {
	const metadata = JSON.parse(capture('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: join(REPO_ROOT, 'src-tauri') }));
	return metadata.target_directory;
}

/** `bundle.resources`, resolved from the config's own directory as Tauri resolves them. */
function copyResources(destinationRoot) {
	const config = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
	const base = dirname(TAURI_CONF);
	const copied = [];
	for (const [from, to] of Object.entries(config.bundle?.resources ?? {})) {
		const source = resolve(base, from);
		const destination = join(destinationRoot, to);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(source, destination, { recursive: true });
		copied.push(to);
	}
	return copied;
}

// Vite's own entry rather than `npm run build`: an `npm.cmd` is a batch file, and spawning one
// needs a shell that would then be concatenating rather than escaping every argument it is given.
const vite = run('vite build', process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: REPO_ROOT });
// `custom-protocol` is the whole of the difference between a production build and a dev one, and it
// is a *feature*, not a profile: `tauri`'s build script sets `cfg(dev)` to its negation, and
// `generate_context!` reads that to choose between embedding `frontendDist` and pointing the webview
// at `devUrl`. Without it the binary builds, launches and loads `http://localhost:1420` — measured
// here as every e2e boot failing at `.monaco-workbench` against a dev-server URL. It is the one flag
// the Tauri CLI adds that a bare `cargo build` does not.
// `-j 8` on a sixteen-core machine on purpose: this runs while the machine is being used, and a
// build that takes every core makes everything else on the desktop stutter. It is also what keeps
// a build and a test run from fighting for the whole machine when both are in flight.
const cargo = run(`cargo build --profile ${PROFILE}`, 'cargo', ['build', '--profile', PROFILE, '-j', '8', '-p', 'tscode', '--features', 'tauri/custom-protocol'], { cwd: join(REPO_ROOT, 'src-tauri') });

const started = Date.now();
const outDir = join(targetDirectory(), PROFILE);
const copied = copyResources(outDir);
// Last, and only on the way out: this is what `assertFresh` reads as the build's time, so it must
// mean *this build finished*, not *this build started*.
writeFileSync(join(outDir, BUILD_STAMP), `${new Date().toISOString()}\n`);
const resources = Date.now() - started;

const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
console.log(`\nvite build     ${seconds(vite)}`);
console.log(`cargo ${PROFILE.padEnd(9)} ${seconds(cargo)}`);
console.log(`resources      ${seconds(resources)}  (${copied.join(', ')})`);
console.log(`total          ${seconds(vite + cargo + resources)}`);
console.log(`\n${join(outDir, process.platform === 'win32' ? 'tscode.exe' : 'tscode')}`);
