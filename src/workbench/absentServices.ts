import { ResourceSet } from '../vs/base/common/map.js';
import type { INotebookEditorModelResolverService } from '../vs/workbench/contrib/notebook/common/notebookEditorModelResolverService.js';
import type { INotebookService } from '../vs/workbench/contrib/notebook/common/notebookService.js';
import type { INotebookSearchService } from '../vs/workbench/contrib/search/common/notebookSearch.js';

/** A service that answers supported members and fails explicitly on unsupported operations. */
export function absent<T extends object>(name: string, answers: Partial<T>, reason = 'no editor pane exists yet (T09)'): T {
	return new Proxy({} as T, {
		get(_target, property) {
			if (property in answers) { return answers[property as keyof T]; }
			throw new Error(`${name}.${String(property)} is not available in tucode: ${reason}.`);
		},
		has(_target, property) { return property in answers; }
	});
}

/** Neither native frontend contributes notebooks; file replacement never resolves notebook cells. */
export const NO_NOTEBOOK_MODELS = absent<INotebookEditorModelResolverService>(
	'INotebookEditorModelResolverService', {}, 'this fork has no notebook to resolve a model for');
export const NO_NOTEBOOKS = absent<INotebookService>('INotebookService',
	{ getContributedNotebookTypes: () => [] }, 'this frontend has no notebook contributions');
export const NO_NOTEBOOK_SEARCH: INotebookSearchService = {
	_serviceBrand: undefined,
	notebookSearch: () => ({
		openFilesToScan: new ResourceSet(),
		completeData: Promise.resolve({ results: [], messages: [], limitHit: false }),
		allScannedFiles: Promise.resolve(new ResourceSet())
	})
};
