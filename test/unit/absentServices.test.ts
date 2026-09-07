import assert from 'node:assert/strict';
import { it } from 'node:test';
import { NO_NOTEBOOK_MODELS, NO_NOTEBOOK_SEARCH, NO_NOTEBOOKS } from '../../src/workbench/absentServices.js';

it('native frontends truthfully report no notebook search contributions and reject notebook resolution', async () => {
	const search = NO_NOTEBOOK_SEARCH.notebookSearch(undefined as never, undefined, 'no-notebooks-test');
	assert.equal(search.openFilesToScan.size, 0);
	assert.deepEqual(await search.completeData, { results: [], messages: [], limitHit: false });
	assert.equal((await search.allScannedFiles).size, 0);
	assert.deepEqual(NO_NOTEBOOKS.getContributedNotebookTypes(), []);
	assert.throws(() => NO_NOTEBOOK_MODELS.resolve, /no notebook to resolve/);
});
