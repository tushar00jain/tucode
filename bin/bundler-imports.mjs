// The import specifiers in the vendored tree that only a bundler could resolve, resolved for
// Node. Four shapes, all of them Vite's, all of them left behind when T01 deleted
// `vite.config.ts`:
//
//   import './media/scm.css'                                     a stylesheet, if it is on disk
//   import onigWasmUrl from '…/onig.wasm?url'                    an asset's URL
//   import workerUrl from '…/editorWebWorkerMain.js?worker&url'   a worker script's URL
//   import('vscode-textmate')                                    a UMD package, by named export
//
// Each is answered with what Vite answered with, except the first: the asset's own URL for the
// next two — which in a Node process is a `file:` URL, and is what `worker_threads.Worker` takes
// in `base/node/nodeWebWorkerService.ts` — and, for the last, the CommonJS interop below.
//
// A stylesheet meant nothing until G0, because there was no tree for its class names to apply to.
// Now a widget's `import './x.css'` is what puts that sheet in front of `tui/terminal/dom/style.ts`, at the
// moment the widget loads and for no sheet the boot does not reach. A sheet that is not on disk —
// T01 deleted 286 of them and only what a loaded module asks for has come back — is inert, which
// is what it was before.
//
// Doing it here rather than by editing the imports out keeps 268 vendored files merging from
// tscode, and keeps the worker specifiers meaningful rather than deleted.
//
// Used as `node --import ./bin/bundler-imports.mjs <entry>`, because module hooks only apply
// to loads that come after them. A worker thread inherits `process.execArgv`, so it is hooked
// too — which it has to be, since a worker main reaches three of the four shapes.
//
// Upstream counterpart: vite.config.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// The exact-PID registry is lifecycle metadata only. Register before application imports execute,
// after exec has established Node's final argv, so the outer XCUI owner can validate this exact
// process without racing a process-table polling interval.
const ownedRegistry = process.env.TUCODE_OWNED_PID_REGISTRY;
const ownedToken = process.env.TUCODE_OWNED_PID_TOKEN;
if (ownedRegistry || ownedToken) {
	if (!ownedRegistry || !ownedToken) throw new Error('incomplete exact-owned PID registry configuration');
	const record = JSON.parse(readFileSync(ownedRegistry, 'utf8'));
	if (record.token !== ownedToken || !Array.isArray(record.pids)) throw new Error('exact-owned PID registry token mismatch');
	if (!record.pids.includes(process.pid)) {
		record.pids.push(process.pid);
		writeFileSync(ownedRegistry, `${JSON.stringify(record)}\n`);
	}
}

/** Where the compiled resolver lives, which is what a stylesheet module is loaded to reach. */
const STYLE_MODULE = new URL('../out/src/tui/terminal/dom/style.js', import.meta.url).href;

/** Vite's asset queries. The URL is the module's default export in both cases. */
const ASSET_QUERIES = new Set(['url', 'worker&url']);

/**
 * The packages in `amdX.ts`'s bundled table that ship as UMD, and the query this hook marks
 * one with so `load` can tell it apart.
 *
 * Node's `cjs-module-lexer` finds only the UMD global assignment in these, so
 * `import('vscode-textmate')` answers a namespace holding `default` and no `Registry`, where a
 * bundler's CommonJS interop re-exports the module's own properties by name. Every caller uses
 * what `importAMDNodeModule` returns as the module itself — `vscodeTextmate.Registry`,
 * `vscodeOniguruma.createOnigScanner`, `iconv.getDecoder` — so without the interop each of
 * those reads `undefined` off a module-shaped object.
 */
const CJS_NAMED_EXPORTS = new Set(['vscode-textmate', 'vscode-oniguruma', '@vscode/iconv-lite-umd']);
const CJS_QUERY = 'cjs-named';

const EMPTY_MODULE = { format: 'module', source: '', shortCircuit: true };

const isStylesheet = url => url.endsWith('.css');

const requireFromHere = createRequire(import.meta.url);

/** A legal ES binding name, which is what may be re-exported by name below. */
const isBindingName = name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default';

/**
 * The CommonJS module at `url`, re-exported as a bundler's interop does it: the whole
 * `module.exports` as the default, plus every own property that can be a named binding. The
 * names are read off the real module rather than listed here, so a package upgrade that adds an
 * export needs no change.
 */
function cjsNamedModule(url) {
	const path = fileURLToPath(url);
	const exported = requireFromHere(path);

	return [
		`import { createRequire } from 'node:module';`,
		`const exported = createRequire(${JSON.stringify(url)})(${JSON.stringify(path)});`,
		`export default exported;`,
		...Object.keys(exported).filter(isBindingName).map(name => `export const ${name} = exported[${JSON.stringify(name)}];`)
	].join('\n');
}

/** A stylesheet as the one call that registers it, or nothing when it is not on disk. */
function stylesheetModule(url) {
	let css;
	try {
		css = readFileSync(fileURLToPath(url), 'utf8');
	} catch {
		return EMPTY_MODULE;
	}

	return {
		format: 'module',
		source: `import { addStylesheet } from ${JSON.stringify(STYLE_MODULE)};\naddStylesheet(${JSON.stringify(css)});`,
		shortCircuit: true
	};
}

/** `['./x.js', 'worker&url']` for `'./x.js?worker&url'`; an empty query when there is none. */
function splitQuery(specifier) {
	const start = specifier.indexOf('?');

	return start === -1 ? [specifier, ''] : [specifier.slice(0, start), specifier.slice(start + 1)];
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (isStylesheet(specifier)) {
			// Resolved by hand rather than by `nextResolve`, which would fail on a stylesheet
			// that is no longer on disk. The URL is never opened — `load` shortcuts it.
			return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
		}

		if (CJS_NAMED_EXPORTS.has(specifier)) {
			const resolved = nextResolve(specifier, context);

			return { ...resolved, url: `${resolved.url}?${CJS_QUERY}`, format: 'module', shortCircuit: true };
		}

		const [asset, query] = splitQuery(specifier);
		if (!ASSET_QUERIES.has(query)) {
			return nextResolve(specifier, context);
		}

		// The asset is resolved normally — a relative path against the importer, a bare
		// specifier through `node_modules` — and the query is carried onto the resolved URL so
		// `load` can tell it apart from an ordinary module.
		const resolved = nextResolve(asset, context);

		return { ...resolved, url: `${resolved.url}?${query}`, format: 'module', shortCircuit: true };
	},

	load(url, context, nextLoad) {
		if (isStylesheet(url)) {
			return stylesheetModule(url);
		}

		const [asset, query] = splitQuery(url);
		if (query === CJS_QUERY) {
			return { format: 'module', source: cjsNamedModule(asset), shortCircuit: true };
		}
		if (!ASSET_QUERIES.has(query)) {
			return nextLoad(url, context);
		}

		return { format: 'module', source: `export default ${JSON.stringify(asset)};`, shortCircuit: true };
	}
});
