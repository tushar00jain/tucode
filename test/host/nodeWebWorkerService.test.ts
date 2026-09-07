import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { isCancellationError } from '../../src/vs/base/common/errors.js';
import { NodeWebWorkerService } from '../../src/vs/base/node/nodeWebWorkerService.js';
import { WebWorkerDescriptor } from '../../src/vs/platform/webWorker/browser/webWorkerDescriptor.js';

test('a delayed worker request is cancelled before resolving or creating a thread after disposal', async () => {
	const service = new NodeWebWorkerService();
	const grammarLoaded = new DeferredPromise<void>();
	let resolutions = 0;
	const descriptor = new WebWorkerDescriptor({ label: 'late-tokenization', esmModuleLocationBundler: () => {
		resolutions++; throw new Error('a disposed service must not reach worker creation');
	} });
	const request = grammarLoaded.p.then(() => service.createWorkerClient(descriptor));
	service.dispose();
	void grammarLoaded.complete();
	await assert.rejects(request, isCancellationError);
	assert.equal(resolutions, 0, 'cancellation happens before URL resolution and thread construction');
});
