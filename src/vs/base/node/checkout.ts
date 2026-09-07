/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: none — Vite handed the frontend every path this resolves, so nothing in tscode looks one up at runtime.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this checkout is, for the things a bundler used to hand the frontend and a Node
 * process has to find for itself: `product.json`, the resources read at runtime, and the
 * `tscode-host` binary.
 *
 * Walked up from this module rather than counted, because how deep a file sits depends on
 * whether it runs from `src/` or from the compiler's output directory. `product.json` is
 * the marker: it is at the root of the checkout and nowhere else.
 */

const MARKER = 'product.json';

let root: string | undefined;
let resolved = false;

export function checkoutRoot(): string | undefined {
	if (!resolved) {
		root = findCheckoutRoot();
		resolved = true;
	}

	return root;
}

function findCheckoutRoot(): string | undefined {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (; ;) {
		if (existsSync(join(directory, MARKER))) {
			return directory;
		}

		const parent = dirname(directory);
		if (parent === directory) {
			return undefined;
		}

		directory = parent;
	}
}
