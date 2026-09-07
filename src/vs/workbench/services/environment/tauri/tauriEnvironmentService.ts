/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchConstructionOptions } from '../../../browser/web.api.js';
import { BrowserWorkbenchEnvironmentService } from '../browser/environmentService.js';

/**
 * The browser environment service, with user data on disk rather than in the
 * renderer's IndexedDB.
 *
 * Upstream's browser build answers `/User` for `userRoamingDataHome` — a path in
 * no filesystem, which is right for a workbench in a tab and wrong for a window
 * that runs on the machine. Its desktop build answers a real directory instead,
 * and that is the shape this overrides to: everything derived from the home —
 * `settings.json`, `keybindings.json`, `argv.json`, the caches, `State`,
 * `History` and `Workspaces` — follows it onto the disk, as it does on stock
 * desktop.
 *
 * The directory itself comes from the backend, which is the only thing that can
 * create it. See `channels/file.rs`'s `userDataDir`.
 */
export class TauriWorkbenchEnvironmentService extends BrowserWorkbenchEnvironmentService {

	constructor(
		private readonly userDataHome: URI,
		workspaceId: string,
		logsHome: URI,
		options: IWorkbenchConstructionOptions,
		productService: IProductService
	) {
		super(workspaceId, logsHome, options, productService);
	}

	override get userRoamingDataHome(): URI { return this.userDataHome; }
}
