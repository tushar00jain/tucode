import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Explorer resource clipboard stays process-local and snapshots URI transfers', async () => {
	const [{ RESOURCE_CLIPBOARD }, { URI }] = await Promise.all([
		import('../../out/src/tui/workbench/absentServices.js'),
		import('../../out/src/vs/base/common/uri.js')
	]);

	RESOURCE_CLIPBOARD.clearInternalState();
	assert.equal(await RESOURCE_CLIPBOARD.hasResources(), false);

	const source = URI.file('/owned-fixture/README.txt');
	const written = [source];
	await RESOURCE_CLIPBOARD.writeResources(written);
	written.length = 0;

	const first = await RESOURCE_CLIPBOARD.readResources();
	assert.deepEqual(first.map(resource => resource.toString()), [source.toString()]);
	first.length = 0;
	assert.equal(await RESOURCE_CLIPBOARD.hasResources(), true);
	assert.deepEqual((await RESOURCE_CLIPBOARD.readResources()).map(resource => resource.toString()), [source.toString()]);

	assert.throws(() => RESOURCE_CLIPBOARD.readText, /only process-local Explorer resource transfer is available/);
	RESOURCE_CLIPBOARD.clearInternalState();
	assert.equal(await RESOURCE_CLIPBOARD.hasResources(), false);
});
