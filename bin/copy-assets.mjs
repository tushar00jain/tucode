// Everything under `src/` that the compiler does not emit, mirrored into `out/src/`.
//
// Three vendored libraries ship as plain `.js` beside a `.d.ts` — `marked`, `dompurify`,
// `semver`. TypeScript resolves `./marked/marked.js` to the declaration, so the
// implementation never enters the program and never reaches `out/`, while the emitted code
// still imports it. Vite bundled them; this copies them. Licences and `cgmanifest.json`
// files come along, as upstream's own build copies them.
//
// Only what changed is copied, and only what could ever be copied is looked at: `src/` holds
// 3,124 `.ts` files against 41 of these, and `cp`'s filter stats every path it walks before
// rejecting it. The walk decides on the name and stats a candidate only.
//
// Upstream counterpart: vite.config.ts

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'src');
const to = resolve(root, 'out', 'src');

/** True when `copy` is not already there at the same size and no older than `source`. */
async function stale(copy, source) {
	try {
		const existing = await stat(copy);

		return existing.size !== source.size || existing.mtimeMs < source.mtimeMs;
	} catch {
		return true; // not copied yet
	}
}

async function mirror(dir) {
	const entries = await readdir(dir, { withFileTypes: true });

	await Promise.all(entries.map(async entry => {
		const path = join(dir, entry.name);

		if (entry.isDirectory()) {
			return mirror(path);
		}

		// Anything the compiler emits, which is `.ts` everywhere and also the `.js` engine under
		// `src/vendor/` that `allowJs` puts through `tsc`. Copying that one too would make
		// `out/src/vendor/codemirror-vim/vim.js` a path with two writers racing from the same build.
		if (entry.name.endsWith('.ts') || relative(from, path).split(/[\\/]/)[0] === 'vendor') {
			return;
		}

		const copy = resolve(to, relative(from, path));

		if (await stale(copy, await stat(path))) {
			await mkdir(dirname(copy), { recursive: true });
			await copyFile(path, copy);
		}
	}));
}

await mirror(from);
