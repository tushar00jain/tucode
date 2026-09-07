/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHooks } from 'node:module';

/**
 * Resolve the `.js` specifiers the source tree is written with — TypeScript's `bundler`
 * resolution and Vite both read them as the `.ts` file beside them, and Node does not. That is
 * the whole gap between `node --test --experimental-transform-types` and running these tests;
 * a test runner would close it with its own resolver, and this repo has not taken one on.
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (specifier.startsWith('.') && specifier.endsWith('.js')) {
				return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
			}

			throw error;
		}
	}
});
