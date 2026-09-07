/*---------------------------------------------------------------------------------------------
 * The stock VS Code Explorer view, painted into terminal cells.
 *
 * ExplorerView owns the model, tree widget, rendering, focus, selection, expansion and commands.
 * This class supplies only terminal layout, DOM-to-cell painting and input-event transport.
 *--------------------------------------------------------------------------------------------*/

import '../../vs/workbench/contrib/files/browser/media/explorerviewlet.css';

import { FuzzyScore } from '../../vs/base/common/filters.js';
import { KeyCode } from '../../vs/base/common/keyCodes.js';
import { localize } from '../../vs/nls.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import type { WorkbenchCompressibleAsyncDataTree } from '../../vs/platform/list/browser/listService.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { VIEW_ID } from '../../vs/workbench/contrib/files/common/files.js';
import type { ExplorerItem } from '../../vs/workbench/contrib/files/common/explorerModel.js';
import { ExplorerView } from '../../vs/workbench/contrib/files/browser/views/explorerView.js';
import { ExplorerDelegate } from '../../vs/workbench/contrib/files/browser/views/explorerViewer.js';
import { TerminalElement } from '../terminal/dom/document.js';
import { createFileIconThemableTreeContainerScope } from '../terminal/dom/paint.js';
import { registerPaneCommand } from '../workbench/commands.js';
import { TreePane } from '../workbench/treePane.js';

export class ExplorerPane extends TreePane<ExplorerItem | ExplorerItem[], ExplorerItem> {
	readonly viewId = VIEW_ID;
	protected readonly view: ExplorerView;
	protected readonly tree: WorkbenchCompressibleAsyncDataTree<ExplorerItem | ExplorerItem[], ExplorerItem, FuzzyScore>;
	protected readonly container: TerminalElement;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService
	) {
		super(themeService);
		this.view = this._register(instantiationService.createInstance(ExplorerView, {
			id: VIEW_ID,
			title: localize('folders', "Folders"),
			expanded: true,
			delegate: { willOpenElement() { }, didOpenElement() { } }
		}));
		this.view.headerVisible = false;
		this.view.render();
		this.view.setVisible(true);
		this.tree = this.view.treeWidget;
		this._register(registerPaneCommand(VIEW_ID, {
			id: 'tscode.filterExplorer', title: 'Filter', primary: KeyCode.Slash,
			handler: () => { this.view.rootController.open(); this.trackRoot(); }
		}));
		this._register(registerPaneCommand(VIEW_ID, {
			id: 'workbench.files.action.collapseExplorerFolders',
			title: localize('collapseExplorerFolders', "Collapse Folders in Explorer"),
			primary: KeyCode.KeyC,
			handler: () => this.view.collapseAll()
		}));
		this.container = this.view.element as unknown as TerminalElement;
		this.bindTree(configurationService, ['pane-body', createFileIconThemableTreeContainerScope]);
	}

	protected get treeHeight(): number { return Math.max(1, this.rowCount) * ExplorerDelegate.ITEM_HEIGHT + this.view.rootController.height; }
	protected get rootController() { return this.view.rootController; }
	override async open(): Promise<void> {
		await this.view.setTreeInput();
		// The terminal initially highlights the first row. Establish that focus in the real
		// widget too, without replacing focus restored by the view or navigating an empty tree.
		if (this.rowCount && !this.tree.getFocus().length) { this.tree.focusFirst(); }
	}


}
