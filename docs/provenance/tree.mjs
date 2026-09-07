// A file tree the provenance tools can read, whether it is on disk or in a git revision.
//
// The baseline is read from Git objects; current files come from the working tree.
//
// Upstream counterpart: docs/provenance/classify.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Line endings are normalised on read, so a checkout's autocrlf never reads as a difference. */
const normalise = (body) => body.replace(/\r\n/g, '\n');

const BINARY = /\.(png|jpg|jpeg|gif|ico|ttf|woff2?|wasm|icns|exe|dll|pdb|zip|svg|otf|eot|mp3|wav)$/i;

/** Build output, dependencies and generated artefacts are not authored code. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.build', 'target', 'gen', 'icons', '.vite', 'out']);

/**
 * The repo as it stands. `read` answers null for a binary, an oversized or an unreadable file,
 * which is how the classifier tells "no text to compare" from "no such file".
 */
export function workingTree(root) {
	const REPO = resolve(root);
	let listed = null;

	return {
		name: 'working tree',
		root: REPO,
		readBytes: (rel) => readFileSync(join(REPO, rel)),
		has: (rel) => existsSync(join(REPO, rel)) && statSync(join(REPO, rel)).isFile(),
		read(rel) {
			const path = join(REPO, rel);
			if (BINARY.test(path)) return null;
			try {
				if (statSync(path).size > 4_000_000) return null;
				const body = readFileSync(path, 'utf8');
				return body.includes('\u0000') ? null : normalise(body);
			} catch { return null; }
		},
		list() {
			if (listed) return listed;
			// Include pending source files, but never publish ignored local metadata or secrets.
			const paths = execFileSync('git', ['-C', REPO, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
				{ encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0');
			listed = [...new Set(paths)].filter(rel => {
				if (!rel || rel.split('/').slice(0, -1).some(dir => SKIP_DIRS.has(dir))) return false;
				try { return lstatSync(join(REPO, rel)).isFile(); } catch { return false; }
			}).sort();
			return listed;
		}
	};
}

/**
 * A git revision, read through `git cat-file --batch` — one child process for the whole tree
 * rather than one per file, which is the difference between 0.3 s and minutes for a 3,500-file
 * upstream. Blobs load lazily per top-level directory, so a caller that only wants `src/` never
 * pays for `resources/`.
 */
export function gitTree(root, rev) {
	const REPO = resolve(root);
	const git = (args, options = {}) =>
		execFileSync('git', ['-C', REPO, ...args], { maxBuffer: 1 << 29, ...options });

	// `-z` rather than the default: git quotes and escapes any path with a special character in
	// it otherwise, and a quoted path is not the path.
	const shas = new Map();                                     // rel -> blob sha
	for (const record of git(['ls-tree', '-r', '-z', rev], { encoding: 'utf8' }).split('\0')) {
		if (!record) continue;
		const tab = record.indexOf('\t');
		const [mode, type, sha] = record.slice(0, tab).split(' ');
		if (type === 'blob' && mode !== '120000') shas.set(record.slice(tab + 1), sha);
	}

	const loaded = new Set();                                   // top-level dirs already batched
	const bodies = new Map();                                   // rel -> Buffer

	function load(prefix) {
		if (loaded.has(prefix)) return;
		loaded.add(prefix);
		const want = [...shas.keys()].filter(rel => rel.startsWith(prefix));
		if (!want.length) return;

		// `--batch` streams `<sha> blob <size>\n<contents>\n` per request, in request order.
		const batch = git(['cat-file', '--batch'], { input: want.map(rel => shas.get(rel)).join('\n') + '\n' });
		let at = 0;
		for (const rel of want) {
			const header = batch.indexOf('\n', at);
			const size = Number(batch.toString('utf8', at, header).split(' ')[2]);
			const start = header + 1;
			const blob = batch.subarray(start, start + size);
			bodies.set(rel, blob);
			at = start + size + 1;
		}
	}

	return {
		name: `git ${rev}`,
		root: REPO,
		rev,
		has: (rel) => shas.has(rel),
		readBytes(rel) {
			if (!shas.has(rel)) return null;
			load(rel.includes('/') ? rel.split('/')[0] + '/' : rel);
			return bodies.get(rel);
		},
		read(rel) {
			const body = this.readBytes(rel);
			return !body || BINARY.test(rel) || body.includes(0) ? null : normalise(body.toString('utf8'));
		},
		list: () => [...shas.keys()].filter(rel => !rel.split('/').slice(0, -1).some(dir => SKIP_DIRS.has(dir))).sort()
	};
}
