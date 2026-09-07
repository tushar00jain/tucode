import assert from 'node:assert/strict';
import test from 'node:test';
import '../../src/vs/workbench/browser/parts/editor/breadcrumbs.js';
import { NullLogService } from '../../src/vs/platform/log/common/log.js';
import { DefaultConfiguration } from '../../src/vs/workbench/services/configuration/browser/configuration.js';
import type { IConfigurationCache } from '../../src/vs/workbench/services/configuration/common/configuration.js';
import type { IBrowserWorkbenchEnvironmentService } from '../../src/vs/workbench/services/environment/browser/environmentService.js';

test('refreshing upstream defaults drops stale breadcrumb overrides and matches a fresh profile', async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const storage = new Map([[DefaultConfiguration.DEFAULT_OVERRIDES_CACHE_EXISTS_KEY, 'yes']]);
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key)
	} });
	let cached = JSON.stringify({ 'breadcrumbs.enabled': false });
	const cache: IConfigurationCache = {
		needsCaching: () => false,
		read: async () => cached,
		write: async (_key, value) => { cached = value; },
		remove: async () => { cached = ''; }
	};
	const environment = { options: {} } as IBrowserWorkbenchEnvironmentService;
	const previous = new DefaultConfiguration('test', cache, environment, new NullLogService());
	const fresh = new DefaultConfiguration('test', cache, environment, new NullLogService());
	try {
		assert.equal((await previous.initialize()).getValue('breadcrumbs.enabled'), false,
			'the regression must start with the stale override applied');
		assert.equal(previous.reload().getValue('breadcrumbs.enabled'), true);
		assert.equal(previous.hasCachedConfigurationDefaultsOverrides(), false);
		assert.equal((await fresh.initialize()).getValue('breadcrumbs.enabled'), true);
		assert.notEqual(cached && JSON.parse(cached)['breadcrumbs.enabled'], false);
	} finally {
		previous.dispose();
		fresh.dispose();
		if (descriptor) { Object.defineProperty(globalThis, 'localStorage', descriptor); }
		else { Reflect.deleteProperty(globalThis, 'localStorage'); }
	}
});
