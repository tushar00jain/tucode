/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHooks } from 'node:module';
import ts from 'typescript';

/**
 * Resolve the `.js` specifiers the source tree is written with — TypeScript's `bundler`
 * resolution and Vite both read them as the `.ts` file beside them, and Node does not. That is
 * the source-module resolution gap between TypeScript's bundler mode and Node.
 *
 * `.d.ts` is the same gap one step further along: a handful of vendored files import a
 * declaration file by its `.js` name — `observableInternal/logging/debugger/debuggerApi.js` is
 * the one the host tests reach — and type stripping leaves an empty module, which is exactly
 * what a declaration file is worth at runtime. Stylesheet side-effect imports likewise become
 * empty modules because unit tests have no renderer; stylesheet behavior has its own resolver tests.
 */
const EXTENSIONS = ['.ts', '.d.ts'];

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (specifier.startsWith('.') && specifier.endsWith('.js')) {
				const base = specifier.slice(0, -'.js'.length);
				for (const extension of EXTENSIONS) {
					try {
						return nextResolve(`${base}${extension}`, context);
					} catch { /* the next extension, or the original error */ }
				}
			}

			throw error;
		}
	},

	load(url, context, nextLoad) {
		if (url.endsWith('.css')) {
			return { format: 'module', source: '', shortCircuit: true };
		}

		if (url.endsWith('.d.ts')) {
			return { format: 'module', source: '', shortCircuit: true };
		}

		const loaded = nextLoad(url, context);
		if (!url.endsWith('.ts')) {
			return loaded;
		}

		// Node 22--25 exposed transform-types behind a flag, while Node 26 removed
		// that flag and retained only strip-only support.  Use the project's own
		// TypeScript dependency so enums, parameter properties and decorators have
		// identical semantics on every supported Node release.
		const source = typeof loaded.source === 'string'
			? loaded.source
			: Buffer.from(loaded.source).toString('utf8');
		const transformed = ts.transpileModule(source, {
			fileName: new URL(url).pathname,
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				experimentalDecorators: true,
				verbatimModuleSyntax: false
			}
		});

		return { ...loaded, format: 'module', source: transformed.outputText };
	}
});
