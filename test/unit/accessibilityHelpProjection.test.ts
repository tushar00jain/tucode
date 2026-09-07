import '../../src/vs/base/node/browserGlobals.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../src/vs/platform/accessibility/browser/accessibleView.js';
import { ProjectedAccessibleViewService } from '../../src/accessibility/accessibilityHelp.js';

import { contextKeys } from './contextKeys.js';

test('accessibility help owns content, modal contexts, symbol Quick Input and generation-safe close', async () => {
	const contexts = contextKeys();
	const picked = new DeferredPromise<any>();
	const pickCalls: any[] = [];
	const quickInput = { pick: (items: any[], options: any) => { pickCalls.push({ items, options }); return picked.p; } };
	const keybindings = { lookupKeybinding: (id: string) => id === 'editor.action.accessibleViewGoToSymbol'
		? { getAriaLabel: () => 'Control+Shift+O' } : undefined };
	const service = new ProjectedAccessibleViewService(contexts.service as any, keybindings as any, quickInput as any,
		{ open: () => Promise.resolve(true) } as any);
	let closed = 0;
	const provider = new AccessibleContentProvider(AccessibleViewProviderId.Editor,
		{ type: AccessibleViewType.Help },
		() => 'Editor help\nMove between sections <keybinding:editor.action.accessibleViewGoToSymbol>',
		() => closed++, 'accessibility.verbosity.editor', undefined, undefined, undefined, undefined, undefined,
		() => [{ label: 'Editor help', lineNumber: 1 }]);

	service.show(provider);
	const shown = service.snapshot;
	assert.equal(shown.open, true);
	assert.match(shown.content, /Control\+Shift\+O/);
	assert.equal(contexts.values.get('accessibilityHelpIsShown'), true);
	assert.equal(contexts.values.get('accessibleViewGoToSymbolSupported'), true);
	assert.equal(service.close(shown.session - 1), false);

	service.goToSymbol();
	assert.equal(pickCalls.length, 1);
	assert.equal(pickCalls[0].options.title, 'Go to Symbol Accessible View');
	picked.complete({ label: 'Editor help', lineNumber: 1 });
	await picked.p;
	await Promise.resolve();
	assert.deepEqual(service.snapshot.position, { lineNumber: 1, column: 1 });
	assert.ok(service.snapshot.generation > shown.generation);

	assert.equal(service.close(shown.session), true);
	assert.equal(service.snapshot.open, false);
	assert.equal(contexts.values.get('accessibilityHelpIsShown'), false);
	assert.equal(closed, 1);
	service.dispose();
});
