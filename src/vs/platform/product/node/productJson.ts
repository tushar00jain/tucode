/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: vite.config.ts
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutRoot } from '../../../base/node/checkout.js';

/**
 * `product.json` and `package.json`, on the two globals `platform/product/common/product.ts`
 * reads them from. Vite's `define` was what put them there; a Node process has no build step
 * to do it, so boot imports this for its side effect before anything reaches
 * `IProductService`.
 */

const root = checkoutRoot();
if (!root) {
	throw new Error('cannot locate product.json — the checkout root is not an ancestor of this module');
}

globalThis._VSCODE_PRODUCT_JSON = read('product.json');
globalThis._VSCODE_PACKAGE_JSON = read('package.json');

function read(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root!, name), 'utf8'));
}
