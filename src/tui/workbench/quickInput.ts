/*---------------------------------------------------------------------------------------------
 * Terminal transport and cell paint for VS Code's actual Quick Input controller and widgets.
 * The DOM shim holds the input and rendered rows; upstream owns filtering, selection and lifetime.
 * Upstream counterpart: src/vs/platform/quickinput/browser/quickInputService.ts
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, IDisposable } from '../../vs/base/common/lifecycle.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../vs/platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILayoutService } from '../../vs/platform/layout/browser/layoutService.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { QuickInputService } from '../../vs/platform/quickinput/browser/quickInputService.js';
import { QuickInputController } from '../../vs/platform/quickinput/browser/quickInputController.js';
import { IQuickPick, IQuickPickItem, QuickInputType, QuickPickFocus } from '../../vs/platform/quickinput/common/quickInput.js';
import { InQuickPickContextKey } from '../../vs/workbench/browser/quickaccess.js';
import { editorWidgetBorder } from '../../vs/platform/theme/common/colors/editorColors.js';
import { quickInputBackground, quickInputForeground, quickInputListFocusBackground, quickInputListFocusForeground } from '../../vs/platform/theme/common/colors/quickpickColors.js';
import { descriptionForeground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { editTextField } from '../../input/editValue.js';
import { TerminalElement } from '../terminal/dom/document.js';
import { paint } from '../terminal/dom/paint.js';
import { IKey } from '../terminal/input.js';
import { ILine } from '../terminal/screen.js';
import { toBrowserKeyboardEvent } from './keyboard.js';
import { CARET, INPUT_EDITING_HINT } from './inputBox.js';
import { GOLDEN_CUT, IFrameSize, IOverlay, IOverlaySize, LIST_HEIGHT_SHARE, Overlays } from './overlay.js';

export class TerminalQuickInputService extends QuickInputService {
	private terminalController: QuickInputController | undefined;
	private overlay: QuickInputOverlay | undefined;
	private shown: IDisposable | undefined;

	constructor(
		private readonly overlays: Overlays,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILayoutService layoutService: ILayoutService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(instantiationService, contextKeyService, themeService, layoutService, configurationService);
		const context = InQuickPickContextKey.bindTo(contextKeyService);
		this._register(this.onShow(() => {
			context.set(true);
			this.shown?.dispose();
			this.overlay ??= this._register(new QuickInputOverlay(this, this.terminalController!, themeService));
			this.shown = this.overlays.show(this.overlay);
		}));
		this._register(this.onHide(() => { context.reset(); this.shown?.dispose(); this.shown = undefined; }));
	}

	track(work: Promise<unknown>): void { this.overlays.track(work); }

	protected override createController(): QuickInputController {
		return this.terminalController = super.createController(this.layoutService, {
			ignoreFocusOut: () => !this.configurationService.getValue('workbench.quickOpen.closeOnFocusLost'),
			backKeybindingLabel: () => this.keybindingService.lookupKeybinding('workbench.action.quickInputBack')?.getLabel() ?? undefined
		});
	}
}

/** The upstream list's normal row is 22px; the terminal paints that as one cell row. */
const ROW_HEIGHT = 22;

class QuickInputOverlay extends Disposable implements IOverlay {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly onDidClose = Event.None;
	private paintPending = false;
	private disposed = false;

	constructor(private readonly service: TerminalQuickInputService,
		private readonly controller: QuickInputController, private readonly themeService: IThemeService) {
		super();
		this._register(controller.onDidChange(() => this.invalidate()));
	}

	private invalidate(): void {
		if (this.paintPending || this.disposed) { return; }
		this.paintPending = true;
		// Finish the upstream update before the workbench reads its DOM. No input is queued here.
		queueMicrotask(() => {
			this.paintPending = false;
			if (!this.disposed) { this.changed.fire(); }
		});
	}

	private get widget(): TerminalElement | undefined {
		return (this.controller.container as unknown as TerminalElement).querySelector('.quick-input-widget') ?? undefined;
	}
	private get input(): TerminalElement | undefined {
		return this.widget?.querySelector('.quick-input-box input') ?? undefined;
	}
	private get picker(): IQuickPick<IQuickPickItem> | undefined {
		const input = this.service.currentQuickInput;
		return input?.type === QuickInputType.QuickPick ? input as IQuickPick<IQuickPickItem> : undefined;
	}
	get busy(): boolean { return this.paintPending || !!this.service.currentQuickInput?.busy; }
	get background() { return this.themeService.getColorTheme().getColor(quickInputBackground); }
	get border() { return this.themeService.getColorTheme().getColor(editorWidgetBorder); }
	get hint(): string { return `↑↓ move · Enter Select · Escape Cancel · ${INPUT_EDITING_HINT}`; }

	size(frame: IFrameSize): IOverlaySize {
		const width = Math.max(1, Math.round(frame.cols * GOLDEN_CUT));
		const listRows = this.picker ? Math.max(1, Math.round(frame.rows * LIST_HEIGHT_SHARE)) : 0;
		return { width, height: Math.min(frame.rows, this.header().length + listRows + (this.border ? 2 : 0)) };
	}

	private header(): ILine[] {
		const theme = this.themeService.getColorTheme();
		const fg = theme.getColor(quickInputForeground);
		const muted = theme.getColor(descriptionForeground);
		const lines: ILine[] = [];
		const current = this.service.currentQuickInput;
		if (current?.title) { lines.push([{ text: ` ${current.title}`, fg, bold: true }]); }
		const input = this.input;
		if (input && !this.picker?.hideInput) {
			const value = input.getAttribute('type') === 'password' || (input as unknown as { type: string }).type === 'password'
				? '•'.repeat(input.value.length) : input.value;
			const start = input.selectionStart, end = input.selectionEnd;
			lines.push([{ text: ' ', fg }, { text: value.slice(0, start), fg },
				{ text: CARET, fg }, { text: value.slice(start, end), fg, underline: true },
				{ text: value.slice(end) || (!value ? input.getAttribute('placeholder') ?? '' : ''), fg: value ? fg : muted }]);
		}
		const message = this.widget?.querySelector('.quick-input-message');
		if (message?.textContent) { lines.push([{ text: ' ' }, ...paint(message, theme, { fg: muted })]); }
		return lines;
	}

	render(size: IOverlaySize): ILine[] {
		const header = this.header();
		const height = Math.max(0, size.height - header.length);
		this.controller.layoutList(height * ROW_HEIGHT, size.width * 4);
		const theme = this.themeService.getColorTheme();
		const rows = this.widget?.querySelectorAll('.monaco-list-row') ?? [];
		rows.sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')));
		const lines = rows.map(row => {
			const focused = row.classList.contains('focused');
			const fg = theme.getColor(focused ? quickInputListFocusForeground : quickInputForeground);
			const bg = focused ? theme.getColor(quickInputListFocusBackground) : this.background;
			return [{ text: ' ', fg, bg }, ...paint(row, theme, { fg, bg })];
		});
		return [...header, ...lines.slice(0, height)];
	}

	handleKey(key: IKey): boolean {
		if (key.name === 'escape') { this.cancel(); return true; }
		if (key.name === 'enter') { void this.service.accept(); return true; }
		if (key.name === 'space' && this.picker?.canSelectMany && this.picker.hideInput) {
			this.service.toggle(); return true;
		}
		const input = this.input;
		if (input && !this.picker?.hideInput && this.service.currentQuickInput?.enabled) {
			const edited = editTextField(key, { value: input.value, selection: [input.selectionStart, input.selectionEnd] });
			if (edited) {
				input.value = edited.value;
				input.setSelectionRange(...edited.selection);
				input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
				this.invalidate();
				return true;
			}
		}
		if (this.picker) {
			const focus = { up: QuickPickFocus.Previous, down: QuickPickFocus.Next,
				pageUp: QuickPickFocus.PreviousPage, pageDown: QuickPickFocus.NextPage,
				home: QuickPickFocus.First, end: QuickPickFocus.Last }[key.name];
			if (focus !== undefined) { this.picker.focus(focus); return true; }
		}
		const event = toBrowserKeyboardEvent(key);
		return !!event && !(document.activeElement ?? this.controller.container).dispatchEvent(event);
	}

	handlePaste(text: string): boolean {
		const input = this.input;
		if (!input || this.picker?.hideInput || !this.service.currentQuickInput?.enabled) { return false; }
		const value = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
		const end = input.selectionStart + text.length;
		input.value = value;
		input.setSelectionRange(end, end);
		input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
		this.invalidate();
		return true;
	}

	cancel(): void { void this.service.cancel(); }
	override dispose(): void { this.disposed = true; super.dispose(); }
}
