/* The browser/terminal box and layout for the shared Explorer path controller. */
import { FuzzyScore } from '../../../../base/common/filters.js';
import { ITreeFilter, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { FILTER_PLACEHOLDER } from '../../../browser/tauri/viewRoot.js';
import { registerViewRootCommand, ViewRootBox } from '../../../browser/tauri/viewRootBox.js';
import { ExplorerItem } from '../common/explorerModel.js';
import { VIEW_ID } from '../common/files.js';
import { IExplorerService } from '../browser/files.js';
import { ExplorerRootController, IExplorerViewRootHost } from './explorerRootController.js';

registerViewRootCommand('tscode.filterExplorer', VIEW_ID, localize('tscode.filterExplorer', "Filter"));

export class ExplorerViewRoot extends ExplorerRootController<ViewRootBox> {
	constructor(view: IExplorerViewRootHost,
		tree: () => WorkbenchCompressibleAsyncDataTree<ExplorerItem | ExplorerItem[], ExplorerItem, FuzzyScore>,
		container: HTMLElement, compression: () => boolean,
		filter: ITreeFilter<ExplorerItem, FuzzyScore>, sorter: ITreeSorter<ExplorerItem>,
		@IInstantiationService instantiation: IInstantiationService,
		@IExplorerService explorer: IExplorerService) {
		super(view, tree, compression, filter, sorter, explorer,
			root => instantiation.createInstance(ViewRootBox, VIEW_ID, root, FILTER_PLACEHOLDER),
			height => {
				container.style.height = height ? `calc(100% - ${height}px)` : '';
				const body = container.parentElement;
				if (body) { tree().layout(body.clientHeight - height, body.clientWidth); }
			});
		this.box.mount(container);
	}
}
