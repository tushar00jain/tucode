/*---------------------------------------------------------------------------------------------
 * Browser box transport for the shared Search result-filter controller.
 * Upstream counterpart: none. VS Code has no `/` filter over search results.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { registerViewRootCommand, ViewRootBox } from '../../../browser/tauri/viewRootBox.js';
import { VIEW_ID } from '../../../services/search/common/search.js';
import { ISearchRootTree, SearchRootController } from './searchRootController.js';

registerViewRootCommand('tscode.search.filter', VIEW_ID, localize('tscode.search.filter', "Filter"));

export class SearchViewRoot extends SearchRootController<ViewRootBox> {
	constructor(tree: () => ISearchRootTree, resultsElement: HTMLElement, reLayout: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService) {
		super(tree, labelService, root => instantiationService.createInstance(ViewRootBox, VIEW_ID, root,
			localize('tscode.searchFilterPlaceholder', "filter results")), reLayout);
		this.input.mount(resultsElement);
	}
}
