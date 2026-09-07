import '../../src/vs/base/node/browserGlobals.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Event } from '../../src/vs/base/common/event.js';
import { IConfigurationService } from '../../src/vs/platform/configuration/common/configuration.js';
import { MenuId, MenuRegistry } from '../../src/vs/platform/actions/common/actions.js';
import { MenuService } from '../../src/vs/platform/actions/common/menuService.js';
import { ContextKeyService } from '../../src/vs/platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../src/vs/platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../src/vs/platform/commands/common/commands.js';
import { IKeybindingService } from '../../src/vs/platform/keybinding/common/keybinding.js';
import { InMemoryStorageService } from '../../src/vs/platform/storage/common/storage.js';

test('zero-delay menu ownership delivers registry and context changes without a timer turn', async () => {
	const configuration = { onDidChangeConfiguration: Event.None, getValue: () => undefined };
	const contexts = new ContextKeyService(configuration as IConfigurationService);
	const storage = new InMemoryStorageService();
	const commands = { executeCommand: async () => undefined } as unknown as ICommandService;
	const keybindings = { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService;
	const service = new MenuService(commands, keybindings, storage);
	const menuId = MenuId.for('test.menuService.zeroDelay');
	const enabled = new RawContextKey<boolean>('test.menuService.zeroDelay.enabled', false);
	const context = enabled.bindTo(contexts);
	const first = MenuRegistry.appendMenuItem(menuId, {
		command: { id: 'test.menuService.zeroDelay.first', title: 'First', precondition: enabled }
	});
	const menu = service.createMenu(menuId, contexts, { emitEventsForSubmenuChanges: true, eventDebounceDelay: 0 });
	const events = [];
	const listener = menu.onDidChange(event => events.push(event));
	try {
		context.set(true);
		assert.equal(events.length, 1, 'zero-delay context change escaped into a timer turn');

		events.length = 0;
		const registryChanged = Event.toPromise(Event.onceIf(menu.onDidChange, () => true));
		const second = MenuRegistry.appendMenuItem(menuId, {
			command: { id: 'test.menuService.zeroDelay.second', title: 'Second' }
		});
		try {
			assert.equal(events.length, 0, 'registry ownership bypassed its canonical microtask aggregation');
			await registryChanged;
			assert.equal(events.length, 1, 'zero-delay registry change added a timer/debounce turn after its causal registry event');
			assert.equal(menu.getActions().flatMap(([, actions]) => actions).some(action => action.id === 'test.menuService.zeroDelay.second'), true);
		} finally {
			second.dispose();
		}
	} finally {
		listener.dispose(); menu.dispose(); first.dispose(); context.reset();
		contexts.dispose(); service.dispose(); storage.dispose();
	}
});
