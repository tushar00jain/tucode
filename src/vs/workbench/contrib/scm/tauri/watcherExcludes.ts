/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFilesConfiguration } from '../../../../platform/files/common/files.js';

/**
 * `files.watcherExclude` as the explorer's own `WorkspaceWatcher` reads it, for the source control
 * views that watch a working tree themselves.
 *
 * Watching a repository root recursively with no excludes is not a heavier version of watching it
 * with them — it is a different behaviour. The excluded paths are the ones written by something
 * other than a person: `node_modules`, build output, and the SCM tool's own bookkeeping. A view
 * that refreshes on file changes and spawns a process to do it then refreshes for as long as any
 * of those keep being written, which is indefinitely. `CoalescingRefresh` bounds that to one poll
 * per batch window; it cannot stop the batches from arriving.
 */
export function watcherExcludes(configurationService: IConfigurationService, resource: URI): string[] {
	const excludes: string[] = [];

	const config = configurationService.getValue<IFilesConfiguration>({ resource });
	if (config.files?.watcherExclude) {
		for (const key in config.files.watcherExclude) {
			if (key && config.files.watcherExclude[key] === true) {
				excludes.push(key);
			}
		}
	}

	return excludes;
}
