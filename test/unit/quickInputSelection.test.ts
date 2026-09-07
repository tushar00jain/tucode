import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import '../../src/vs/base/node/browserGlobals.js';
import { Event } from '../../src/vs/base/common/event.js';
import { CancellationTokenSource } from '../../src/vs/base/common/cancellation.js';
import { TerminalQuickInputService } from '../../src/tui/workbench/quickInput.js';
import { Overlays } from '../../src/tui/workbench/overlay.js';
import { QuickPick } from '../../src/vs/platform/quickinput/browser/quickInput.js';
import { IQuickInputService, IQuickPickItem, IInputBox } from '../../src/vs/platform/quickinput/common/quickInput.js';
import { ServiceCollection } from '../../src/vs/platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../src/vs/platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../src/vs/platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../src/vs/platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../src/vs/platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../src/vs/platform/layout/browser/layoutService.js';
import { PlatformEditorLayout } from '../../src/editor/platformEditorLayout.js';
import { IStorageService, InMemoryStorageService } from '../../src/vs/platform/storage/common/storage.js';
import { IContextMenuService, IContextViewService } from '../../src/vs/platform/contextview/browser/contextView.js';
import { IListService, ListService } from '../../src/vs/platform/list/browser/listService.js';
import { IKeybindingService } from '../../src/vs/platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../src/vs/platform/theme/common/themeService.js';
import { IAccessibilityService } from '../../src/vs/platform/accessibility/common/accessibility.js';
import { IHoverService } from '../../src/vs/platform/hover/browser/hover.js';

function fixture(t: TestContext) {
	const overlays = new Overlays();
	const configuration = { onDidChangeConfiguration: Event.None, getValue: () => undefined,
		inspect: () => ({}), updateValue: async () => {} } as unknown as IConfigurationService;
	const context = new ContextKeyService(configuration);
	const root = document.createElement('div');
	document.body.append(root);
	const theme = { getColorTheme: () => ({ getColor: () => undefined, type: 'dark' }),
		onDidColorThemeChange: Event.None } as unknown as IThemeService;
	const keybindings = { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService;
	const storage = new InMemoryStorageService();
	const lists = new ListService();
	const services = new ServiceCollection(
		[IConfigurationService, configuration], [IContextKeyService, context],
		[ILayoutService, new PlatformEditorLayout(root)], [IStorageService, storage],
		[IContextMenuService, {} as IContextMenuService], [IContextViewService, {} as IContextViewService], [IListService, lists],
		[IKeybindingService, keybindings], [IThemeService, theme], [IHoverService, {} as IHoverService],
		[IAccessibilityService, { isScreenReaderOptimized: () => false, onDidChangeScreenReaderOptimized: Event.None } as unknown as IAccessibilityService]
	);
	const instantiation = new InstantiationService(services, true);
	const service = instantiation.createInstance(TerminalQuickInputService, overlays);
	services.set(IQuickInputService, service);
	t.after(async () => {
		overlays.cancelAll();
		await setTimeout(5); // Upstream's zero-delay list relayout settles before disposal.
		service.dispose(); instantiation.dispose(); overlays.dispose(); lists.dispose(); context.dispose(); storage.dispose(); root.remove();
	});
	const paint = () => overlays.top!.render({ width: 60, height: 10 }).map(line => line.map(span => span.text).join(''));
	return { service, overlays, paint };
}

test('terminal uses the upstream picker and refreshes grouped Quick Access results', t => {
	const { service, paint } = fixture(t);
	const picker = service.createQuickPick<IQuickPickItem>({ useSeparators: true });
	t.after(() => picker.dispose());
	assert.ok(picker instanceof QuickPick);
	picker.matchOnLabel = picker.sortByLabel = false;
	picker.items = [{ type: 'separator', label: 'Results' }, { label: 'First' }, { label: 'Last' }];
	picker.show();
	paint();
	service.navigate(true);
	assert.equal(picker.activeItems[0]?.label, 'Last');
	picker.value = 'refined';
	const first = { label: 'Best match' }, last = { label: 'Other match' };
	picker.items = [{ type: 'separator', label: 'Results' }, first, last];
	assert.equal(picker.activeItems[0], first);
	assert.ok(paint().some(line => line.includes('Best match')));
	service.navigate(true);
	assert.equal(picker.activeItems[0], last);
});

test('terminal input and caret survive provider refreshes while editing in the middle', t => {
	const { service, overlays, paint } = fixture(t);
	const picker = service.createQuickPick();
	t.after(() => picker.dispose());
	picker.value = 'abcd'; picker.valueSelection = [2, 2];
	picker.items = [{ label: 'abXcd' }, { label: 'unrelated' }];
	picker.show();
	paint();
	overlays.handleKey({ name: 'char', char: 'X', sequence: 'X' });
	assert.equal(picker.value, 'abXcd');
	picker.busy = true;
	picker.items = [{ label: 'abXYcd' }];
	picker.busy = false;
	assert.ok(paint().some(line => line.includes('abX▏cd')));
	overlays.handleKey({ name: 'char', char: 'Y', sequence: 'Y' });
	assert.equal(picker.value, 'abXYcd');
	assert.ok(paint().some(line => line.includes('abXY▏cd')));
});

test('replacement hides the previous upstream picker exactly once', t => {
	const { service, overlays } = fixture(t);
	const first = service.createQuickPick(), second = service.createQuickPick();
	t.after(() => { first.dispose(); second.dispose(); });
	let hides = 0;
	first.onDidHide(() => hides++);
	first.show(); second.show();
	assert.equal(hides, 1);
	first.hide();
	assert.equal(service.currentQuickInput, second);
	assert.ok(overlays.top);
});

for (const kind of ['pick', 'input'] as const) {
	for (const action of ['cancel', 'hide', 'accept'] as const) {
		test(`${kind} resolves and releases its session on ${action}`, { timeout: 3000 }, async t => {
			const { service } = fixture(t);
			const token = new CancellationTokenSource();
			t.after(() => token.dispose());
			const item = { label: 'Chosen' };
			const pending = kind === 'pick' ? service.pick([item], {}, token.token)
				: service.input({ value: 'Typed' }, token.token);
			await setTimeout(5);
			if (action === 'cancel') { token.cancel(); }
			else if (action === 'hide') { service.currentQuickInput!.hide(); }
			else { await service.accept(); }
			assert.equal(await pending, action === 'accept' ? (kind === 'pick' ? item : 'Typed') : undefined);
			assert.equal(service.currentQuickInput, undefined);
		});
	}
}

test('upstream multi-pick acceptance preserves the checked items', async t => {
	const { service, overlays, paint } = fixture(t);
	const first = { label: 'First' }, second = { label: 'Second' };
	const pending = service.pick([first, second], { canPickMany: true, hideInput: true });
	await setTimeout(5);
	paint();
	overlays.handleKey({ name: 'space', sequence: ' ' });
	service.navigate(true);
	await service.accept();
	assert.deepEqual(await pending, [first]);
});


test('shared upstream input validation blocks string errors and accepts a corrected value', async t => {
	const { service } = fixture(t);
	const pending = service.input({ value: 'invalid', validateInput: async value => value === 'invalid' ? 'Choose another value' : undefined });
	const input = service.currentQuickInput as IInputBox;
	await service.accept();
	await setTimeout(1);
	assert.equal(service.currentQuickInput, input);
	assert.equal(input.validationMessage, 'Choose another value');
	input.value = 'valid';
	await service.accept();
	assert.equal(await pending, 'valid');
});


test('terminal window removes upstream capture listeners on disposal', () => {
	let calls = 0;
	const listener = () => calls++;
	window.addEventListener('quick-input-capture-test', listener, true);
	window.removeEventListener('quick-input-capture-test', listener, true);
	window.dispatchEvent(new globalThis.Event('quick-input-capture-test'));
	assert.equal(calls, 0);
});
