/*---------------------------------------------------------------------------------------------
 * AppKit's IQuickInputService adapter. Quick Access and provider algorithms stay upstream;
 * the native picker retains the existing supported API without terminal panes, paint or keys.
 * Upstream QuickPick/QuickInputController require concrete browser widgets, so AppKit keeps
 * this bounded adapter. It is not a headless replacement for upstream Quick Input.
 *--------------------------------------------------------------------------------------------*/

import { compareAnything } from '../vs/base/common/comparers.js';
import { QuickInputControllerBase } from '../vs/platform/quickinput/common/quickInputController.js';
import { Emitter, Event } from '../vs/base/common/event.js';
import { IMatch } from '../vs/base/common/filters.js';
import { matchesFuzzyIconAware, parseLabelWithIcons } from '../vs/base/common/iconLabels.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { IObservable, observableValue } from '../vs/base/common/observable.js';
import Severity from '../vs/base/common/severity.js';
import { IContextKey, IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import {
	IInputBox, IKeyMods, IQuickInput, IQuickInputButton, IQuickInputHideEvent,
	IQuickInputService, IQuickNavigateConfiguration, IQuickPick, IQuickPickDidAcceptEvent,
	IQuickPickItem, IQuickPickItemButtonEvent, IQuickPickSeparator, IQuickPickSeparatorButtonEvent,
	IQuickPickWillAcceptEvent, ItemActivation, NO_KEY_MODS, QuickInputAlignment,
	QuickInputHideReason, QuickInputType, QuickPickFocus, QuickPickInput
} from '../vs/platform/quickinput/common/quickInput.js';
import { IQuickAccessController } from '../vs/platform/quickinput/common/quickAccess.js';
import { QuickAccessController } from '../vs/platform/quickinput/browser/quickAccess.js';
import { IKeyboardEvent } from '../vs/platform/keybinding/common/keybinding.js';
import { isQuickNavigateRelease } from '../vs/platform/quickinput/common/quickNavigation.js';
import { InQuickPickContextKey } from '../vs/workbench/browser/quickaccess.js';
import {
	QuickInputProducer, QuickInputProjectionController
} from './nativeQuickInputProjection.js';

export type { QuickInputProducer } from './nativeQuickInputProjection.js';

export class NativeQuickInputService extends QuickInputControllerBase implements IQuickInputService {

	declare readonly _serviceBrand: undefined;

	private readonly _onShow = this._register(new Emitter<void>());
	readonly onShow: Event<void> = this._onShow.event;

	private readonly _onHide = this._register(new Emitter<void>());
	readonly onHide: Event<void> = this._onHide.event;

	/** The native Command Center occupies the top of the editor column. */
	readonly alignment: IObservable<QuickInputAlignment> = observableValue(this, 'top');

	currentQuickInput: IQuickInput | undefined = undefined;
	currentProjection: QuickInputProjectionController | undefined = undefined;

	private current: NativeQuickPick<IQuickPickItem> | undefined;

	private _quickAccess: IQuickAccessController | undefined;

	/**
	 * `inQuickOpen`, which is what upstream's own rules for a box that is up are scoped to —
	 * `workbench.action.closeQuickOpen`'s `Escape` among them. `WorkbenchQuickInputService` binds it
	 * from these same two events, and without it that rule can never match while
	 * `tscode.stopEditingInput` (`inputFocus`, which a box up here also sets) always can.
	 */
	private readonly inQuickInputContext: IContextKey<boolean>;
	private pickerContext: IContextKey<boolean> | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService
	) {
		super();

		this.inQuickInputContext = InQuickPickContextKey.bindTo(contextKeyService);
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.onShow(() => {
			this.inQuickInputContext.set(true);
			this.pickerContext?.reset();
			this.pickerContext = this.current?.contextKey ? this.contextKeyService.createKey(this.current.contextKey, false) : undefined;
			this.pickerContext?.set(true);
		}));
		this._register(this.onHide(() => {
			if (this.current) { return; }
			this.inQuickInputContext.set(false);
			this.pickerContext?.reset(); this.pickerContext = undefined;
		}));
	}

	/** Uses the same release predicate and current-item acceptance as browser Quick Input. */
	handleKeyUp(event: IKeyboardEvent): boolean {
		const pick = this.current;
		if (!pick || pick.canSelectMany || !pick.quickNavigate || !isQuickNavigateRelease(pick.quickNavigate, event)) { return false; }
		if (pick.activeItems.length) { pick.accept(); }
		pick.quickNavigate = undefined;
		return true;
	}

	/**
	 * Upstream's `QuickAccessController`, unmodified. It is what turns a typed prefix into a
	 * provider — `>` for the commands, nothing for the files — instantiates that provider once and
	 * hands it a live picker to fill. Built on first use because it takes `IQuickInputService`,
	 * which is this.
	 */
	get quickAccess(): IQuickAccessController {
		if (!this._quickAccess) {
			this._quickAccess = this._register(this.instantiationService.createInstance(QuickAccessController));
		}

		return this._quickAccess;
	}

	override createQuickPick<T extends IQuickPickItem>(options: { useSeparators: true }): IQuickPick<T, { useSeparators: true }>;
	override createQuickPick<T extends IQuickPickItem>(options?: { useSeparators: boolean }): IQuickPick<T, { useSeparators: false }>;
	override createQuickPick<T extends IQuickPickItem>(): IQuickPick<T, { useSeparators: boolean }> {
		return this.makeQuickPick<T>('live-picker') as unknown as IQuickPick<T, { useSeparators: boolean }>;
	}

	private makeQuickPick<T extends IQuickPickItem>(producer: QuickInputProducer): NativeQuickPick<T> {
		const pick = new NativeQuickPick<T>(producer);
		const current = pick as unknown as NativeQuickPick<IQuickPickItem>;
		const input: IQuickInput = current;
		let accepted = false;
		pick.onDidAccept(() => accepted = true);

		pick.onDidShow(() => {
			if (this.current !== current) { this.current?.hide(); }
			accepted = false;
			this.current = current;
			this.currentQuickInput = input;
			this.currentProjection = pick.projection;
			this._onShow.fire();
		});
		pick.onDidHide(event => {
			pick.projection.terminate(accepted ? 'accepted' : event.reason === QuickInputHideReason.Gesture ? 'cancelled' : 'completed');
			const wasCurrent = this.current === current;
			if (wasCurrent) {
				this.current = undefined;
				this.currentQuickInput = undefined;
				this.currentProjection = undefined;
			}
			if (wasCurrent) { this._onHide.fire(); }
		});

		return pick;
	}

	async accept(keyMods: IKeyMods = NO_KEY_MODS): Promise<void> {
		if (this.current) { this.current.keyMods = keyMods; this.current.accept(); }
	}

	async cancel(reason = QuickInputHideReason.Gesture): Promise<void> {
		this.current?.hide(reason);
	}

	navigate(next: boolean): void {
		this.current?.navigate(next);
	}

	//#region --- what has no consumer here, and would be worse half-built

	get backButton(): IQuickInputButton {
		throw new Error('IQuickInputService.backButton is not available in tucode: nothing here runs a multi-step quick input.');
	}

	override createInputBox(): IInputBox {
		const input = this.makeQuickPick<IQuickPickItem>('input-box');
		input.hideList = true;
		return input as unknown as IInputBox;
	}

	createQuickWidget(): never {
		throw new Error('IQuickInputService.createQuickWidget is not available in tucode: a quick widget is a container for a custom DOM body.');
	}

	createQuickTree(): never {
		throw new Error('IQuickInputService.createQuickTree is not available in tucode: nothing registers a quick tree.');
	}

	focus(): void { }
	toggle(): void { }
	toggleHover(): void { }
	async back(): Promise<void> { }
	setAlignment(): void { }

	//#endregion
}

/** One item, as the list holds it: the pick itself and where *our* filter matched. */
interface IQuickPickRow<T extends IQuickPickItem> {
	readonly item: QuickPickInput<T>;
	readonly sortLabel: string;
	readonly keybindingLabel?: string;
	highlights?: IMatch[];
}

class NativeQuickPick<T extends IQuickPickItem> extends Disposable implements Omit<IQuickPick<T, { useSeparators: true }>, 'type'> {

	readonly type: QuickInputType.QuickPick | QuickInputType.InputBox;

	//#region --- the events `IQuickPick` publishes

	private readonly _onDidChangeValue = this._register(new Emitter<string>());
	readonly onDidChangeValue: Event<string> = this._onDidChangeValue.event;

	private readonly _onWillAccept = this._register(new Emitter<IQuickPickWillAcceptEvent>());
	readonly onWillAccept: Event<IQuickPickWillAcceptEvent> = this._onWillAccept.event;

	private readonly _onDidAccept = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	readonly onDidAccept: Event<IQuickPickDidAcceptEvent> = this._onDidAccept.event;

	private readonly _onDidChangeActive = this._register(new Emitter<T[]>());
	readonly onDidChangeActive: Event<T[]> = this._onDidChangeActive.event;

	private readonly _onDidChangeSelection = this._register(new Emitter<T[]>());
	readonly onDidChangeSelection: Event<T[]> = this._onDidChangeSelection.event;

	private readonly _onWillHide = this._register(new Emitter<IQuickInputHideEvent>());
	readonly onWillHide: Event<IQuickInputHideEvent> = this._onWillHide.event;

	private readonly _onDidHide = this._register(new Emitter<IQuickInputHideEvent>());
	readonly onDidHide: Event<IQuickInputHideEvent> = this._onDidHide.event;

	private readonly _onDidShow = this._register(new Emitter<void>());
	/** Ours: the service tracks which picker has the keyboard, and `IQuickInput` has no such event. */
	readonly onDidShow: Event<void> = this._onDidShow.event;

	private readonly _onDispose = this._register(new Emitter<void>());
	readonly onDispose: Event<void> = this._onDispose.event;

	private readonly _onDidTriggerButton = this._register(new Emitter<IQuickInputButton>());
	readonly onDidTriggerButton: Event<IQuickInputButton> = this._onDidTriggerButton.event;

	private readonly _onDidTriggerItemButton = this._register(new Emitter<IQuickPickItemButtonEvent<T>>());
	readonly onDidTriggerItemButton: Event<IQuickPickItemButtonEvent<T>> = this._onDidTriggerItemButton.event;

	private readonly _onDidTriggerSeparatorButton = this._register(new Emitter<IQuickPickSeparatorButtonEvent>());
	readonly onDidTriggerSeparatorButton: Event<IQuickPickSeparatorButtonEvent> = this._onDidTriggerSeparatorButton.event;

	private readonly _onDidCustom = this._register(new Emitter<void>());
	readonly onDidCustom: Event<void> = this._onDidCustom.event;

	//#endregion

	//#region --- the state, which is a plain field wherever nothing reads a change to it

	description: string | undefined = undefined;
	step: number | undefined = undefined;
	totalSteps: number | undefined = undefined;
	buttons: ReadonlyArray<IQuickInputButton> = [];
	enabled = true;
	contextKey: string | undefined = undefined;
	ignoreFocusOut = false;
	ariaLabel: string | undefined = undefined;
	placeholder: string | undefined = undefined;
	prompt: string | undefined = undefined;
	canAcceptInBackground = false;
	ok: boolean | 'default' = 'default';
	okLabel: string | undefined = undefined;
	customButton = false;
	customLabel: string | undefined = undefined;
	customHover: string | undefined = undefined;
	canSelectMany = false;
	matchOnDescription = false;
	matchOnDetail = false;
	matchOnLabel = true;
	matchOnLabelMode: 'fuzzy' | 'contiguous' = 'fuzzy';
	sortByLabel = true;
	keepScrollPosition = false;
	quickNavigate: IQuickNavigateConfiguration | undefined = undefined;
	itemActivation = ItemActivation.FIRST;
	private _valueSelection: Readonly<[number, number]> | undefined;
	get valueSelection(): Readonly<[number, number]> | undefined { return this._valueSelection; }
	set valueSelection(selection: Readonly<[number, number]> | undefined) {
		this._valueSelection = selection;
		this._onDidChangeInput.fire({ selection });
	}
	password = false;
	private _validationMessage: string | undefined = undefined;
	get validationMessage(): string | undefined { return this._validationMessage; }
	set validationMessage(value: string | undefined) { this._validationMessage = value; this.repaint(); }
	private _severity: Severity = Severity.Ignore;
	get severity(): Severity { return this._severity; }
	set severity(value: Severity) { this._severity = value; this.repaint(); }
	hideCountBadge = false;
	hideCheckAll = false;
	private _filterValue: (value: string) => string = value => value;
	get filterValue(): (value: string) => string { return this._filterValue; }
	set filterValue(filter: (value: string) => string) {
		this._filterValue = filter;
		if (this.producer === 'live-picker') {
			this.producer = this.value.startsWith('>') ? 'command-palette' : 'quick-open';
		}
	}

	/** `IPickOptions.hideInput` — a picker with nothing to type into, which a dialog's buttons are. */
	hideInput = false;

	/** Ours: `input()` is the same box with no list under it, which is what an input box is here. */
	hideList = false;

	//#endregion

	/** Everything, with its match state; `rows` is the subset that is on screen. */
	private all: IQuickPickRow<T>[] = [];
	private rows: IQuickPickRow<T>[] = [];

	private _items: ReadonlyArray<T | IQuickPickSeparator> = [];
	private _selectedItems: T[] = [];
	private _value = '';
	private _busy = false;
	private shown = false;
	private hidden = false;
	private _projection: QuickInputProjectionController | undefined;

	constructor(producer: QuickInputProducer) {
		super();
		this.producer = producer;
		this.type = producer === 'input-box' ? QuickInputType.InputBox : QuickInputType.QuickPick;
	}

	title = '';
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeInput = this._register(new Emitter<{ value?: string; selection?: readonly [number, number] }>());
	readonly onDidChangeInput = this._onDidChangeInput.event;
	private focusIndex = -1;
	private scrollTop = 0;
	private repaint(): void { this._onDidChange.fire(); }
	private didChangeRows(): void { this.repaint(); }
	private focusTo(index: number): void {
		this.focusIndex = index;
		this.repaint();
	}
	focus(what: QuickPickFocus): void {
		const indices = this.rows.flatMap((row, index) => isSeparator(row.item) ? [] : [index]);
		if (!indices.length) { this.focusTo(-1); return; }
		const at = indices.indexOf(this.focusIndex);
		const previous = what === QuickPickFocus.Previous || what === QuickPickFocus.PreviousPage;
		const next = at < 0 ? (previous ? indices.length - 1 : 0) : at + (previous ? -1 : 1);
		const index = what === QuickPickFocus.First ? 0 : what === QuickPickFocus.Second ? Math.min(1, indices.length - 1)
			: what === QuickPickFocus.Last ? indices.length - 1
			: this.canSelectMany ? Math.max(0, Math.min(next, indices.length - 1)) : (next + indices.length) % indices.length;
		this.focusTo(indices[index]);
		this.fireActive();
	}

	producer: QuickInputProducer;

	/** The immutable state and input boundary consumed by AppKit. */
	get projection(): QuickInputProjectionController {
		return this._projection ??= this._register(new QuickInputProjectionController(this));
	}

	//#region --- `IQuickInput`: showing, hiding and the lifecycle

	show(): void {
		if (this.shown) {
			return;
		}
		this._projection?.dispose();
		this._projection = undefined;
		this.hidden = false;
		this.shown = true;
		this._onDidShow.fire();
	}

	hide(reason?: QuickInputHideReason): void {
		if (this.hidden) {
			return;
		}

		this.hidden = true;
		this.willHide(reason);
		this.shown = false;
		this.didHide(reason);
	}

	willHide(reason: QuickInputHideReason = QuickInputHideReason.Other): void {
		this._onWillHide.fire({ reason });
	}

	didHide(reason: QuickInputHideReason = QuickInputHideReason.Other): void {
		this._onDidHide.fire({ reason });
	}

	/** Native dismissal. */
	cancel(): void {
		this.hide(QuickInputHideReason.Gesture);
	}

	override dispose(): void {
		this.hide();
		this._onDispose.fire();
		super.dispose();
	}

	//#endregion

	//#region --- `IQuickPick`: the value, the items, and what is active

	get value(): string {
		return this._value;
	}

	set value(value: string) {
		this.setValue(value, false);
	}

	/** Native editing already changed the field, as in upstream QuickPick.doSetValue(skipUpdate). */
	acceptInput(value: string, selection?: readonly [number, number]): void {
		if (!this.enabled) { return; }
		this._valueSelection = selection;
		this.setValue(value, true);
	}

	private setValue(value: string, fromInput: boolean): void {
		if (value === this._value) {
			return;
		}

		this._value = value;
		if (!fromInput) { this._onDidChangeInput.fire({ value }); }
		this.filter();
		this.didChangeRows();
		if (!this.canSelectMany) { this.focus(QuickPickFocus.First); }
		this._onDidChangeValue.fire(this._value);
		this.fireActive();
	}

	get items(): ReadonlyArray<T | IQuickPickSeparator> {
		return this._items;
	}

	set items(items: ReadonlyArray<T | IQuickPickSeparator>) {
		this._items = items;
		this.all = items.map(item => ({
			item,
			// `BaseQuickPickItemElement`'s own `saneSortLabel`.
			sortLabel: parseLabelWithIcons(isSeparator(item) ? item.label ?? '' : item.label).text.trim(),
			keybindingLabel: isSeparator(item) ? undefined : item.keybinding?.getLabel() ?? undefined
		}));
		this.filter();
		this.didChangeRows();
		// QuickPick.update's one-shot activation, applied to native result rows.
		switch (this.itemActivation) {
			case ItemActivation.NONE: this.focusTo(-1); this.itemActivation = ItemActivation.FIRST; break;
			case ItemActivation.SECOND: this.focus(QuickPickFocus.Second); this.itemActivation = ItemActivation.FIRST; break;
			case ItemActivation.LAST: this.focus(QuickPickFocus.Last); this.itemActivation = ItemActivation.FIRST; break;
			default: if (!this.keepScrollPosition) { this.focus(QuickPickFocus.First); } break;
		}
		this.fireActive();
	}

	get activeItems(): ReadonlyArray<T> {
		const item = this.rows[this.focusIndex]?.item;

		return item && !isSeparator(item) ? [item] : [];
	}

	set activeItems(items: ReadonlyArray<T>) {
		const at = this.rows.findIndex(row => row.item === items[0]);
		if (at !== -1) {
			this.focusTo(at);
			this.fireActive();
		}
	}

	get selectedItems(): ReadonlyArray<T> {
		return this._selectedItems;
	}

	set selectedItems(items: ReadonlyArray<T>) {
		if (items.length === this._selectedItems.length && items.every((item, index) => item === this._selectedItems[index])) { return; }
		this._selectedItems = [...items];
		this.repaint();
		this._onDidChangeSelection.fire([...this._selectedItems]);
	}

	setProjectionFocus(index: number): void {
		const item = this.rows[index]?.item;
		if (item && !isSeparator(item)) { this.activeItems = [item]; }
	}

	setProjectionSelection(index: number, selected: boolean): void {
		const item = this.rows[index]?.item;
		if (!item || isSeparator(item)) { return; }
		const selection = new Set(this._selectedItems);
		if (selected) { selection.add(item); } else { selection.delete(item); }
		this.selectedItems = [...selection];
	}

	get projectionFocus(): number { return this.focusIndex; }
	get projectionScrollTop(): number { return this.scrollTop; }
	setProjectionScroll(top: number): void { this.scrollTop = top; }

	triggerProjectionButton(button: IQuickInputButton, item?: QuickPickInput<IQuickPickItem>): void {
		if (!item) { this._onDidTriggerButton.fire(button); return; }
		if (isSeparator(item)) {
			this._onDidTriggerSeparatorButton.fire({ button, separator: item });
		} else {
			this._onDidTriggerItemButton.fire({ button, item: item as T });
		}
	}

	/** Modifier state is supplied by native acceptance and key-up events. */
	keyMods: IKeyMods = NO_KEY_MODS;

	get busy(): boolean {
		return this._busy;
	}

	set busy(busy: boolean) {
		if (busy === this._busy) {
			return;
		}

		this._busy = busy;
		this.repaint();
	}

	inputHasFocus(): boolean {
		return !this.hideInput;
	}

	focusOnInput(): void { }

	//#endregion

	get rowCount(): number {
		return this.rows.length;
	}

	/**
	 * One filtered row, including the highlights already computed by `filter()`.
	 */
	row(index: number): IQuickPickRow<T> | undefined {
		return this.rows[index];
	}

	/**
	 * Accepting: `onWillAccept` first, which is what `QuickAccessController`'s pick mode vetoes,
	 * then the selection and `onDidAccept` — the order `QuickPick.accept` fires them in.
	 */
	accept(inBackground = false): void {
		let vetoed = false;
		this._onWillAccept.fire({ veto: () => (vetoed = true) });
		if (vetoed) {
			return;
		}

		if (!this.enabled || (inBackground && !this.canAcceptInBackground)) { return; }
		if (!this.canSelectMany) { this._selectedItems = [...this.activeItems]; }
		this._onDidAccept.fire({ inBackground });
	}

	navigate(next: boolean): void {
		this.focus(next ? QuickPickFocus.Next : QuickPickFocus.Previous);
	}

	private fireActive(): void {
		this._onDidChangeActive.fire([...this.activeItems]);
	}

	/**
	 * `QuickInputList.filter`: the query against the label — and, where the flags ask, against the
	 * description and the detail — with `alwaysShow` keeping an item that matched nothing, and a
	 * separator dropped while a query is being typed. **The reset arm is load-bearing**: a provider
	 * that filters for itself turns all three flags off (`PickerQuickAccessProvider.provide`), and
	 * without it every one of its picks would be filtered away by a query it had already applied.
	 *
	 * The value is read through `filterValue`, which is how quick access keeps its prefix out of the
	 * filter: `QuickAccessController` sets it to `value => value.substring(prefix.length)`.
	 */
	private filter(): void {
		const query = this.filterValue(this._value).trim();

		if (!query || !(this.matchOnLabel || this.matchOnDescription || this.matchOnDetail)) {
			for (const row of this.all) {
				row.highlights = undefined;
			}
			this.rows = [...this.all];

			return;
		}

		const matched: IQuickPickRow<T>[] = [];
		for (const row of this.all) {
			if (isSeparator(row.item)) {
				row.highlights = undefined;
				continue;
			}

			const label = this.matchOnLabel ? matchesFuzzyIconAware(query, parseLabelWithIcons(row.item.label)) ?? undefined : undefined;
			const description = this.matchOnDescription ? matchesFuzzyIconAware(query, parseLabelWithIcons(row.item.description ?? '')) ?? undefined : undefined;
			const detail = this.matchOnDetail ? matchesFuzzyIconAware(query, parseLabelWithIcons(row.item.detail ?? '')) ?? undefined : undefined;

			row.highlights = label;
			if (label || description || detail || row.item.alwaysShow) {
				matched.push(row);
			}
		}

		// `compareEntries`: an item the label matched comes first, and `compareAnything` decides
		// between two that both did. Only when the caller asked to be sorted by label.
		if (this.sortByLabel) {
			matched.sort((a, b) => (b.highlights?.length ? 1 : 0) - (a.highlights?.length ? 1 : 0)
				|| compareAnything(a.sortLabel, b.sortLabel, query));
		}

		this.rows = matched;
	}

}

function isSeparator<T extends IQuickPickItem>(item: QuickPickInput<T>): item is IQuickPickSeparator {
	return item.type === 'separator';
}
