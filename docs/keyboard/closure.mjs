// Resolve source imports and walk each frontend entry point once.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)(?!\s+type\s)[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/**
 * The repo-relative module a specifier names, or null for a bare package or a missing file.
 * Exported because the registration scanner has to follow the same edges to resolve an id that
 * lives in another file, and two resolvers would disagree at exactly the interesting places.
 */
export function resolveSpec(tree, spec, fromRel) {
	if (!spec.startsWith('.') && !spec.startsWith('vs/')) return null;
	const base = spec.startsWith('.')
		? [...fromRel.split('/').slice(0, -1), ...spec.split('/')]
		: ['src', ...spec.split('/')];

	const parts = [];
	for (const part of base) {
		if (part === '.' || part === '') continue;
		if (part === '..') parts.pop(); else parts.push(part);
	}
	const path = parts.join('/');

	// A vendored file imports its sibling as `./foo.js`, which is the emitted name of `foo.ts`.
	for (const candidate of [path.replace(/\.js$/, '.ts'), `${path}.ts`, `${path}/index.ts`, path]) {
		if (tree.has(candidate)) return candidate;
	}
	return null;
}

/**
 * Walks from `roots` and answers every module reached, with the modules that reached it — which
 * is where a cut, a shim or a type-only import would have to go.
 *
 * @returns Map<rel, { lines, imports: string[], importers: Set<string> }>
 */
export function closure(tree, roots) {
	const seen = new Map();
	const missing = [];

	function walk(rel) {
		if (seen.has(rel)) return;
		const body = tree.read(rel);
		if (body === null) { missing.push(rel); return; }

		const imports = [];
		for (const match of body.matchAll(IMPORT_RE)) {
			const spec = match[1] ?? match[2];
			if (!spec || spec.endsWith('.css')) continue;
			const target = resolveSpec(tree, spec, rel);
			if (target) imports.push(target);
		}

		seen.set(rel, { lines: body.split('\n').length, imports, importers: new Set() });
		for (const target of imports) walk(target);
		for (const target of imports) seen.get(target)?.importers.add(rel);
	}

	for (const root of roots) {
		if (tree.has(root)) walk(root); else missing.push(root);
	}
	return Object.assign(seen, { missing });
}

