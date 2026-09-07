/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { WorkbenchCompressibleAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { isSearchResult, ISearchResult, RenderableMatch } from './searchTreeModel/searchTreeCommon.js';

/** Search tree expansion, extracted from searchActionsTopBar to avoid registering actions on view import. */
export async function forcedExpandRecursively(
	viewer: WorkbenchCompressibleAsyncDataTree<ISearchResult, RenderableMatch, void>,
	element: RenderableMatch | undefined
) {
	if (element) {
		if (!viewer.hasNode(element)) {
			return;
		}
		await viewer.expand(element, true);
	}

	const children = viewer.getNode(element)?.children;

	if (children) {
		for (const child of children) {
			if (isSearchResult(child.element)) {
				throw Error('SearchResult should not be a child of a RenderableMatch');
			}
			forcedExpandRecursively(viewer, child.element);
		}
	}
}
