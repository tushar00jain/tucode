/*---------------------------------------------------------------------------------------------
 *  A row's actions, offered.
 *
 *  Everything about *which* actions a context menu holds is upstream's and is reached by importing
 *  it: `ContextMenuMenuDelegate.transform` turns a `menuId` delegate into a `getActions` one through
 *  `IMenuService.getMenuActions` and `getFlatContextMenuActions`, so the groups, the orders and the
 *  `when` clauses that decide whether *Discard Changes* is on a row are `git.contribution.ts`'s
 *  declarations evaluated by `MenuService`. What is written here is the part `ContextMenuHandler`
 *  hands to `ContextView` and `Menu`: the box, and the keys that pick a line in it.
 *
 *  The gesture is the one thing that changed. A terminal has no right-click on a row, so the menu
 *  opens on **`Shift+F10`** — upstream's own keyboard route to a context menu, and reachable here
 *  since `input.ts` learned the CSI modifier parameter. The anchor a pane passes is its focused
 *  row's rectangle in cells, which is the same `IAnchor` a browser fills with pixels.
 *
 *  Upstream counterpart: src/vs/platform/contextview/browser/contextMenuService.ts, src/vs/platform/contextview/browser/contextMenuHandler.ts, src/vs/base/browser/ui/menu/menu.ts
 *--------------------------------------------------------------------------------------------*/

import { IContextMenuDelegate } from '../../vs/base/browser/contextmenu.js';
import { ActionRunner } from '../../vs/base/common/actions.js';
import { Color } from '../../vs/base/common/color.js';
import { Emitter } from '../../vs/base/common/event.js';
import { onUnexpectedError } from '../../vs/base/common/errors.js';
import { IRect } from '../../vs/base/common/layout.js';
import { Disposable, DisposableStore } from '../../vs/base/common/lifecycle.js';
import { localize } from '../../vs/nls.js';
import { IContextKeyService } from '../../vs/platform/contextkey/common/contextkey.js';
import { IContextMenuMenuDelegate, IContextMenuService } from '../../vs/platform/contextview/browser/contextView.js';
import { IMenuService } from '../../vs/platform/actions/common/actions.js';
import { ContextMenuMenuDelegate } from '../../vs/platform/contextview/browser/contextMenuService.js';
import { IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { editorWidgetBorder } from '../../vs/platform/theme/common/colors/editorColors.js';
import {
	menuBackground, menuBorder, menuForeground, menuSelectionBackground, menuSelectionForeground,
	menuSeparatorBackground
} from '../../vs/platform/theme/common/colors/menuColors.js';
import { descriptionForeground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { IMenuProjectionItem, MenuProjectionController, menuProjectionInputsOf } from '../../workbench/menuProjection.js';
import { IKey } from '../terminal/input.js';
import { ILine, spanWidth } from '../terminal/screen.js';
import { namedKeybinding } from './keyboard.js';
import { IFrameSize, IOverlaySize, ListOverlay, Overlays } from './overlay.js';

/** The padding `.monaco-menu .action-item` carries on each side, as the column a terminal spares. */
const PADDING = 1;

/** How wide the box may get: the widest label a row can produce is a path, and a menu is not one. */
const MAX_WIDTH = 60;

export class TerminalContextMenuService extends Disposable implements IContextMenuService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;

	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	constructor(
		private readonly overlays: Overlays,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IThemeService private readonly themeService: IThemeService
	) {
		super();
	}

	showContextMenu(rawDelegate: IContextMenuDelegate | IContextMenuMenuDelegate): void {
		const delegate = ContextMenuMenuDelegate.transform(rawDelegate, this.menuService, this.contextKeyService);
		const actions = delegate.getActions();
		if (!actions.length) {
			return;
		}

		const lifetime = new DisposableStore();
		const visuals = new DisposableStore();
		const runner = delegate.actionRunner ?? lifetime.add(new ActionRunner());
		const context = delegate.getActionsContext?.();
		const controller = lifetime.add(new MenuProjectionController('terminal-context-menu', () => menuProjectionInputsOf(actions, {
			key: action => ({ characters: '', modifiers: 0, label: (delegate.getKeyBinding?.(action)
				?? namedKeybinding(this.keybindingService, action.id, this.keybindingService.lookupKeybinding(action.id)))?.getLabel() ?? undefined }),
			run: async action => { await runner.run(action, context); }
		}), undefined, onUnexpectedError));
		const menu = visuals.add(new MenuOverlay(controller, this.themeService, anchorOf(delegate)));
		let closed = false;
		let commandSettled: (() => void) | undefined;
		lifetime.add(controller.onDidSnapshot(snapshot => {
			// Activation is scheduled after the menu closes. Track its pending notification
			// now, before SYNC can observe an empty overlay stack and acknowledge the input.
			if (snapshot.command.state === 'pending') {
				if (!commandSettled) {
					this.overlays.track(new Promise<void>(resolve => { commandSettled = resolve; }));
				}
			} else {
				commandSettled?.();
				commandSettled = undefined;
			}
			if (closed && snapshot.command.state !== 'pending') { lifetime.dispose(); }
		}));

		visuals.add(this.overlays.show(menu));
		visuals.add(menu.onDidClose(() => {
			closed = true;
			const snapshot = controller.snapshot;
			controller.dispatch({ generation: snapshot.generation, type: 'close', cancelled: !menu.activated });
			delegate.onHide?.(!menu.activated);
			this._onDidHideContextMenu.fire();
			visuals.dispose();
			if (controller.snapshot.command.state !== 'pending') { lifetime.dispose(); }
		}));

		this._onDidShowContextMenu.fire();
	}
}

/**
 * `IContextMenuDelegate.getAnchor` in cells. A browser answers an element or a mouse event; a pane
 * here answers the rectangle of the row the menu is about, which is the third of the three shapes
 * the interface already allows.
 */
function anchorOf(delegate: IContextMenuDelegate): IRect | undefined {
	const anchor = delegate.getAnchor() as { x?: number; y?: number; width?: number; height?: number } | undefined;

	return typeof anchor?.x === 'number' && typeof anchor.y === 'number'
		? { left: anchor.x, top: anchor.y, width: anchor.width ?? 0, height: anchor.height ?? 1 }
		: undefined;
}

class MenuOverlay extends ListOverlay {

	readonly anchor: IRect | undefined;
	readonly rows: readonly string[];
	activated = false;

	constructor(
		private readonly controller: MenuProjectionController,
		themeService: IThemeService,
		anchor: IRect | undefined
	) {
		super(themeService);
		this.anchor = anchor;
		this.rows = controller.snapshot.roots;
		this.didChangeRows();
		this.focusTo(this.rows.findIndex(id => enabled(this.item(id))));
	}

	get rowCount(): number {
		return this.rows.length;
	}

	get background(): Color | undefined {
		return this.themeService.getColorTheme().getColor(menuBackground);
	}

	/**
	 * `.monaco-menu` is `border: 1px solid var(--vscode-menu-border)`, and `menu.border` is defined
	 * only in the high-contrast themes — so the nearest registered widget border stands in where the
	 * theme says nothing, which is the rule the side bar's divider already follows.
	 */
	get border(): Color | undefined {
		const theme = this.themeService.getColorTheme();

		return theme.getColor(menuBorder) ?? theme.getColor(editorWidgetBorder);
	}

	get hint(): string {
		return localize('tscode.menuHint', "↑↓ move · Enter Run · Escape Close");
	}

	/** As wide as its widest line wants to be, which is what a menu sized to its content is. */
	size(frame: IFrameSize): IOverlaySize {
		const widest = this.rows.reduce((width, id) => Math.max(width, spanWidth(this.entryText(this.item(id)!))), 0);

		return {
			width: Math.min(widest + PADDING * 2 + 2, MAX_WIDTH, frame.cols),
			height: Math.min(this.rows.length + 2, frame.rows)
		};
	}

	private entryText(item: Readonly<IMenuProjectionItem>): string {
		const keybinding = enabled(item) ? item.key?.label : undefined;
		return item.kind === 'separator' ? '' : `${item.label}${keybinding ? `  ${keybinding}` : ''}`;
	}

	override handleKey(key: IKey): boolean {
		switch (key.name) {
			case 'escape':
				this.close();

				return true;
			case 'enter':
				this.accept();

				return true;
		}

		const handled = super.handleKey(key);
		if (handled) {
			const snapshot = this.controller.snapshot;
			this.controller.dispatch({ generation: snapshot.generation, type: 'highlight', id: this.rows[this.focus] });
		}
		return handled;
	}

	protected override focusable(index: number): boolean {
		return enabled(this.item(this.rows[index]));
	}

	private accept(): void {
		const id = this.rows[this.focus];
		const snapshot = this.controller.snapshot;
		this.activated = this.controller.dispatch({ generation: snapshot.generation, type: 'activate', id });
		this.close();
	}

	/** `.monaco-menu .action-item.focused` is `menu.selectionBackground`, across the whole menu. */
	protected override rowBackground(index: number, focused: boolean): Color | undefined {
		return focused ? this.themeService.getColorTheme().getColor(menuSelectionBackground) : undefined;
	}

	protected renderRow(index: number, focused: boolean): ILine {
		const theme = this.themeService.getColorTheme();
		const item = this.item(this.rows[index])!;

		if (item.kind === 'separator') {
			return [{ text: '─'.repeat(Math.max(0, this.inner.width)), fg: theme.getColor(menuSeparatorBackground) }];
		}

		const fg = focused
			? theme.getColor(menuSelectionForeground)
			: item.enabled ? theme.getColor(menuForeground) : theme.getColor(descriptionForeground);
		const bg = this.rowBackground(index, focused);
		const pad = ' '.repeat(PADDING);

		return [{ text: `${pad}${this.entryText(item)}`, fg, bg }, { text: pad, fg, bg }];
	}

	private item(id: string | undefined): Readonly<IMenuProjectionItem> | undefined {
		return id ? this.controller.snapshot.items.get(id) : undefined;
	}
}

function enabled(item: Readonly<IMenuProjectionItem> | undefined): item is Readonly<IMenuProjectionItem> {
	return !!item && item.kind !== 'separator' && item.enabled && item.visible;
}
