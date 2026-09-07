/*---------------------------------------------------------------------------------------------
 * Shared accessibility-help semantics and immutable projection.
 *
 * Upstream owns the command ids, keybindings, provider contract, localized editor-help copy and
 * Quick Input model. This service keeps those semantics while replacing only AccessibleView's
 * DOM renderer with a frontend projection. Native frontends render the snapshot and return a
 * close request; they do not choose content, symbols, commands or context keys.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { URI } from '../vs/base/common/uri.js';
import { AccessibilityHelpNLS } from '../vs/editor/common/standaloneStrings.js';
import { IContextKey, IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../vs/platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../vs/platform/opener/common/opener.js';
import { IQuickInputService } from '../vs/platform/quickinput/common/quickInput.js';
import { localize } from '../vs/nls.js';
import {
	AccesibleViewContentProvider, AccessibleViewProviderId, AccessibleViewType,
	IAccessibleViewService, IAccessibleViewSymbol, ICodeBlockActionContext,
	IPosition, isIAccessibleViewContentProvider
} from '../vs/platform/accessibility/browser/accessibleView.js';
import { accessibilityHelpIsShown, accessibleViewContainsCodeBlocks,
	accessibleViewCurrentProviderId, accessibleViewGoToSymbolSupported, accessibleViewHasAssignedKeybindings,
	accessibleViewHasUnassignedKeybindings, accessibleViewInCodeBlock, accessibleViewIsShown,
	accessibleViewOnLastLine, accessibleViewSupportsNavigation, accessibleViewVerbosityEnabled
} from '../vs/workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { resolveContentAndKeybindingItems } from '../vs/workbench/contrib/accessibility/browser/accessibleViewKeybindingResolver.js';

export interface IAccessibilityHelpProjectionSnapshot {
	readonly generation: number;
	readonly session: number;
	readonly open: boolean;
	readonly title: string;
	readonly content: string;
	readonly position?: IPosition;
}

const CLOSED: IAccessibilityHelpProjectionSnapshot = Object.freeze({
	generation: 0, session: 0, open: false, title: AccessibilityHelpNLS.accessibilityHelpTitle, content: ''
});

/** The complete context-key set the upstream AccessibleView resets when its surface closes. */
interface IAccessibleViewContextKeys {
	help: IContextKey<boolean>;
	view: IContextKey<boolean>;
	navigation: IContextKey<boolean>;
	verbosity: IContextKey<boolean>;
	symbols: IContextKey<boolean>;
	provider: IContextKey<string>;
	onLastLine: IContextKey<boolean>;
	inCodeBlock: IContextKey<boolean>;
	containsCodeBlocks: IContextKey<boolean>;
	hasUnassigned: IContextKey<boolean>;
	hasAssigned: IContextKey<boolean>;
}

export function editorHelpContent(): string {
	return [
		AccessibilityHelpNLS.editableEditor,
		AccessibilityHelpNLS.defaultWindowTitleExcludingEditorState,
		AccessibilityHelpNLS.toolbar,
		AccessibilityHelpNLS.listSignalSounds,
		AccessibilityHelpNLS.listAlerts,
		AccessibilityHelpNLS.announceCursorPosition,
		AccessibilityHelpNLS.focusNotifications,
		AccessibilityHelpNLS.suggestActions,
		AccessibilityHelpNLS.acceptSuggestAction,
		AccessibilityHelpNLS.toggleSuggestionFocus,
		AccessibilityHelpNLS.tabFocusModeOffMsg,
		AccessibilityHelpNLS.codeFolding,
		AccessibilityHelpNLS.intellisense,
		AccessibilityHelpNLS.showOrFocusHover,
		AccessibilityHelpNLS.goToSymbol,
		AccessibilityHelpNLS.startDebugging,
		AccessibilityHelpNLS.setBreakpoint,
		AccessibilityHelpNLS.debugExecuteSelection,
		AccessibilityHelpNLS.addToWatch,
		localize('projectedAccessibilityHelp.goToSymbol', 'Move between sections of this help with {0}.', '<keybinding:editor.action.accessibleViewGoToSymbol>'),
		localize('projectedAccessibilityHelp.exit', 'Exit this dialog (Escape).')
	].join('\n\n');
}

export function accessibilityHelpLineSymbols(content: string): IAccessibleViewSymbol[] {
	return content.split('\n').flatMap((line, index) => {
		const label = line.trim();
		return label ? [{ label, ariaLabel: label, lineNumber: index + 1 }] : [];
	});
}

/**
 * AccessibleView's semantic owner without its browser widget. The public service contract remains
 * upstream's, so upstream actions and providers keep one owner and Quick Input remains the symbol
 * picker rather than a second native list model.
 */
export class ProjectedAccessibleViewService extends Disposable implements IAccessibleViewService {
	declare readonly _serviceBrand: undefined;

	private generation = 0;
	private session = 0;
	private current: AccesibleViewContentProvider | undefined;
	private content = '';
	private symbols: readonly IAccessibleViewSymbol[] = [];
	private position: IPosition | undefined;
	private snapshotValue = CLOSED;
	private readonly snapshots = this._register(new Emitter<IAccessibilityHelpProjectionSnapshot>());
	readonly onDidSnapshot: Event<IAccessibilityHelpProjectionSnapshot> = this.snapshots.event;
	private readonly keys: IAccessibleViewContextKeys;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IOpenerService private readonly openerService: IOpenerService
	) {
		super();
		this.keys = {
			help: accessibilityHelpIsShown.bindTo(contextKeyService),
			view: accessibleViewIsShown.bindTo(contextKeyService),
			navigation: accessibleViewSupportsNavigation.bindTo(contextKeyService),
			verbosity: accessibleViewVerbosityEnabled.bindTo(contextKeyService),
			symbols: accessibleViewGoToSymbolSupported.bindTo(contextKeyService),
			provider: accessibleViewCurrentProviderId.bindTo(contextKeyService),
			onLastLine: accessibleViewOnLastLine.bindTo(contextKeyService),
			inCodeBlock: accessibleViewInCodeBlock.bindTo(contextKeyService),
			containsCodeBlocks: accessibleViewContainsCodeBlocks.bindTo(contextKeyService),
			hasUnassigned: accessibleViewHasUnassignedKeybindings.bindTo(contextKeyService),
			hasAssigned: accessibleViewHasAssignedKeybindings.bindTo(contextKeyService)
		};
	}

	get snapshot(): IAccessibilityHelpProjectionSnapshot { return this.snapshotValue; }

	show(provider: AccesibleViewContentProvider, position?: IPosition): void {
		this.closeCurrent(false);
		this.current = provider;
		this.session++;
		provider.onOpen?.();
		const resolved = resolveContentAndKeybindingItems(this.keybindingService, provider.provideContent());
		this.content = resolved?.content.value ?? provider.provideContent();
		if (isIAccessibleViewContentProvider(provider)) {
			provider.options.configureKeybindingItems = resolved?.configureKeybindingItems;
			provider.options.configuredKeybindingItems = resolved?.configuredKeybindingItems;
		}
		this.symbols = isIAccessibleViewContentProvider(provider)
			? provider.getSymbols?.() ?? accessibilityHelpLineSymbols(this.content)
			: accessibilityHelpLineSymbols(this.content);
		this.position = position;
		this.keys.help.set(provider.options.type === AccessibleViewType.Help);
		this.keys.view.set(provider.options.type === AccessibleViewType.View);
		this.keys.navigation.set(!!provider.provideNextContent || !!provider.providePreviousContent);
		this.keys.verbosity.set(false);
		this.keys.symbols.set(this.symbols.length > 0);
		this.keys.provider.set(provider.id);
		this.keys.onLastLine.set(false);
		this.keys.inCodeBlock.set(false);
		this.keys.containsCodeBlocks.set(false);
		this.keys.hasUnassigned.set(!!resolved?.configureKeybindingItems?.length);
		this.keys.hasAssigned.set(!!resolved?.configuredKeybindingItems?.length);
		this.publish(true);
	}

	/** A frontend close event is generation-scoped, so a stale panel cannot close its replacement. */
	close(session: number): boolean {
		if (!this.current || session !== this.session) { return false; }
		this.closeCurrent(true);
		return true;
	}

	showLastProvider(_id: AccessibleViewProviderId): void { }
	showAccessibleViewHelp(): void { }

	next(): void {
		const next = this.current?.provideNextContent?.();
		if (next) { this.content = next; this.symbols = accessibilityHelpLineSymbols(next); this.publish(true); }
	}

	previous(): void {
		const previous = this.current?.providePreviousContent?.();
		if (previous) { this.content = previous; this.symbols = accessibilityHelpLineSymbols(previous); this.publish(true); }
	}

	navigateToCodeBlock(_type: 'next' | 'previous'): void { }

	goToSymbol(): void {
		const session = this.session;
		const symbols = [...this.symbols];
		if (!this.current || !symbols.length) { return; }
		void this.quickInputService.pick(symbols, {
			title: localize('projectedAccessibilityHelp.symbolTitle', 'Go to Symbol Accessible View'),
			placeHolder: localize('projectedAccessibilityHelp.symbolPlaceholder', 'Type to search symbols')
		}).then(symbol => {
			if (!this.current || session !== this.session) { return; }
			if (symbol?.lineNumber) { this.position = { lineNumber: symbol.lineNumber, column: 1 }; }
			// The picker temporarily owns the key window. Republishing is the causal focus handoff back
			// to the still-open help renderer, whether a symbol was accepted or the picker was cancelled.
			this.publish(true);
		});
	}

	disableHint(): void { }
	getPosition(id: AccessibleViewProviderId): IPosition | undefined { return this.current?.id === id ? this.position : undefined; }
	setPosition(position: IPosition): void { this.position = position; if (this.current) { this.publish(true); } }
	getLastPosition(): IPosition | undefined { return this.position; }
	getOpenAriaHint(_verbositySettingKey: string): string | null {
		const binding = this.keybindingService.lookupKeybinding('editor.action.accessibleView')?.getAriaLabel();
		return binding ? localize('projectedAccessibilityHelp.openHint', 'Inspect this in the accessible view with {0}', binding) : null;
	}
	getCodeBlockContext(): ICodeBlockActionContext | undefined { return undefined; }
	configureKeybindings(_unassigned: boolean): void { }
	openHelpLink(): void {
		const url = this.current?.options.readMoreUrl;
		if (url) { void this.openerService.open(URI.parse(url)); }
	}

	private publish(open: boolean): void {
		this.snapshotValue = Object.freeze({ generation: ++this.generation, session: this.session, open,
			title: AccessibilityHelpNLS.accessibilityHelpTitle, content: open ? this.content : '',
			position: open ? this.position : undefined });
		this.snapshots.fire(this.snapshotValue);
	}

	private closeCurrent(publish: boolean): void {
		const provider = this.current;
		if (!provider) { return; }
		this.current = undefined;
		provider.onClose();
		provider.dispose();
		this.content = '';
		this.symbols = [];
		this.position = undefined;
		for (const key of Object.values(this.keys)) { key.reset(); }
		if (publish) { this.publish(false); }
	}

	override dispose(): void {
		this.closeCurrent(false);
		super.dispose();
	}
}
