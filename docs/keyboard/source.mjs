// Read source modules directly from a checkout or Git blobs; no build or temporary copies.
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { resolveSpec } from './closure.mjs';

let sequence = 0;
export function cachedTree(tree) {
	const reads = new Map(), existence = new Map();
	return { ...tree,
		read(path) { if (!reads.has(path)) reads.set(path, tree.read(path)); return reads.get(path); },
		has(path) { if (!existence.has(path)) existence.set(path, tree.has(path)); return existence.get(path); }
	};
}

// Only import data modules (keymap, key codes), never the application entry point.
export async function sourceModules(tree, paths) {
	const prefix = `keyboard-source://${++sequence}/`;
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith(prefix)) return { url: specifier, shortCircuit: true };
			if (!context.parentURL?.startsWith(prefix)) return next(specifier, context);
			const path = resolveSpec(tree, specifier, context.parentURL.slice(prefix.length));
			if (!path) throw new Error(`Cannot read source dependency ${specifier}`);
			return { url: prefix + path, shortCircuit: true };
		},
		load(url, context, next) {
			if (!url.startsWith(prefix)) return next(url, context);
			const path = url.slice(prefix.length), source = tree.read(path);
			if (source === null) throw new Error(`Cannot read ${path}`);
			return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
				fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
					experimentalDecorators: true, verbatimModuleSyntax: false }
			}).outputText };
		}
	});
	try { return await Promise.all(paths.map(path => import(prefix + path))); }
	finally { hooks.deregister(); }
}
