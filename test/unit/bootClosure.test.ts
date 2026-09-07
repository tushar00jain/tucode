/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * The service registry is last-one-wins: `registerSingleton` pushes onto an array
 * (`platform/instantiation/common/extensions.ts`) and `Workbench.initServices` copies that array
 * into the collection in order, so a second descriptor for an identifier replaces the first. The
 * winner is therefore decided by the order the boot file's imports run — which nothing in the
 * build states and nothing checked, and any import reordering can change.
 *
 * That is a silent failure: the loser is a fully working service, so the window still draws and
 * every other suite still passes. This walks the boot file's runtime import closure and asserts
 * the outcome cannot depend on that order.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bootFile = resolve(root, 'src/main.ts');

/**
 * A static `import`/`export … from` that survives to runtime. `import type` is erased and so is
 * not part of the closure; an unmarked type import is *not* erased under Node's type stripping,
 * which is why the unmarked ones stay in. `import(…)` never matches — the `\s+` needs whitespace —
 * and that is right, because a module loaded after boot cannot win a registration anyway.
 */
const importExpression = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

/** `registerSingleton(IIdentifier, Ctor, …)`, whose two names are what the ordering question is about. */
const registration = /registerSingleton\(\s*([A-Za-z0-9_$]+)\s*,\s*([A-Za-z0-9_$]+)/g;

function bootClosure(): string[] {
	const seen = new Set<string>();
	const pending = [bootFile];

	while (pending.length) {
		const file = pending.pop()!;
		if (seen.has(file)) {
			continue;
		}
		seen.add(file);

		for (const [, specifier] of readFileSync(file, 'utf8').matchAll(importExpression)) {
			if (!specifier.startsWith('.')) {
				continue; // a package: it registers nothing into this registry
			}

			// The tree imports its own files by their emitted `.js` name.
			const target = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
			if (existsSync(target)) {
				pending.push(target);
			}
		}
	}

	return [...seen].map(file => relative(root, file).replace(/\\/g, '/')).sort();
}

const closure = bootClosure();

describe('boot closure', () => {

	it('walks the boot file to a closure of the size it has', () => {
		// A guard on the walk itself rather than on the tree: an expression that stopped matching
		// would otherwise turn every assertion below into a vacuous pass over an empty set.
		assert.ok(closure.length > 2000, `closure is ${closure.length} files`);
		assert.ok(closure.includes('src/vs/workbench/services/keybinding/tauri/keybindingService.ts'));
	});

	/**
	 * The invariant, stated so it needs no exception list: an identifier may be registered as often
	 * as it likes provided every registration names the **same** constructor, because then the order
	 * the descriptors land in decides nothing. Two *different* constructors is a race the build wins
	 * by accident.
	 *
	 * One duplicate is expected and passes on exactly that ground — upstream registers
	 * `ITerminalInstanceService` in both `terminal.contribution.ts` and `terminalInstanceService.ts`,
	 * naming the one class the latter exports.
	 */
	it('registers no service identifier with two different implementations', () => {
		const byIdentifier = new Map<string, Map<string, string[]>>();

		for (const file of closure) {
			const text = readFileSync(resolve(root, file), 'utf8');
			for (const [, identifier, ctor] of text.matchAll(registration)) {
				const implementations = byIdentifier.get(identifier) ?? new Map<string, string[]>();
				byIdentifier.set(identifier, implementations);
				implementations.set(ctor, [...(implementations.get(ctor) ?? []), file]);
			}
		}

		const contested = [...byIdentifier]
			.filter(([, implementations]) => implementations.size > 1)
			.map(([identifier, implementations]) => `${identifier}: ${[...implementations].map(([ctor, files]) => `${ctor} (${files.join(', ')})`).join(' vs ')}`);

		assert.deepEqual(contested, []);
	});

	/**
	 * The same failure at its worst: `editor/standalone/browser/standaloneServices.ts` makes 37 eager
	 * registrations of its own — `IKeybindingService` among them — so one import reaching it replaces
	 * the services the boot file set and the window never draws. It is out of the closure today only
	 * because every editor import names a deeper path than `editor.api.js`.
	 */
	it('does not reach the standalone editor services', () => {
		assert.deepEqual(closure.filter(file => file.includes('editor/standalone')), []);
	});
});
