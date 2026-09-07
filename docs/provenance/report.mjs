// Generates the complete report from measured data. This file owns layout and metric definitions;
// the output HTML contains no maintained narrative or manually entered results.
import { METRICS, totals } from './classify.mjs';

const STATUSES = ['unchanged', 'modified', 'added', 'deleted', 'renamed'];

export function packReport(report) {
	const directories = [], index = new Map();
	const files = report.files.map(file => {
		const slash = file.path.lastIndexOf('/');
		const directory = file.path.slice(0, slash + 1);
		if (!index.has(directory)) { index.set(directory, directories.length); directories.push(directory); }
		return [index.get(directory), file.path.slice(slash + 1), STATUSES.indexOf(file.status),
			file.unchanged, file.added, file.removed, file.newLines, file.binary ? 1 : 0, file.previousPath];
	});
	return { ...report, directories, files };
}

export function unpackReport(report) {
	const { directories, ...data } = report;
	return { ...data, files: report.files.map(([directory, name, status, unchanged, added, removed, newLines, binary, previousPath]) => ({
		path: directories[directory] + name, status: STATUSES[status], unchanged, added, removed, newLines,
		binary: !!binary, previousPath, current: unchanged + added + newLines, baseline: unchanged + removed,
	})) };
}

export function selectFiles(files, query = '', status = 'all') {
	const needle = query.trim().toLowerCase();
	return files.filter(file => (status === 'all' || file.status === status)
		&& (!needle || file.path.toLowerCase().includes(needle) || file.previousPath?.toLowerCase().includes(needle)));
}

export function fileTree(files) {
	const root = { name: '', path: '', dirs: new Map(), files: [], totals: totals([]) };
	for (const file of files) {
		let node = root;
		const parts = file.path.split('/');
		for (const name of parts.slice(0, -1)) {
			const path = node.path ? `${node.path}/${name}` : name;
			if (!node.dirs.has(name)) node.dirs.set(name, { name, path, dirs: new Map(), files: [], totals: totals([]) });
			node = node.dirs.get(name);
		}
		node.files.push(file);
	}
	function sum(node) {
		node.totals = totals(node.files);
		for (const dir of node.dirs.values()) {
			sum(dir);
			for (const key of [...METRICS, 'files', 'binary']) node.totals[key] += dir.totals[key];
		}
	}
	sum(root);
	return root;
}

function browserMain() {
	const report = unpackReport(JSON.parse(document.getElementById('data').textContent));
	const numberFormat = new Intl.NumberFormat('en-US');
	const fmt = value => numberFormat.format(value);
	const open = new Set(['src', 'mac', 'test', 'src-tauri']);
	const statuses = { unchanged: 'Unchanged', modified: 'Modified', added: 'New file', deleted: 'Deleted', renamed: 'Renamed' };
	const search = document.getElementById('search');
	const status = document.getElementById('status');
	const tree = document.getElementById('tree');
	function cell(className, text) {
		const element = document.createElement('span');
		element.className = className;
		element.textContent = text;
		return element;
	}
	function metrics(row, values, binary = false) {
		row.append(cell('number unchanged', binary ? '—' : fmt(values.unchanged)));
		const edited = cell('number edits', '');
		edited.append(cell('plus', binary ? '—' : `+${fmt(values.added)}`), cell('minus', binary ? '' : `−${fmt(values.removed)}`));
		row.append(edited, cell('number new', binary ? '—' : `+${fmt(values.newLines)}`), cell('number current', binary ? '—' : fmt(values.current)));
	}
	function draw(node, target, depth, narrowed) {
		for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
			const details = document.createElement('details');
			details.dataset.path = dir.path;
			details.open = open.has(dir.path) || (narrowed && depth < 3);
			const summary = document.createElement('summary');
			summary.className = 'row directory';
			const name = cell('path', '');
			name.style.paddingLeft = `${depth * 16}px`;
			name.append(cell('arrow', ''), cell('filename', `${dir.name}/`));
			summary.append(name, cell('status', `${fmt(dir.totals.files)} files`));
			metrics(summary, dir.totals);
			details.append(summary);
			details.addEventListener('toggle', () => { if (details.open) open.add(dir.path); else open.delete(dir.path); });
			let populated = false;
			const populate = () => {
				if (populated || !details.open) return;
				populated = true;
				draw(dir, details, depth + 1, narrowed);
			};
			populate();
			details.addEventListener('toggle', populate);
			target.append(details);
		}
		for (const file of node.files) {
			const row = document.createElement('div');
			row.className = 'row file';
			row.dataset.path = file.path;
			const name = cell('path', '');
			name.style.paddingLeft = `${depth * 16 + 16}px`;
			name.append(cell('filename', file.path.split('/').at(-1)));
			name.title = file.path;
			if (file.previousPath) {
				const previous = cell('previous', `from ${file.previousPath}`);
				name.append(previous);
			}
			row.append(name, cell(`status ${file.status}`, `${statuses[file.status]}${file.binary ? ' · binary' : ''}`));
			metrics(row, file, file.binary);
			target.append(row);
		}
	}
	function render(narrowed = !!search.value.trim()) {
		const files = selectFiles(report.files, search.value, status.value);
		const root = fileTree(files);
		const sum = root.totals;
		for (const key of ['unchanged', 'added', 'removed', 'newLines']) document.getElementById(key).textContent = fmt(sum[key]);
		document.getElementById('scope').textContent = `${files.length === report.files.length ? 'All files' : 'Filtered files'} · ${fmt(files.length)} of ${fmt(report.files.length)} file comparisons · ${fmt(sum.binary)} binary`;
		document.getElementById('equations').textContent =
			`Current: ${fmt(sum.current)} = ${fmt(sum.unchanged)} unchanged + ${fmt(sum.added)} edited additions + ${fmt(sum.newLines)} new-file additions. Baseline: ${fmt(sum.baseline)} = ${fmt(sum.unchanged)} unchanged + ${fmt(sum.removed)} removed.`;
		const footer = document.getElementById('tree-total');
		footer.replaceChildren(cell('path', 'Total for selected files'), cell('status', `${fmt(sum.files)} files`));
		metrics(footer, sum);
		const fragment = document.createDocumentFragment();
		draw(root, fragment, 0, narrowed);
		if (!files.length) fragment.append(cell('empty', 'No matching files.'));
		tree.replaceChildren(fragment);
	}
	let searchTimer;
	search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
	status.addEventListener('change', () => render());
	document.getElementById('reset').addEventListener('click', () => { search.value = ''; status.value = 'all'; render(); });
	document.getElementById('expand').addEventListener('click', () => {
		const root = fileTree(selectFiles(report.files, search.value, status.value));
		const expand = node => { for (const dir of node.dirs.values()) { open.add(dir.path); expand(dir); } };
		expand(root); render();
	});
	document.getElementById('collapse').addEventListener('click', () => { open.clear(); render(false); });
	render();
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderReport(report) {
	const json = JSON.stringify(packReport(report)).replace(/</g, '\\u003c');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(report.project ?? 'Repository')} — source provenance</title>
<!-- Generated by docs/provenance/build.mjs. Edit the generator, not this file. -->
<style>
:root { color-scheme: light dark; --bg: #f5f6f8; --panel: #fff; --ink: #18212f; --muted: #606d7e; --rule: #dde3eb; --added: #177147; --removed: #b44047; --new: #7251aa; }
@media (prefers-color-scheme: dark) { :root { --bg: #11151c; --panel: #191f29; --ink: #e5ebf3; --muted: #9aa8bb; --rule: #303a49; --added: #78cba0; --removed: #ed979c; --new: #bea5ee; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 system-ui, sans-serif; }
main { max-width: 1440px; margin: auto; padding: 42px 28px 64px; }
h1 { font-size: 32px; letter-spacing: -.03em; margin: 4px 0 8px; }
h2 { font-size: 19px; margin: 0; }
p { margin: 8px 0; }
.eyebrow, .meta, .note, .status, .previous { color: var(--muted); }
.eyebrow { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
code, .number, .value { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-variant-numeric: tabular-nums; }
code { overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 28px 0 14px; }
.card { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 20px; }
.card h2 { font-size: 14px; }
.value { font-size: clamp(20px, 2.7vw, 36px); font-weight: 600; margin: 10px 0; white-space: nowrap; }
.card p { font-size: 13px; color: var(--muted); margin: 0; }
.plus { color: var(--added); } .minus { color: var(--removed); } .new { color: var(--new); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 20px 0 14px; }
input, select, button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 8px 11px; }
input { min-width: 200px; flex: 1; } button, select { cursor: pointer; }
:focus-visible { outline: 2px solid var(--new); outline-offset: 2px; }
.table { overflow-x: auto; border: 1px solid var(--rule); border-radius: 8px; background: var(--panel); }
.row { display: grid; grid-template-columns: minmax(260px, 1fr) 150px 112px 180px 112px 112px; gap: 12px; min-width: 1040px; align-items: center; padding: 7px 14px; border-bottom: 1px solid var(--rule); font-size: 12px; }
.header, .total { font-weight: 600; background: var(--bg); }
.number { text-align: right; white-space: nowrap; }
.edits { display: flex; justify-content: flex-end; gap: 14px; }
.path { min-width: 0; overflow-wrap: anywhere; }
.filename { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.previous { display: block; font-size: 11px; }
summary { cursor: pointer; list-style: none; } summary::-webkit-details-marker { display: none; }
.arrow { display: inline-block; width: 16px; } .arrow::before { content: '▸'; } details[open] > summary .arrow::before { content: '▾'; }
.directory .filename { font-weight: 600; }
.row:hover { background: var(--bg); }
.note { font-size: 12px; } #scope { margin-top: 28px; font-weight: 500; }
.method { margin-top: 28px; border-top: 1px solid var(--rule); padding-top: 18px; }
.method li { margin: 5px 0; } .empty { display: block; padding: 20px; }
@media(max-width: 700px) { main { padding: 24px 16px; } .stats { grid-template-columns: 1fr; gap: 10px; } .card { padding: 14px 18px; } .value { font-size: 27px; } }
</style>
</head>
<body><main>
<header><div class="eyebrow">${escape(report.project ?? 'Repository')} / repository comparison</div><h1>Source provenance</h1>
<p>Repository source, tests, documentation, and tooling.</p>
<p class="meta">Baseline: <code>${escape(report.baseline.ref)}</code> · <code>${escape(report.baseline.commit)}</code></p></header>
<section class="stats" aria-label="Line counts for selected files">
<div class="card"><h2>Unchanged</h2><div class="value" id="unchanged"></div><p>Retained lines, including unchanged portions of edited files.</p></div>
<div class="card"><h2>Edited</h2><div class="value"><span class="plus">+<span id="added"></span></span> / <span class="minus">−<span id="removed"></span></span></div><p>Additions and removals in existing or renamed files. Deleted files contribute removals.</p></div>
<div class="card"><h2>New files</h2><div class="value new">+<span id="newLines"></span></div><p>Lines in added files without a detected baseline match.</p></div>
</section>
<p id="equations" class="note"></p>
<section aria-label="File tree"><p id="scope" aria-live="polite"></p>
<div class="toolbar"><input id="search" type="search" placeholder="Filter paths" aria-label="Filter paths">
<select id="status" aria-label="File status"><option value="all">All file statuses</option><option value="unchanged">Unchanged files</option><option value="modified">Modified files</option><option value="added">New files</option><option value="deleted">Deleted files</option><option value="renamed">Renamed files</option></select>
<button id="reset">Reset filters</button><button id="expand">Expand all</button><button id="collapse">Collapse all</button></div>
<div class="table"><div class="row header"><span>Path</span><span>File status</span><span class="number">Unchanged</span><span class="number">Edited + / −</span><span class="number">New files +</span><span class="number">Current lines</span></div>
<div id="tree"></div><div id="tree-total" class="row total"></div></div>
<p class="note">Counts above and directory totals use the same filtered files. Directory totals include descendants; expanding a folder does not add files to the total. Renames are listed once at their current path.</p></section>
<section class="method"><h2>Calculation</h2><ul>
<li>Compares the working tree, including nonignored untracked files, with the selected baseline. Local-folder mode includes that checkout’s nonignored working-tree changes. No boot-closure filter.</li>
<li>Git Myers line diff with ${report.renameThreshold}% rename similarity detection; exhaustive matching is limited to ${report.renameLimit ?? 200} candidates. Exact renames are still detected above the limit. Renames below this threshold appear as a deleted file and a new file. Added lines do not establish authorship.</li>
<li>Counts physical UTF-8 text lines, including comments and blanks. Normalizes CRLF to LF. A trailing newline does not add an extra line. Binary or non-UTF-8 comparisons have no line counts.</li>
<li>Excludes ignored untracked files, symlinks, directories named <code>${(report.excludedDirectories ?? []).map(escape).join('</code>, <code>')}</code>, <code>${report.exclusions.map(escape).join('</code>, <code>')}</code>, this generated report, and HTML reports containing an embedded generated JSON dataset. File permissions are not measured.</li>
</ul><p class="note">Generated entirely by <code>node docs/provenance/build.mjs</code>. Select a baseline with <code>--rev &lt;git-ref&gt;</code> or <code>--upstream &lt;checkout&gt;</code>.</p></section>
<noscript>This report requires JavaScript to display the generated file inventory.</noscript>
</main>
<script id="data" type="application/json">${json}</script>
<script>
const METRICS = ${JSON.stringify(METRICS)};
const STATUSES = ${JSON.stringify(STATUSES)};
${unpackReport.toString()}
${totals.toString()}
${selectFiles.toString()}
${fileTree.toString()}
(${browserMain.toString()})();
</script></body></html>
`;
}
