// npm run keyboard -- [--rev origin/vendor | --upstream <checkout>]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { documentation } from '../config.mjs';
import { REPO, options } from '../provenance/args.mjs';
import { comparisonSource } from '../provenance/baseline.mjs';
import { workingTree } from '../provenance/tree.mjs';
import { collect, bindingsByAction, compareBindings } from './collect.mjs';
import { renderKeyboard, packRows } from './report.mjs';

const start = performance.now();
const { rev, upstream: local } = options('keyboard.json');
const { baseline, tree } = comparisonSource(REPO, rev, local);
const { project, pages } = documentation(REPO);
const inventories = new Map();
for (const page of pages) {
	console.log(`Reading ${page.name} shortcuts…`);
	inventories.set(page.file, await collect(workingTree(REPO), [page.root]));
}
// A pristine vendor tree has no fork entry point. Read upstream versions of the modules the
// app includes, rather than looking for a fork-only main.ts or keymap.ts in VS Code.
const roots = tree.has('src/main.ts') ? ['src/main.ts']
	: [...new Set([...inventories.values()].flatMap(inventory => inventory.files))].filter(file => tree.has(file));
if (!roots.length) throw new Error('No upstream source modules match this application');
console.log(`Reading upstream shortcuts (${baseline.ref})…`);
const source = await collect(tree, roots);
const upstreamBindings = new Map(['win', 'mac'].map(platform => [platform, bindingsByAction(source, platform)]));
const names = { win: 'Windows', mac: 'macOS', linux: 'Terminal' };
for (const page of pages) {
	const tables = page.comparisons.map(comparison => ({ title: `${page.name} compared with upstream ${names[comparison.upstream]}`,
		upstream: `Upstream ${names[comparison.upstream]} binding`,
		ours: `${page.name}${pages.length === 1 && comparison.ours !== 'linux' ? ' ' + names[comparison.ours] : ''} binding`,
		rows: packRows(compareBindings(bindingsByAction(inventories.get(page.file), comparison.ours), upstreamBindings.get(comparison.upstream))) }));
	const html = renderKeyboard({ project, frontend: page.name, baseline, navigation: pages.map(({ name, file }) => ({ name, file })), tables });
	writeFileSync(join(import.meta.dirname, page.file), html);
	console.log(`${page.file}: ${Math.round(Buffer.byteLength(html) / 1024)} KiB, ${tables.map(table => `${table.rows.length} actions`).join(' / ')}`);
}
console.log(`Keyboard reports generated in ${((performance.now() - start) / 1000).toFixed(2)}s.`);
