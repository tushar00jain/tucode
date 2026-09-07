/*---------------------------------------------------------------------------------------------
 *  Native Quick Input paint records and input gateway.
 *
 *  The native service owns picker state. Swift consumes immutable, session-addressed records
 *  and returns identity-based events. Native typing and explicit service writes are separate
 *  directions on the existing bridge; result snapshots never write back into the active field.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { parseLabelWithIcons } from '../vs/base/common/iconLabels.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import type { IMatch } from '../vs/base/common/filters.js';
import type {
	IQuickInputButton, IQuickInputHideEvent, IQuickPickItem, QuickPickInput
} from '../vs/platform/quickinput/common/quickInput.js';
import type Severity from '../vs/base/common/severity.js';

export type QuickInputProducer = 'command-palette' | 'quick-open' | 'pick' | 'input-box' | 'live-picker';

export interface IQuickInputProjectionButton {
	readonly id: string;
	readonly label?: string;
	readonly tooltip?: string;
	readonly iconClass?: string;
	readonly checked?: boolean;
	readonly location?: number;
}

export interface IQuickInputProjectionRow {
	readonly id: string;
	readonly separator: boolean;
	readonly label: string;
	readonly labelMatches: readonly IMatch[];
	readonly description?: string;
	readonly descriptionMatches: readonly IMatch[];
	readonly detail?: string;
	readonly detailMatches: readonly IMatch[];
	readonly keybinding?: string;
	readonly iconClasses: readonly string[];
	readonly focused: boolean;
	readonly selected: boolean;
	readonly buttons: readonly IQuickInputProjectionButton[];
}

export interface QuickInputProjectionSnapshot {
	readonly sessionId: number;
	readonly producer: QuickInputProducer;
	readonly terminal: 'open' | 'accepted' | 'cancelled' | 'completed' | 'failed' | 'disposed';
	readonly title?: string;
	readonly description?: string;
	readonly step?: number;
	readonly totalSteps?: number;
	readonly value: string;
	readonly valueSelection?: readonly [number, number];
	readonly placeholder?: string;
	readonly prompt?: string;
	readonly validationMessage?: string;
	readonly validationSeverity: Severity;
	readonly enabled: boolean;
	readonly password: boolean;
	readonly busy: boolean;
	readonly hideInput: boolean;
	readonly hideList: boolean;
	readonly ignoreFocusOut: boolean;
	readonly canSelectMany: boolean;
	readonly keepScrollPosition: boolean;
	readonly scrollTop: number;
	readonly buttons: readonly IQuickInputProjectionButton[];
	readonly rows: readonly IQuickInputProjectionRow[];
	readonly focusedId?: string;
	readonly selectedIds: readonly string[];
}

export type QuickInputProjectionEvent =
	| { readonly sessionId: number; readonly type: 'value'; readonly value: string; readonly selection?: readonly [number, number] }
	| { readonly sessionId: number; readonly type: 'textInput'; readonly text: string }
	| { readonly sessionId: number; readonly type: 'compositionStart' }
	| { readonly sessionId: number; readonly type: 'compositionUpdate'; readonly text: string }
	| { readonly sessionId: number; readonly type: 'compositionEnd'; readonly text: string }
	| { readonly sessionId: number; readonly type: 'navigate'; readonly direction: 'previous' | 'next' }
	| { readonly sessionId: number; readonly type: 'focus'; readonly id?: string }
	| { readonly sessionId: number; readonly type: 'select'; readonly id: string; readonly selected: boolean }
	| { readonly sessionId: number; readonly type: 'activate'; readonly id: string }
	| { readonly sessionId: number; readonly type: 'accept' }
	| { readonly sessionId: number; readonly type: 'cancel' }
	| { readonly sessionId: number; readonly type: 'button'; readonly id: string; readonly rowId?: string }
	| { readonly sessionId: number; readonly type: 'focusChanged'; readonly focused: boolean }
	| { readonly sessionId: number; readonly type: 'scroll'; readonly top: number };

export interface IQuickInputProjectionRowSource {
	readonly item: QuickPickInput<IQuickPickItem>;
	readonly highlights?: readonly IMatch[];
	readonly keybindingLabel?: string;
}

export interface IQuickInputProjectionSource {
	readonly producer: QuickInputProducer;
	readonly title: string | undefined;
	readonly description: string | undefined;
	readonly step: number | undefined;
	readonly totalSteps: number | undefined;
	value: string;
	valueSelection: Readonly<[number, number]> | undefined;
	readonly placeholder: string | undefined;
	readonly prompt: string | undefined;
	readonly validationMessage: string | undefined;
	readonly severity: Severity;
	readonly enabled: boolean;
	readonly password?: boolean;
	readonly busy: boolean;
	readonly hideInput: boolean;
	readonly hideList: boolean;
	readonly ignoreFocusOut: boolean;
	readonly canSelectMany: boolean;
	readonly keepScrollPosition: boolean;
	readonly projectionScrollTop: number;
	readonly buttons: ReadonlyArray<IQuickInputButton>;
	readonly rowCount: number;
	readonly projectionFocus: number;
	readonly onDidChangeInput: Event<{ value?: string; selection?: readonly [number, number] }>;
	acceptInput(value: string, selection?: readonly [number, number]): void;
	readonly selectedItems: ReadonlyArray<IQuickPickItem>;
	readonly onDidChange: Event<void>;
	readonly onDidHide: Event<IQuickInputHideEvent>;
	row(index: number): IQuickInputProjectionRowSource | undefined;
	navigate(next: boolean): void;
	setProjectionFocus(index: number): void;
	setProjectionSelection(index: number, selected: boolean): void;
	setProjectionScroll(top: number): void;
	accept(): void;
	cancel(): void;
	triggerProjectionButton(button: IQuickInputButton, item?: QuickPickInput<IQuickPickItem>): void;
}

const EMPTY: readonly never[] = Object.freeze([]);
let nextSessionId = 0;
let nextIdentity = 0;
const identities = new WeakMap<object, string>();
function identity(value: object, prefix: string): string {
	let id = identities.get(value);
	if (!id) { identities.set(value, id = `${prefix}-${++nextIdentity}`); }
	return id;
}

function freezeMatches(matches: readonly IMatch[] | undefined): readonly IMatch[] {
	return matches?.length ? Object.freeze(matches.map(match => Object.freeze({ start: match.start, end: match.end }))) : EMPTY;
}

function buttonRecord(button: IQuickInputButton): IQuickInputProjectionButton {
	return Object.freeze({
		id: identity(button, 'quick-input-button'), label: button.label, tooltip: button.tooltip,
		iconClass: button.iconClass, checked: button.toggle?.checked, location: button.location
	});
}

/** One lifecycle-owned native presentation; the terminal paints upstream DOM directly. */
export class QuickInputProjectionController extends Disposable {
	readonly sessionId = ++nextSessionId;
	private terminal: QuickInputProjectionSnapshot['terminal'] = 'open';
	private readonly _onDidSnapshot = this._register(new Emitter<QuickInputProjectionSnapshot>());
	readonly onDidSnapshot: Event<QuickInputProjectionSnapshot> = this._onDidSnapshot.event;
	private readonly _onDidChangeInput = this._register(new Emitter<{ sessionId: number; value?: string; selection?: readonly [number, number] }>());
	readonly onDidChangeInput = this._onDidChangeInput.event;
	private _snapshot: QuickInputProjectionSnapshot;
	private readonly rowItems = new Map<string, QuickPickInput<IQuickPickItem>>();
	private readonly globalButtons = new Map<string, IQuickInputButton>();
	private readonly rowButtons = new Map<string, { readonly button: IQuickInputButton; readonly item: QuickPickInput<IQuickPickItem> }>();

	constructor(private readonly source: IQuickInputProjectionSource) {
		super();
		this._snapshot = this.capture();
		this._register(source.onDidChangeInput(change => {
			if (this.terminal === 'open') { this._onDidChangeInput.fire({ sessionId: this.sessionId, ...change }); }
		}));
		this._register(source.onDidChange(() => this.publish()));
		this._register(source.onDidHide(event => {
			if (event.reason === 2 && this.terminal === 'open') { this.terminal = 'cancelled'; }
			this.publish();
		}));
	}

	get snapshot(): QuickInputProjectionSnapshot { return this._snapshot; }

	dispatch(event: QuickInputProjectionEvent): boolean {
		if (event.sessionId !== this.sessionId || this.terminal !== 'open') { return false; }
		switch (event.type) {
			case 'value':
				this.source.acceptInput(event.value, event.selection);
				break;
			case 'textInput': this.source.value += event.text; break;
			case 'compositionStart': case 'compositionUpdate': break;
			case 'compositionEnd': if (event.text) { this.source.value += event.text; } break;
			case 'navigate': this.source.navigate(event.direction === 'next'); break;
			case 'focus': this.focus(event.id); break;
			case 'select': this.select(event.id, event.selected); break;
			case 'activate':
				if (!this.rowItems.has(event.id)) { return false; }
				this.focus(event.id); this.source.accept(); break;
			case 'accept': this.source.accept(); break;
			case 'cancel': this.source.cancel(); break;
			case 'button': this.button(event.id, event.rowId); break;
			case 'focusChanged': if (!event.focused && !this.source.ignoreFocusOut) { this.source.cancel(); } break;
			case 'scroll': this.source.setProjectionScroll(event.top); break;
		}
		this.publish();
		return true;
	}

	fail(): void { if (this.terminal === 'open') { this.terminal = 'failed'; this.publish(); } }
	terminate(outcome: Exclude<QuickInputProjectionSnapshot['terminal'], 'open'>): void {
		if (this.terminal === 'open' || outcome === 'failed') { this.terminal = outcome; this.publish(); }
	}

	override dispose(): void {
		if (this.terminal === 'open') { this.terminal = 'disposed'; this.publish(); }
		this.rowItems.clear(); this.globalButtons.clear(); this.rowButtons.clear();
		super.dispose();
	}

	private publish(): void {
		this._snapshot = this.capture();
		this._onDidSnapshot.fire(this._snapshot);
	}

	private capture(): QuickInputProjectionSnapshot {
		this.rowItems.clear(); this.globalButtons.clear(); this.rowButtons.clear();
		const selected = new Set(this.source.selectedItems);
		const rows: IQuickInputProjectionRow[] = [];
		for (let index = 0; index < this.source.rowCount; index++) {
			const sourceRow = this.source.row(index);
			if (!sourceRow) { continue; }
			const item = sourceRow.item;
			const id = identity(item, 'quick-input-item');
			this.rowItems.set(id, item);
			const separator = item.type === 'separator';
			const buttons = (item.buttons ?? []).map(button => {
				const record = buttonRecord(button);
				this.rowButtons.set(`${id}:${record.id}`, { button, item });
				return record;
			});
			rows.push(Object.freeze({
				id, separator, label: parseLabelWithIcons(item.label ?? '').text,
				labelMatches: freezeMatches(separator ? undefined : item.highlights?.label ?? sourceRow.highlights),
				description: item.description, descriptionMatches: freezeMatches(separator ? undefined : item.highlights?.description),
				detail: separator ? undefined : item.detail, detailMatches: freezeMatches(separator ? undefined : item.highlights?.detail),
				keybinding: separator ? undefined : sourceRow.keybindingLabel ?? item.keybinding?.getLabel() ?? undefined,
				iconClasses: Object.freeze(separator ? [] : item.iconClass ? [item.iconClass, ...(item.iconClasses ?? [])] : [...(item.iconClasses ?? [])]),
				focused: index === this.source.projectionFocus, selected: !separator && selected.has(item as IQuickPickItem),
				buttons: Object.freeze(buttons)
			}));
		}
		const buttons = this.source.buttons.map(button => {
			const record = buttonRecord(button); this.globalButtons.set(record.id, button); return record;
		});
		const focused = rows.find(row => row.focused)?.id;
		return Object.freeze({
			sessionId: this.sessionId, producer: this.source.producer, terminal: this.terminal,
			title: this.source.title, description: this.source.description, step: this.source.step, totalSteps: this.source.totalSteps,
			value: this.source.value, valueSelection: this.source.valueSelection ? Object.freeze([...this.source.valueSelection] as [number, number]) : undefined,
			placeholder: this.source.placeholder, prompt: this.source.prompt, validationMessage: this.source.validationMessage,
			validationSeverity: this.source.severity, enabled: this.source.enabled, password: !!this.source.password,
			busy: this.source.busy, hideInput: this.source.hideInput, hideList: this.source.hideList,
			ignoreFocusOut: this.source.ignoreFocusOut, canSelectMany: this.source.canSelectMany,
			keepScrollPosition: this.source.keepScrollPosition, scrollTop: this.source.projectionScrollTop,
			buttons: Object.freeze(buttons), rows: Object.freeze(rows), focusedId: focused,
			selectedIds: Object.freeze(rows.filter(row => row.selected).map(row => row.id))
		});
	}

	private focus(id: string | undefined): void {
		if (!id) { return; }
		const index = [...this.rowItems.keys()].indexOf(id);
		if (index >= 0) { this.source.setProjectionFocus(index); }
	}

	private select(id: string, selected: boolean): void {
		const index = [...this.rowItems.keys()].indexOf(id);
		if (index >= 0) { this.source.setProjectionSelection(index, selected); }
	}

	private button(id: string, rowId: string | undefined): void {
		if (rowId) {
			const entry = this.rowButtons.get(`${rowId}:${id}`);
			if (entry) { this.source.triggerProjectionButton(entry.button, entry.item); }
		} else {
			const button = this.globalButtons.get(id);
			if (button) { this.source.triggerProjectionButton(button); }
		}
	}
}
