/*---------------------------------------------------------------------------------------------
 * Shared command adaptations for frontends with one view-mode/sort key and focused-row actions.
 * The view remains responsible for applying mode, ordering and updates; the action arguments are
 * RepositoryPaneActionRunner's folder expansion. No frontend paint or input protocol belongs here.
 * Upstream counterpart: scmViewPane.ts (view actions and RepositoryPaneActionRunner).
 *--------------------------------------------------------------------------------------------*/

import { ResourceTree } from '../../../../base/common/resourceTree.js';
import { ViewMode } from '../common/scm.js';
import { ViewSortKey, type SCMViewPane, type TreeElement } from '../browser/scmViewPane.js';
import { isSCMResource, isSCMResourceGroup, isSCMResourceNode } from '../browser/util.js';

export function toggleSCMViewMode(view: Pick<SCMViewPane, 'viewMode'>): void {
	view.viewMode = view.viewMode === ViewMode.List ? ViewMode.Tree : ViewMode.List;
}

export function cycleSCMViewSortKey(view: Pick<SCMViewPane, 'viewSortKey'>): void {
	const keys = [ViewSortKey.Path, ViewSortKey.Name, ViewSortKey.Status];
	view.viewSortKey = keys[(keys.indexOf(view.viewSortKey) + 1) % keys.length];
}

export function scmResourceCommandArguments(elements: readonly TreeElement[]): unknown[] {
	return elements.filter(element => isSCMResource(element) || isSCMResourceGroup(element) || isSCMResourceNode(element))
		.flatMap(element => ResourceTree.isResourceNode(element) ? ResourceTree.collect(element) : [element]);
}
