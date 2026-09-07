/*---------------------------------------------------------------------------------------------
 *  The worker service tscode registers.
 *
 *  Upstream's base service resolves a worker through `esmModuleLocation`, a path into its own
 *  build output. Vite emits each worker as its own chunk under a hashed name, which is what
 *  `esmModuleLocationBundler` carries — the same preference upstream's
 *  `StandaloneWebWorkerService` expresses for bundler targets.
 *--------------------------------------------------------------------------------------------*/

import { WebWorkerDescriptor } from '../browser/webWorkerDescriptor.js';
import { WebWorkerService } from '../browser/webWorkerServiceImpl.js';

export class BundlerWebWorkerService extends WebWorkerService {
	override getWorkerUrl(descriptor: WebWorkerDescriptor): string {
		if (!descriptor.esmModuleLocationBundler) {
			return super.getWorkerUrl(descriptor);
		}

		const url = typeof descriptor.esmModuleLocationBundler === 'function' ? descriptor.esmModuleLocationBundler() : descriptor.esmModuleLocationBundler;
		return url.toString();
	}
}
