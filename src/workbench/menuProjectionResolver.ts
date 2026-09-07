/*---------------------------------------------------------------------------------------------
 * Shared menu/action/keybinding resolution behind the immutable projection source.
 *--------------------------------------------------------------------------------------------*/
import { IAction, Separator } from '../vs/base/common/actions.js';
import { Event } from '../vs/base/common/event.js';
import { ResolvedKeybinding } from '../vs/base/common/keybindings.js';
import { mnemonicMenuLabel } from '../vs/base/common/labels.js';
import { Disposable, DisposableStore } from '../vs/base/common/lifecycle.js';
import { getFlatContextMenuActions } from '../vs/platform/actions/browser/menuEntryActionViewItem.js';
import { IMenu, IMenuActionOptions, IMenuService, MenuId, SubmenuItemAction } from '../vs/platform/actions/common/actions.js';
import { ICommandService } from '../vs/platform/commands/common/commands.js';
import { IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../vs/platform/keybinding/common/keybinding.js';
import {
	IContextMenuProjectionSource, IMenuProjectionInput, IMenuProjectionKey, IMenuProjectionScheduler,
	IMenuProjectionSource, MenuProjectionController, MenuProjectionEvent, MenuProjectionSnapshot,
	menuProjectionInputsOf
} from './menuProjection.js';

export interface IMenuProjectionResolveOptions {
	readonly runner?: { run(action: IAction, context?: unknown): unknown };
	readonly context?: unknown;
	readonly key?: (action: IAction) => IMenuProjectionKey | undefined;
}

export class MenuProjectionResolver {
	constructor(private readonly keybindingService: IKeybindingService, private readonly commandService: ICommandService,
		private readonly keyRecord: (binding: ResolvedKeybinding | undefined) => IMenuProjectionKey | undefined) { }
	menu(menu: IMenu, exclude?: ReadonlySet<string>, options: IMenuActionOptions = { shouldForwardArgs: true }): readonly IMenuProjectionInput[] {
		const actions = getFlatContextMenuActions(menu.getActions(options));
		return this.actions(exclude ? Separator.clean(actions.filter(action => !exclude.has(action.id))) : actions);
	}
	actions(actions: readonly IAction[], options: IMenuProjectionResolveOptions = {}): readonly IMenuProjectionInput[] {
		return menuProjectionInputsOf(actions, {
			key: action => options.key ? options.key(action) : this.keyRecord(this.keybindingService.lookupKeybinding(action.id)),
			run: action => options.runner ? Promise.resolve(options.runner.run(action, options.context)).then(() => undefined)
				: this.commandService.executeCommand(action.id).then(() => undefined)
		});
	}
	keyFor(commandId: string): IMenuProjectionKey | undefined { return this.keyRecord(this.keybindingService.lookupKeybinding(commandId)); }
	controller(id: string, source: () => readonly IMenuProjectionInput[], scheduler?: IMenuProjectionScheduler): IContextMenuProjectionSource {
		return new MenuProjectionController(id, source, scheduler);
	}
}

export interface IMainMenuProjectionStandard {
	readonly application: (appName: string, preferences: readonly IMenuProjectionInput[]) => IMenuProjectionInput;
	readonly edit: () => readonly IMenuProjectionInput[];
	readonly separator: IMenuProjectionInput;
	readonly excludedEdit: ReadonlySet<string>;
	readonly window: () => IMenuProjectionInput;
}

export class MainMenuProjectionSource extends Disposable implements IMenuProjectionSource {
	private readonly stores = new DisposableStore();
	private readonly main: IMenu;
	private readonly controller: MenuProjectionController;
	constructor(private readonly appName: string, private readonly resolver: MenuProjectionResolver,
		private readonly standard: IMainMenuProjectionStandard, scheduler: IMenuProjectionScheduler,
		@IMenuService menuService: IMenuService, @IContextKeyService contextKeys: IContextKeyService,
		@IKeybindingService keybindings: IKeybindingService) {
		super();
		this.main = this._register(menuService.createMenu(MenuId.MenubarMainMenu, contextKeys,
			{ emitEventsForSubmenuChanges: false, eventDebounceDelay: 0 }));
		this.controller = new MenuProjectionController('main-menu', () => this.capture(menuService, contextKeys), scheduler);
		this._register(this.main.onDidChange(() => this.controller.rebuild()));
		this._register(keybindings.onDidUpdateKeybindings(() => this.controller.rebuild()));
	}
	get snapshot(): MenuProjectionSnapshot { return this.controller.snapshot; }
	get onDidSnapshot(): Event<MenuProjectionSnapshot> { return this.controller.onDidSnapshot; }
	dispatch(event: MenuProjectionEvent): boolean { return this.controller.dispatch(event); }
	rebuild(): MenuProjectionSnapshot { return this.controller.rebuild(); }
	override dispose(): void {
		// Closing the controller publishes its terminal snapshot through capture(), so its submenu
		// store must remain live until that publication has completed.
		this.controller.dispose();
		this.stores.dispose();
		super.dispose();
	}
	private capture(menuService: IMenuService, contextKeys: IContextKeyService): readonly IMenuProjectionInput[] {
		this.stores.clear(); const tops: Array<{ original: string; title: string; menu: IMenu }> = [];
		const [group] = this.main.getActions();
		for (const action of group?.[1] ?? []) {
			if (action instanceof SubmenuItemAction && typeof action.item.title !== 'string') {
				const menu = this.stores.add(menuService.createMenu(action.item.submenu, contextKeys,
					{ emitEventsForSubmenuChanges: true, eventDebounceDelay: 0 }));
				this.stores.add(menu.onDidChange(() => this.controller.rebuild()));
				tops.push({ original: action.item.title.original, title: mnemonicMenuLabel(action.item.title.mnemonicTitle ?? action.item.title.value), menu });
			}
		}
		const preferences = tops.find(top => top.original === 'Preferences'); const help = tops.filter(top => top.original === 'Help');
		const application = this.standard.application(this.appName, preferences ? this.resolver.menu(preferences.menu) : []);
		const declared = tops.filter(top => top !== preferences && !help.includes(top)).map(top => ({
			id: `main.${top.original}`, kind: 'submenu' as const, label: top.title,
			items: top.original === 'Edit' ? [...this.standard.edit(), this.standard.separator,
				...this.resolver.menu(top.menu, this.standard.excludedEdit)] : this.resolver.menu(top.menu)
		}));
		return [application, ...declared, this.standard.window(), ...help.map(top => ({ id: `main.${top.original}`,
			kind: 'submenu' as const, label: top.title, items: this.resolver.menu(top.menu), role: 'help' as const }))];
	}
}
