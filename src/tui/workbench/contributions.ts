/*---------------------------------------------------------------------------------------------
 *  What panels this frontend has, declared where tscode declares its own.
 *
 *  An entry in the activity bar is a **view container**, and the panes stacked inside the side bar
 *  below it are its **views** — which is exactly the shape upstream already has:
 *  `workbench.view.scm` holds Changes above Graph, `workbench.view.sapling` holds the Smartlog above
 *  Commit Info. So the panel inventory is `IViewContainersRegistry` and `IViewsRegistry`, at the ids
 *  upstream registers, rather than a table of our own beside them.
 *
 *  Five fields are read by `workbench.ts` and are therefore load-bearing:
 *
 *  - **`ViewContainerLocation`** decides which part a container is in. All four are `Sidebar`, which
 *    is why this frontend has no panel and no auxiliary bar to draw.
 *  - **`order`**, on the container, is the order of the activity bar; on a view, the order it is
 *    stacked in inside the side bar.
 *  - **`weight`** splits the side bar's rows between a container's views, which is what upstream
 *    sizes a stacked view with. Commit Info is 30 against the smartlog's 70 because that is what
 *    `sapling.contribution.ts` says; Changes and Graph are 40 and 40, from `scm.contribution.ts`.
 *  - **`when`** decides whether a view is shown at all. The Graph's clause is upstream's own —
 *    `scm.historyProviderCount != 0`, a key `SCMService` maintains — so a folder with no git
 *    repository has no Graph view here for the same reason it has none there.
 *  - **`name`** is what the view's header row says, so the words are upstream's rather than a
 *    second copy of them.
 *
 *  **Nothing is instantiated from a `ctorDescriptor` here**, and both kinds are casts: `IView` is the
 *  DOM view's interface — `focus`, `isBodyVisible`, `setExpanded`, `getProgressIndicator` — and a
 *  terminal pane answers none of it, while `IViewPaneContainer` is a `ViewPaneContainer`, whose module
 *  imports `workbench/browser/dnd.ts`, which holds the Node event loop open at module load. `main.ts` constructs the panes, as it constructs everything else this boot has no
 *  `ILifecycleService` to start; a descriptor is the declaration, and the class it names is the real
 *  implementation of that id.
 *
 *  Every call below is written out rather than looped, for the reason `scmPane.ts` gives for its keys:
 *  the tables on `docs/keyboard/build.mjs` are read off these call sites by a parser, and a
 *  descriptor built in a `map` callback resolves to nothing — measured, and it cost this file a
 *  rewrite.
 *
 *  Imported for its side effect, as every `*.contribution.ts` in `main.ts`'s list is. `workbench.ts`
 *  reads the registry rather than importing this file, which is what keeps the two out of a cycle.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/files/browser/explorerViewlet.ts, src/vs/workbench/contrib/search/browser/search.contribution.ts, src/vs/workbench/contrib/scm/browser/scm.contribution.ts, src/vs/workbench/contrib/sapling/tauri/sapling.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../vs/nls.js';
import { Codicon } from '../../vs/base/common/codicons.js';
import { ContextKeyExpr } from '../../vs/platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../vs/platform/instantiation/common/descriptors.js';
import { Registry } from '../../vs/platform/registry/common/platform.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../vs/workbench/common/views.js';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID, VIEW_ID as EXPLORER_VIEW_ID } from '../../vs/workbench/contrib/files/common/files.js';
import { HISTORY_VIEW_PANE_ID, VIEWLET_ID as SCM_VIEWLET_ID, VIEW_PANE_ID } from '../../vs/workbench/contrib/scm/common/scm.js';
import { VIEW_ID as SEARCH_VIEW_ID } from '../../vs/workbench/services/search/common/search.js';
import { ExplorerPane } from '../views/explorerPane.js';
import { SaplingCommitInfoPane } from '../views/saplingCommitInfoPane.js';
import { SaplingPane } from '../views/saplingPane.js';
import { SCMHistoryPane } from '../views/scmHistoryPane.js';
import { SCMPane } from '../views/scmPane.js';
import { SearchPane } from '../views/searchPane.js';
import { Workbench } from './workbench.js';

/**
 * `workbench.view.sapling`, as `sapling.contribution.ts` registers it. It is a literal for the same
 * reason `SaplingPane.ID` is: the file holding the constant is the DOM contribution, and importing it
 * would pull both view panes and their stylesheets into the closure.
 */
const SAPLING_VIEWLET_ID = 'workbench.view.sapling';

const containersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

/**
 * A `SyncDescriptor` for a class these registries will never construct — see the header.
 *
 * Its static arguments are not inert, though: upstream's own containers put the viewlet id and a
 * `ViewPaneContainer` options object there, and `workbench.ts` reads
 * `mergeViewWithContainerWhenSingleView` out of the second one — which is why each call below
 * carries the value upstream's own registration carries, and Sapling's is `false`.
 */
function declaring<T>(ctor: unknown, staticArguments: unknown[] = []): SyncDescriptor<T> {
	return new SyncDescriptor(ctor as never, staticArguments);
}

//#region --- Explorer

const explorerContainer = containersRegistry.registerViewContainer({
	id: EXPLORER_VIEWLET_ID,
	title: localize2('explore', "Explorer"),
	icon: Codicon.files,
	ctorDescriptor: declaring(Workbench, [EXPLORER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.explorer.views.state',
	alwaysUseContainerInfo: true,
	order: 0
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

viewsRegistry.registerViews([{
	id: EXPLORER_VIEW_ID,
	containerTitle: localize('explorer container', "Explorer"),
	name: localize2('folders', "Folders"),
	ctorDescriptor: declaring(ExplorerPane),
	canToggleVisibility: false,
	canMoveView: false,
	order: 0
}], explorerContainer);

//#endregion

//#region --- Search

const searchContainer = containersRegistry.registerViewContainer({
	id: SEARCH_VIEW_ID,
	title: localize2('search', "Search"),
	icon: Codicon.search,
	ctorDescriptor: declaring(Workbench, [SEARCH_VIEW_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.search.views.state',
	alwaysUseContainerInfo: true,
	order: 1
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

viewsRegistry.registerViews([{
	id: SEARCH_VIEW_ID,
	containerTitle: localize('search container', "Search"),
	name: localize2('search', "Search"),
	ctorDescriptor: declaring(SearchPane),
	canToggleVisibility: false,
	canMoveView: false,
	order: 0
}], searchContainer);

//#endregion

//#region --- Source Control: Changes, and the Graph under it

const scmContainer = containersRegistry.registerViewContainer({
	id: SCM_VIEWLET_ID,
	title: localize2('source control', "Source Control"),
	icon: Codicon.sourceControl,
	ctorDescriptor: declaring(Workbench, [SCM_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.scm.views.state',
	alwaysUseContainerInfo: true,
	order: 2
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

viewsRegistry.registerViews([{
	id: VIEW_PANE_ID,
	containerTitle: localize('source control view', "Source Control"),
	name: localize2('scmChanges', "Changes"),
	ctorDescriptor: declaring(SCMPane),
	canToggleVisibility: false,
	canMoveView: false,
	weight: 40,
	order: 0
}, {
	id: HISTORY_VIEW_PANE_ID,
	containerTitle: localize('source control view', "Source Control"),
	name: localize2('scmGraph', "Graph"),
	ctorDescriptor: declaring(SCMHistoryPane),
	canToggleVisibility: true,
	canMoveView: false,
	weight: 40,
	order: 1,
	when: ContextKeyExpr.and(
		ContextKeyExpr.has('scm.historyProviderCount'),
		ContextKeyExpr.notEquals('scm.historyProviderCount', 0))
}], scmContainer);

//#endregion

//#region --- Sapling: the smartlog, and the commit-info drawer under it

const saplingContainer = containersRegistry.registerViewContainer({
	id: SAPLING_VIEWLET_ID,
	title: localize2('sapling', "Sapling"),
	icon: Codicon.graph,
	ctorDescriptor: declaring(Workbench, [SAPLING_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: 'workbench.sapling.views.state',
	alwaysUseContainerInfo: true,
	order: 3
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

viewsRegistry.registerViews([{
	id: SaplingPane.ID,
	containerTitle: localize('sapling.container', "Sapling"),
	name: localize2('sapling.smartlog', "Smartlog"),
	ctorDescriptor: declaring(SaplingPane),
	canToggleVisibility: false,
	canMoveView: false,
	weight: 70,
	order: 0
}, {
	id: SaplingCommitInfoPane.ID,
	containerTitle: localize('sapling.container', "Sapling"),
	name: localize2('sapling.commitInfo', "Commit Info"),
	ctorDescriptor: declaring(SaplingCommitInfoPane),
	canToggleVisibility: true,
	canMoveView: false,
	weight: 30,
	order: 1
}], saplingContainer);

//#endregion
