/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { SaplingCommitInfoViewPane } from './saplingCommitInfoViewPane.js';
import { SaplingRepositoryCount, SaplingViewPane } from './saplingViewPane.js';

// The service the two views share a selected commit through, and where it registers itself.
import './saplingSelection.js';

const VIEWLET_ID = 'workbench.view.sapling';

/**
 * Sapling's own icon, from `addons/vscode/resources`. The activity bar and the pane header draw a
 * `URI` icon as a mask, so its fill follows the theme's foreground and the `-light`/`-dark`
 * variants beside it in the Sapling tree have nothing left to say.
 */
const saplingViewIcon = URI.parse(new URL('../../../../../../resources/sapling/Sapling.svg', import.meta.url).href);

const viewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEWLET_ID,
	title: localize2('sapling', "Sapling"),
	// The graph keeps its own header and twistie rather than merging into the container's, so
	// that it reads as a collapsible section — and so that the container does not change shape
	// when the commit-info view lands below it.
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEWLET_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: 'workbench.sapling.views.state',
	icon: saplingViewIcon,
	alwaysUseContainerInfo: true,
	order: 3
}, ViewContainerLocation.Sidebar);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViewWelcomeContent(SaplingViewPane.ID, {
	content: localize('sapling.noRepository', "No Sapling repository was found in the open folders."),
	when: 'default'
});

// The graph draws one repository and there is not always one to draw: nothing is active, nothing
// is picked. Upstream's history view says so the same way — a second welcome entry behind a
// context key, rather than a value invented so the question never arises.
viewsRegistry.registerViewWelcomeContent(SaplingViewPane.ID, {
	content: localize('sapling.noSelection', "No repository is selected.\nOpen a file in a Sapling repository, or choose one from the repository picker."),
	when: SaplingRepositoryCount.notEqualsTo(0)
});

viewsRegistry.registerViewWelcomeContent(SaplingCommitInfoViewPane.ID, {
	content: localize('sapling.noCommit', "Select a commit in the smartlog above."),
	when: 'default'
});

// Two views in one container, as ISL has the graph and its commit-info drawer. The graph takes
// the weight because the panel below it is a detail of what is selected in it — which is also
// upstream's proportion, where the drawer is a strip along the bottom of the window.
viewsRegistry.registerViews([{
	id: SaplingViewPane.ID,
	containerTitle: localize('sapling.container', "Sapling"),
	name: localize2('sapling.smartlog', "Smartlog"),
	singleViewPaneContainerTitle: localize('sapling.container', "Sapling"),
	ctorDescriptor: new SyncDescriptor(SaplingViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	weight: 70,
	order: 0,
	containerIcon: saplingViewIcon
}, {
	id: SaplingCommitInfoViewPane.ID,
	containerTitle: localize('sapling.container', "Sapling"),
	name: localize2('sapling.commitInfo', "Commit Info"),
	ctorDescriptor: new SyncDescriptor(SaplingCommitInfoViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 30,
	order: 1,
	containerIcon: saplingViewIcon
}], viewContainer);

const category = localize2('sapling.category', "Sapling");

registerAction2(class extends ViewAction<SaplingViewPane> {

	constructor() {
		super({
			id: 'sapling.pickRepository',
			title: localize2('sapling.command.pickRepository', "Repository Picker"),
			category,
			viewId: SaplingViewPane.ID,
			icon: Codicon.repo,
			f1: false,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SaplingViewPane.ID),
				group: 'navigation',
				order: 0
			}
		});
	}

	runInView(_accessor: ServicesAccessor, view: SaplingViewPane): Promise<void> {
		return view.pickRepository();
	}
});

registerAction2(class extends ViewAction<SaplingViewPane> {

	constructor() {
		super({
			id: 'sapling.refresh',
			title: localize2('sapling.command.refresh', "Refresh Smartlog"),
			category,
			viewId: SaplingViewPane.ID,
			icon: Codicon.refresh,
			f1: true,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SaplingViewPane.ID),
				group: 'navigation',
				order: 1
			}
		});
	}

	runInView(_accessor: ServicesAccessor, view: SaplingViewPane): Promise<void> {
		return view.refresh();
	}
});
