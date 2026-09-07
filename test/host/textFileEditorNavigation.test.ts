import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { FileOperationError, FileOperationResult } from '../../src/vs/platform/files/common/files.js';
import { TextFileEditor } from '../../src/vs/workbench/contrib/files/browser/editors/textFileEditor.js';
import { isEditorOpenError } from '../../src/vs/workbench/common/editor.js';
import { ViewContainerLocation } from '../../src/vs/workbench/common/views.js';
import { IPaneCompositePartService } from '../../src/vs/workbench/services/panecomposite/browser/panecomposite.js';

test('upstream file editor resolves shell navigation only when Reveal Folder is invoked', async () => {
	const resource = URI.file('/workspace/folder');
	const calls: unknown[][] = [];
	const pane = {
		contextService: { isInsideWorkspace: () => true },
		explorerService: { select: async (...args: unknown[]) => { calls.push(['select', ...args]); } },
		instantiationService: { invokeFunction: (fn: (accessor: unknown) => unknown) => fn({
			get: (id: unknown) => {
				assert.equal(id, IPaneCompositePartService);
				calls.push(['resolve']);
				return { openPaneComposite: async (...args: unknown[]) => { calls.push(['open', ...args]); } };
			}
		}) }
	};
	const handleError = (TextFileEditor.prototype as unknown as {
		handleSetInputError(error: Error, input: unknown, options: unknown): Promise<void>;
	}).handleSetInputError;
	let reported: unknown;
	try {
		await handleError.call(pane, new FileOperationError('directory', FileOperationResult.FILE_IS_DIRECTORY),
			{ resource, preferredResource: resource }, undefined);
	} catch (error) { reported = error; }
	assert.ok(isEditorOpenError(reported));
	assert.deepEqual(calls, [], 'creating error actions must not construct the shell');
	const reveal = reported.actions.find(action => action.id === 'workbench.files.action.reveal');
	assert.ok(reveal);
	await reveal.run();
	assert.deepEqual(calls, [
		['resolve'], ['open', 'workbench.view.explorer', ViewContainerLocation.Sidebar, true],
		['select', resource, true]
	]);
});
