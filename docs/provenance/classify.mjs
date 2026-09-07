// Repository-wide content differences against a Git baseline. No authorship inference.
// node docs/provenance/classify.mjs [out.json] [--rev origin/vendor]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, options } from './args.mjs';
import { workingTree, SKIP_DIRS } from './tree.mjs';
import { comparisonSource } from './baseline.mjs';
import { documentation } from '../config.mjs';

export const RENAME_THRESHOLD = 50;
export const RENAME_LIMIT = 200;
export const METRICS = ['unchanged', 'added', 'removed', 'newLines', 'current', 'baseline'];
export const EXCLUSIONS = ['package-lock.json', 'src-tauri/Cargo.lock'];
const GENERATED_REPORT = /(?:^|\/)provenance(?:\/provenance)?\.html$/;

export function countLines(text) {
	return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Count UTF-8 text, including SVG. Preserve binary bytes for Git's content comparison.
function content(bytes) {
	try {
		if (bytes.includes(0)) return { bytes, text: null };
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
		return { bytes: Buffer.from(text), text };
	} catch { return { bytes, text: null }; }
}

export function totals(files) {
	return files.reduce((sum, file) => {
		for (const metric of METRICS) sum[metric] += file[metric];
		sum.files++;
		if (file.binary) sum.binary++;
		return sum;
	}, { ...Object.fromEntries(METRICS.map(key => [key, 0])), files: 0, binary: 0 });
}

function inventory(tree) {
	const files = new Map();
	for (const path of tree.list()) {
		if (EXCLUSIONS.includes(path) || GENERATED_REPORT.test(path)) continue;
		const file = content(tree.readBytes(path));
		// Generated documentation is output, including its embedded dataset and layout.
		if (path.endsWith('.html') && file.text?.includes('<script id="data" type="application/json">')) continue;
		files.set(path, file);
	}
	return files;
}

function snapshot(files, other, destination) {
	mkdirSync(destination, { recursive: true });
	for (const [path, file] of files) {
		// Unchanged files need no disk copy or line diff. Keep attributes for Git's binary rules.
		if (other.get(path)?.bytes.equals(file.bytes) && !path.endsWith('.gitattributes')) continue;
		mkdirSync(dirname(join(destination, path)), { recursive: true });
		writeFileSync(join(destination, path), file.bytes);
	}
}

/** Compare checkouts directly; materialize changed blobs only for a Git-object baseline.
 * Git's real index, objects, refs, and working tree are never modified.
 */
export function compareTrees(upstream, current) {
	const local = upstream.root && !upstream.rev && current.root && !current.rev;
	const scratch = local ? null : mkdtempSync(join(tmpdir(), 'tucode-provenance-'));
	try {
		const before = inventory(upstream), after = inventory(current);
		const oldRoot = local ? upstream.root : 'before';
		const newRoot = local ? current.root : 'after';
		const changed = [...new Set([...before.keys(), ...after.keys()])]
			.filter(path => !before.has(path) || !after.has(path) || !before.get(path).bytes.equals(after.get(path).bytes));
		// A path ignored on one side must not cause Git to read its excluded contents.
		const omitted = new Set(local ? changed.filter(path =>
			(!before.has(path) && upstream.has(path)) || (!after.has(path) && current.has(path))) : []);
		const paths = changed.filter(path => !omitted.has(path));
		if (!local) {
			snapshot(before, after, join(scratch, 'before'));
			snapshot(after, before, join(scratch, 'after'));
		}
		// Local mode reads only inventoried changed paths directly; never traverses dependencies.
		// Requires Git support for pathspecs after the two no-index directories.
		const result = local && !paths.length ? { status: 0, stdout: '' } : spawnSync('git',
			['-c', 'diff.algorithm=myers', '-c', `diff.renamelimit=${RENAME_LIMIT}`,
			'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-indent-heuristic', '--ignore-cr-at-eol',
			`--find-renames=${RENAME_THRESHOLD}%`, '--numstat', '-z', '--', oldRoot, newRoot,
			...(local ? paths.map(path => `:(literal)${path}`) : [])],
			{ cwd: scratch ?? current.root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 30_000 });
		if (result.error) throw result.error;
		if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'Git diff failed');
		const files = [];
		const seenBefore = new Set(), seenAfter = new Set();
		function record(oldPath, path, additions = 0, removals = 0, binaryDiff = false) {
			const old = before.get(oldPath), now = after.get(path);
			if (!old && !now) throw new Error('Git diff returned an unknown path');
			if (oldPath) seenBefore.add(oldPath);
			if (path) seenAfter.add(path);
			const binary = binaryDiff || old?.text === null || now?.text === null;
			const baseline = binary ? 0 : countLines(old?.text ?? '');
			const current = binary ? 0 : countLines(now?.text ?? '');
			const status = !old ? 'added' : !now ? 'deleted' : oldPath !== path ? 'renamed'
				: old.bytes.equals(now.bytes) ? 'unchanged' : 'modified';
			const added = binary || !old ? 0 : additions;
			const removed = binary ? 0 : !now ? baseline : removals;
			const newLines = !old ? current : 0;
			const unchanged = current - added - newLines;
			if (unchanged < 0 || baseline !== unchanged + removed) {
				throw new Error(`Line totals do not reconcile: ${path || oldPath}`);
			}
			files.push({ path: path || oldPath, previousPath: oldPath && path && oldPath !== path ? oldPath : null,
				status, binary, unchanged, added, removed, newLines, current, baseline });
		}

		for (const path of omitted) record(before.has(path) ? path : null, after.has(path) ? path : null);

		// -z emits separate old/new names for no-index comparisons; never parse quoted paths.
		const fields = result.stdout.split('\0');
		for (let i = 0; i < fields.length && fields[i];) {
			const [add, del, name] = fields[i++].split('\t');
			const oldName = name || fields[i++];
			const newName = name || fields[i++];
			const oldPath = oldName.startsWith(oldRoot + '/') ? oldName.slice(oldRoot.length + 1) : null;
			const path = newName.startsWith(newRoot + '/') ? newName.slice(newRoot.length + 1) : null;
			record(oldPath, path, Number(add) || 0, Number(del) || 0, add === '-' || del === '-');
		}
		for (const [path, file] of after) {
			if (seenAfter.has(path)) continue;
			const old = before.get(path);
			if (!old || !old.bytes.equals(file.bytes)) throw new Error(`Missing diff record: ${path}`);
			record(path, path);
		}
		for (const path of before.keys()) {
			if (!seenBefore.has(path)) throw new Error(`Missing baseline record: ${path}`);
		}
		files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		return { files, totals: totals(files) };
	} finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

export function generateReport(root = REPO, rev = 'origin/vendor', localRoot) {
	const { baseline, tree } = comparisonSource(root, rev, localRoot);
	return { version: 2, project: documentation(root).project, baseline, renameThreshold: RENAME_THRESHOLD, renameLimit: RENAME_LIMIT,
		exclusions: EXCLUSIONS, excludedDirectories: [...SKIP_DIRS], ...compareTrees(tree, workingTree(root)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { rev, out, upstream } = options('tree.json');
	const report = generateReport(REPO, rev, upstream);
	writeFileSync(out, JSON.stringify(report));
	console.log(JSON.stringify(report.totals));
}
