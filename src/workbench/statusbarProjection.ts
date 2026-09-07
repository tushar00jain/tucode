/*---------------------------------------------------------------------------------------------
 * Immutable terminal status-bar state and normalized action/ordering controller.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { toErrorMessage } from '../vs/base/common/errorMessage.js';
import { hash } from '../vs/base/common/hash.js';
import { ILabelIconSegment, parseLabelWithIconSegments, stripIcons } from '../vs/base/common/iconLabels.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../vs/platform/storage/common/storage.js';
import {
	IStatusbarEntry, IStatusbarEntryLocation, IStatusbarEntryPriority, isStatusbarEntryLocation,
	isStatusbarEntryPriority, isTooltipWithCommands, ShowTooltipCommand, StatusbarAlignment, StatusbarEntryKind, TooltipContent
} from '../vs/workbench/services/statusbar/browser/statusbar.js';
import { isMarkdownString } from '../vs/base/common/htmlContent.js';

export { StatusbarAlignment };
export type {
	IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarEntryLocation, IStatusbarEntryPriority, IStatusbarService, StatusbarEntryKind
} from '../vs/workbench/services/statusbar/browser/statusbar.js';

export interface IStatusbarProjectionEntry {
	readonly id: string;
	readonly sourceId: string;
	readonly alignment: 'left' | 'right';
	readonly order: number;
	readonly compactWith?: string;
	readonly name: string;
	readonly label: readonly Readonly<ILabelIconSegment>[];
	readonly text: string;
	readonly ariaLabel: string;
	readonly role: string;
	readonly tooltip?: string;
	readonly color?: string;
	readonly background?: string;
	readonly kind: StatusbarEntryKind;
	readonly actionId?: string;
	readonly progress: false | 'loading' | 'syncing';
	readonly visible: boolean;
}

export interface StatusbarProjectionSnapshot {
	readonly generation: number;
	readonly terminal: 'open' | 'failed' | 'disposed';
	readonly focusedId?: string;
	readonly entries: readonly IStatusbarProjectionEntry[];
	readonly left: readonly string[];
	readonly right: readonly string[];
	readonly pendingActionId?: string;
}

export type StatusbarProjectionEvent =
	| { readonly generation: number; readonly type: 'activate'; readonly id: string }
	| { readonly generation: number; readonly type: 'focus'; readonly id?: string };

export interface IStatusbarProjectionActions {
	execute(id: string, args: readonly unknown[]): void | Promise<void>;
	report(error: string): void;
	telemetry?(id: string): void;
}

interface Registration {
	readonly id: string;
	readonly sourceId: string;
	readonly alignment: StatusbarAlignment;
	readonly priority: IStatusbarEntryPriority;
	entry: IStatusbarEntry;
}

const HIDDEN_ENTRIES_KEY = 'workbench.statusbar.hidden';
let nextRegistration = 0;

/** Owns entry registration, ordering, replacement, visibility and async command settlement. */
export class StatusbarProjectionController extends Disposable {
	private readonly changed = this._register(new Emitter<StatusbarProjectionSnapshot>());
	readonly onDidSnapshot: Event<StatusbarProjectionSnapshot> = this.changed.event;
	private readonly visibilityChanged = this._register(new Emitter<{ id: string; visible: boolean }>());
	readonly onDidChangeEntryVisibility: Event<{ id: string; visible: boolean }> = this.visibilityChanged.event;
	private readonly registrations = new Map<string, Registration>();
	private hidden = new Set<string>();
	private generation = 0;
	private terminal: StatusbarProjectionSnapshot['terminal'] = 'open';
	private focusedId: string | undefined;
	private pendingActionId: string | undefined;
	private actionGeneration = 0;
	private current: StatusbarProjectionSnapshot;

	constructor(private readonly storage: IStorageService, private readonly actions?: IStatusbarProjectionActions) {
		super();
		this.restoreVisibility();
		this.current = this.capture();
		this._register(storage.onDidChangeValue(StorageScope.PROFILE, HIDDEN_ENTRIES_KEY, this._store)(() => this.reloadVisibility()));
	}

	get snapshot(): StatusbarProjectionSnapshot { return this.current; }

	addEntry(entry: IStatusbarEntry, sourceId: string, alignment: StatusbarAlignment,
		priorityOrLocation: number | IStatusbarEntryLocation | IStatusbarEntryPriority = 0): { readonly id: string; update(entry: IStatusbarEntry): void; dispose(): void } {
		const id = `statusbar-${++nextRegistration}`;
		const priority = isStatusbarEntryPriority(priorityOrLocation) ? priorityOrLocation :
			{ primary: priorityOrLocation, secondary: hash(sourceId) };
		this.registrations.set(id, { id, sourceId, alignment, priority, entry });
		this.publish();
		let disposed = false;
		return {
			id,
			update: value => {
				if (disposed || !this.registrations.has(id)) { return; }
				this.registrations.get(id)!.entry = value;
				this.publish();
			},
			dispose: () => {
				if (disposed) { return; }
				disposed = true;
				this.registrations.delete(id);
				if (this.focusedId === id) { this.focusedId = undefined; }
				if (this.pendingActionId === id) { this.pendingActionId = undefined; ++this.actionGeneration; }
				this.publish();
			}
		};
	}

	isEntryVisible(id: string): boolean { return !this.hidden.has(id); }

	setEntryVisibility(id: string, visible: boolean): void {
		if (visible ? !this.hidden.delete(id) : this.hidden.has(id)) { return; }
		if (!visible) { this.hidden.add(id); }
		this.saveVisibility();
		this.visibilityChanged.fire({ id, visible });
		this.publish();
	}

	dispatch(event: StatusbarProjectionEvent): boolean {
		if (event.generation !== this.current.generation || this.terminal !== 'open') { return false; }
		if (event.type === 'focus') {
			if (event.id !== undefined && !this.registrations.has(event.id)) { return false; }
			this.focusedId = event.id;
			this.publish();
			return true;
		}
		const registration = this.registrations.get(event.id);
		if (!registration || this.hidden.has(registration.sourceId) || !registration.entry.command) { return false; }
		if (registration.entry.command === ShowTooltipCommand) { return true; }
		const command = registration.entry.command;
		const id = typeof command === 'string' ? command : command.id;
		const args = typeof command === 'string' ? [] : command.arguments ?? [];
		const actionGeneration = ++this.actionGeneration;
		this.pendingActionId = event.id;
		this.actions?.telemetry?.(id);
		this.publish();
		Promise.resolve(this.actions?.execute(id, args)).then(() => {
			if (this.terminal === 'open' && actionGeneration === this.actionGeneration) {
				this.pendingActionId = undefined;
				this.publish();
			}
		}, error => {
			this.actions?.report(toErrorMessage(error));
			if (this.terminal === 'open' && actionGeneration === this.actionGeneration) {
				this.pendingActionId = undefined;
				this.terminal = 'failed';
				this.publish();
			}
		});
		return true;
	}

	override dispose(): void {
		if (this.terminal === 'disposed') { return; }
		this.terminal = 'disposed';
		++this.actionGeneration;
		this.pendingActionId = undefined;
		this.registrations.clear();
		this.publish();
		super.dispose();
	}

	private publish(): void {
		this.current = this.capture();
		this.changed.fire(this.current);
	}

	private capture(): StatusbarProjectionSnapshot {
		const ordered = orderRegistrations([...this.registrations.values()]);
		const entries = ordered.map((registration, order): IStatusbarProjectionEntry => {
			const entry = registration.entry;
			const command = entry.command;
			return Object.freeze({
				id: registration.id, sourceId: registration.sourceId,
				alignment: registration.alignment === StatusbarAlignment.LEFT ? 'left' : 'right', order,
				compactWith: compactWith(registration.priority), name: entry.name,
				label: parseLabelWithIconSegments(entry.text), text: stripIcons(entry.text), ariaLabel: entry.ariaLabel,
				role: entry.role ?? (command ? 'button' : 'status'), tooltip: tooltipText(entry.tooltip),
				color: colorId(entry.color), background: colorId(entry.backgroundColor), kind: entry.kind ?? 'standard',
				actionId: command && command !== ShowTooltipCommand ? (typeof command === 'string' ? command : command.id) : undefined,
				progress: entry.showProgress === 'syncing' ? 'syncing' : entry.showProgress ? 'loading' : false,
				visible: !this.hidden.has(registration.sourceId)
			});
		});
		return Object.freeze({
			generation: ++this.generation, terminal: this.terminal, focusedId: this.focusedId,
			entries: Object.freeze(entries),
			left: Object.freeze(entries.filter(entry => entry.visible && entry.alignment === 'left').map(entry => entry.id)),
			right: Object.freeze(entries.filter(entry => entry.visible && entry.alignment === 'right').map(entry => entry.id)),
			pendingActionId: this.pendingActionId
		});
	}

	private restoreVisibility(): void {
		const value = this.storage.get(HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);
		if (!value) { this.hidden.clear(); return; }
		try { this.hidden = new Set(JSON.parse(value)); } catch { this.hidden.clear(); }
	}

	private reloadVisibility(): void {
		const previous = this.hidden;
		this.restoreVisibility();
		const changed = new Set([...previous, ...this.hidden]);
		for (const id of changed) {
			if (previous.has(id) !== this.hidden.has(id)) { this.visibilityChanged.fire({ id, visible: !this.hidden.has(id) }); }
		}
		this.publish();
	}

	private saveVisibility(): void {
		if (this.hidden.size) {
			this.storage.store(HIDDEN_ENTRIES_KEY, JSON.stringify([...this.hidden]), StorageScope.PROFILE, StorageTarget.USER);
		} else {
			this.storage.remove(HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);
		}
	}
}

function orderRegistrations(registrations: Registration[]): Registration[] {
	const allIds = new Set(registrations.map(entry => entry.sourceId));
	const insertion = new Map(registrations.map((entry, index) => [entry, index]));
	const roots = registrations.filter(entry => typeof entry.priority.primary === 'number' || !allIds.has(entry.priority.primary.location.id));
	roots.sort((a, b) => {
		if (a.alignment !== b.alignment) { return a.alignment === StatusbarAlignment.LEFT ? -1 : 1; }
		const ap = typeof a.priority.primary === 'number' ? a.priority.primary : a.priority.primary.location.priority;
		const bp = typeof b.priority.primary === 'number' ? b.priority.primary : b.priority.primary.location.priority;
		return bp - ap || b.priority.secondary - a.priority.secondary || insertion.get(a)! - insertion.get(b)!;
	});
	const remaining = new Set(registrations.filter(entry => !roots.includes(entry)));
	const result: Registration[] = [];
	const append = (entry: Registration) => {
		const relatives = [...remaining].filter(candidate => isStatusbarEntryLocation(candidate.priority.primary) &&
			candidate.priority.primary.location.id === entry.sourceId);
		for (const relative of relatives.filter(candidate => (candidate.priority.primary as IStatusbarEntryLocation).alignment === StatusbarAlignment.LEFT)
			.sort((a, b) => b.priority.secondary - a.priority.secondary)) { remaining.delete(relative); append(relative); }
		result.push(entry);
		for (const relative of relatives.filter(candidate => (candidate.priority.primary as IStatusbarEntryLocation).alignment === StatusbarAlignment.RIGHT)
			.sort((a, b) => b.priority.secondary - a.priority.secondary)) { remaining.delete(relative); append(relative); }
	};
	for (const root of roots) { append(root); }
	result.push(...[...remaining].sort((a, b) => b.priority.secondary - a.priority.secondary));
	return result;
}

function compactWith(priority: IStatusbarEntryPriority): string | undefined {
	return isStatusbarEntryLocation(priority.primary) && priority.primary.compact ? priority.primary.location.id : undefined;
}

function colorId(value: IStatusbarEntry['color']): string | undefined {
	return typeof value === 'string' ? value : value?.id;
}

function tooltipText(tooltip: IStatusbarEntry['tooltip']): string | undefined {
	const content: TooltipContent | undefined = isTooltipWithCommands(tooltip) ? tooltip.content : tooltip;
	if (typeof content === 'string') { return stripIcons(content); }
	if (isMarkdownString(content)) { return stripIcons(content.value); }
	return undefined;
}
