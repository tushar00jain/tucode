/*---------------------------------------------------------------------------------------------
 * Immutable terminal-editor state and normalized input.
 *--------------------------------------------------------------------------------------------*/
import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import type { IWorkbenchKeyTarget } from '../input/workbenchKeyDispatch.js';
import type { INormalizedKey as IKey } from '../input/key.js';

const TERMINAL_NAMED_SEQUENCES: Readonly<Record<string, string>> = Object.freeze({
	up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
	home: '\x1b[H', end: '\x1b[F', pageUp: '\x1b[5~', pageDown: '\x1b[6~',
	enter: '\r', tab: '\t', shiftTab: '\x1b[Z', escape: '\x1b', backspace: '\x7f', delete: '\x1b[3~',
	f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~',
	f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~'
});

/** The normalized key-to-PTY encoding used by the terminal capability adapter. */
export function terminalInputSequence(key: IKey): string {
	// A decoded sequence may contain multiple codepoints; the PTY receives it intact.
	let sequence = TERMINAL_NAMED_SEQUENCES[key.name] ?? key.sequence ?? '';
	if (key.ctrl && key.name === 'char') {
		const value = (key.char ?? key.sequence ?? '').toUpperCase().codePointAt(0);
		if (value !== undefined && value >= 0x40 && value <= 0x5f) { sequence = String.fromCodePoint(value - 0x40); }
	}
	if (key.alt && sequence && !sequence.startsWith('\x1b')) { sequence = `\x1b${sequence}`; }
	return sequence;
}

export interface ITerminalWorkbenchKeyCapabilities {
	readonly activeTerminalId: () => string | undefined;
	readonly focused: () => boolean;
	readonly sendKeybindingsToShell: () => boolean;
	readonly shouldCommandSkipShell: (commandId: string) => boolean;
	readonly enqueue: (terminalId: string, sequence: string) => boolean;
}

/** Immutable terminal focus/policy capabilities interpreted at the shared input boundary. */
export class TerminalWorkbenchKeyTarget implements IWorkbenchKeyTarget {
	private readonly capabilities: Readonly<ITerminalWorkbenchKeyCapabilities>;
	constructor(capabilities: ITerminalWorkbenchKeyCapabilities) { this.capabilities = Object.freeze({ ...capabilities }); }
	takesKey(commandId: () => string | undefined, key?: IKey): boolean {
		if (!this.capabilities.activeTerminalId() || !this.capabilities.focused()) { return false; }
		// Meta belongs to the surrounding workbench rather than the shell.
		if (key?.meta) { return false; }
		if (this.capabilities.sendKeybindingsToShell()) { return true; }
		const id = commandId();
		return !id || !this.capabilities.shouldCommandSkipShell(id);
	}
	handleKey(key: IKey): boolean {
		const id = this.capabilities.activeTerminalId();
		const sequence = terminalInputSequence(key);
		return !!id && this.capabilities.focused() && !!sequence && this.capabilities.enqueue(id, sequence);
	}
}

export interface ITerminalProjectionRun {
	readonly text: string;
	readonly cells: number;
	readonly foreground?: string;
	readonly background?: string;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
}
export interface ITerminalProjectionRow {
	readonly id: string;
	readonly wrapped: boolean;
	readonly runs: readonly Readonly<ITerminalProjectionRun>[];
}
export type TerminalCommandDecorationOutcome = 'default' | 'success' | 'error';
export interface ITerminalCommandDecoration {
	readonly id: number;
	readonly row: number;
	readonly outcome: TerminalCommandDecorationOutcome;
	readonly command: string;
}
export interface ITerminalFindDecoration {
	readonly id: number;
	readonly row: number;
	readonly column: number;
	readonly width: number;
	readonly active: boolean;
}
export interface ITerminalFindSnapshot {
	readonly visible: boolean;
	readonly query: string;
	/** Zero-based index from xterm's SearchAddon, or -1 when there is no active result. */
	readonly resultIndex: number;
	readonly resultCount: number;
	readonly decorations: readonly Readonly<ITerminalFindDecoration>[];
}

/** Projects upstream command markers into the current viewport without exposing xterm objects. */
export function projectTerminalCommandDecorations(
	commands: readonly Readonly<{ readonly marker: Readonly<{ readonly id: number; readonly line: number }>; readonly command: string; readonly exitCode?: number }>[],
	viewportY: number,
	rows: number
): readonly Readonly<ITerminalCommandDecoration>[] {
	return Object.freeze(commands.flatMap(command => {
		const row = command.marker.line - viewportY;
		if (row < 0 || row >= rows) { return []; }
		return [Object.freeze({ id: command.marker.id, row, command: command.command,
			outcome: command.exitCode === undefined ? 'default' : command.exitCode === 0 ? 'success' : 'error' } as const)];
	}));
}
export interface ITerminalEditorProjectionSnapshot {
	readonly kind: 'terminal'; readonly generation: number; readonly terminalId: string; readonly title: string;
	readonly columns: number; readonly rows: number; readonly focused: boolean; readonly exited: boolean;
	readonly alternateBufferActive: boolean;
	readonly exitCode: number | undefined; readonly cursor: Readonly<{ readonly column: number; readonly row: number }>;
	readonly content: readonly Readonly<ITerminalProjectionRow>[];
	readonly commandDecorations: readonly Readonly<ITerminalCommandDecoration>[];
	readonly find: Readonly<ITerminalFindSnapshot>;
	/** Logical viewport text and UTF-16 offsets over exactly the projected rows. */
	readonly logicalText: string;
	readonly cursorOffset: number;
	readonly selection: Readonly<{ readonly location: number; readonly length: number }>;
	readonly scrollTop: number;
	/** Actionable process state only; healthy attached terminals do not manufacture status chrome. */
	readonly status: string | undefined;
}
interface ITerminalAddress { readonly generation: number; readonly terminalId: string }
export type TerminalEditorInputEvent = ITerminalAddress & (
	| { readonly kind: 'key'; readonly sequence: string }
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'paste'; readonly text: string }
	| { readonly kind: 'viewport'; readonly columns: number; readonly rows: number }
	| { readonly kind: 'scroll'; readonly lines: number }
	| { readonly kind: 'scroll-page'; readonly pages: -1 | 1 }
	| { readonly kind: 'pointer'; readonly column: number; readonly row: number; readonly button: number; readonly pressed: boolean }
	| { readonly kind: 'focus'; readonly focused: boolean }
	| { readonly kind: 'find'; readonly action: 'open' | 'query' | 'next' | 'previous' | 'close'; readonly query?: string }
);
export interface ITerminalEditorProjectionSource {
	readonly snapshot: ITerminalEditorProjectionSnapshot;
	readonly onDidSnapshot: Event<ITerminalEditorProjectionSnapshot>;
	readonly onDidInput: Event<TerminalEditorInputEvent>;
	dispatch(event: TerminalEditorInputEvent): boolean;
}
export function terminalEditorSnapshot(value: ITerminalEditorProjectionSnapshot): ITerminalEditorProjectionSnapshot {
	if (!value.terminalId || value.generation < 1 || !Number.isSafeInteger(value.generation) || value.columns < 1 || value.rows < 1) { throw new Error('invalid terminal projection'); }
	const ids = new Set<string>();
	const content = value.content.map(row => {
		if (!row.id || ids.has(row.id)) { throw new Error(`invalid terminal row ${row.id}`); } ids.add(row.id);
		if (row.runs.some(run => !Number.isSafeInteger(run.cells) || run.cells < 0)) { throw new Error(`invalid terminal cells ${row.id}`); }
		return Object.freeze({ ...row, runs: Object.freeze(row.runs.map(run => Object.freeze({ ...run }))) });
	});
	const decorationIds = new Set<number>();
	const commandDecorations = value.commandDecorations.map(decoration => {
		if (!Number.isSafeInteger(decoration.id) || decorationIds.has(decoration.id) || !Number.isSafeInteger(decoration.row) ||
			decoration.row < 0 || decoration.row >= value.rows || !['default', 'success', 'error'].includes(decoration.outcome)) {
			throw new Error(`invalid terminal command decoration ${decoration.id}`);
		}
		decorationIds.add(decoration.id);
		return Object.freeze({ ...decoration });
	});
	const findDecorationIds = new Set<number>();
	const findDecorations = value.find.decorations.map(decoration => {
		if (!Number.isSafeInteger(decoration.id) || findDecorationIds.has(decoration.id) ||
			!Number.isSafeInteger(decoration.row) || decoration.row < 0 || decoration.row >= value.rows ||
			!Number.isSafeInteger(decoration.column) || decoration.column < 0 || decoration.column >= value.columns ||
			!Number.isSafeInteger(decoration.width) || decoration.width < 1) {
			throw new Error(`invalid terminal find decoration ${decoration.id}`);
		}
		findDecorationIds.add(decoration.id);
		return Object.freeze({ ...decoration });
	});
	if (!Number.isSafeInteger(value.find.resultCount) || value.find.resultCount < 0 ||
		!Number.isSafeInteger(value.find.resultIndex) || value.find.resultIndex < -1 ||
		(value.find.resultIndex >= value.find.resultCount && value.find.resultIndex !== -1) ||
		(!value.find.visible && (value.find.resultCount !== 0 || value.find.resultIndex !== -1 || findDecorations.length !== 0))) {
		throw new Error('invalid terminal find state');
	}
	if (value.cursorOffset < 0 || value.cursorOffset > value.logicalText.length || value.selection.location < 0 ||
		value.selection.length < 0 || value.selection.location + value.selection.length > value.logicalText.length || value.scrollTop < 0) {
		throw new Error('invalid terminal logical viewport');
	}
	return Object.freeze({ ...value, cursor: Object.freeze({ ...value.cursor }),
		selection: Object.freeze({ ...value.selection }), content: Object.freeze(content), commandDecorations: Object.freeze(commandDecorations),
		find: Object.freeze({ ...value.find, decorations: Object.freeze(findDecorations) }) });
}
export class TerminalEditorProjectionGateway extends Disposable implements ITerminalEditorProjectionSource {
	private current: ITerminalEditorProjectionSnapshot;
	private readonly changed = this._register(new Emitter<ITerminalEditorProjectionSnapshot>()); readonly onDidSnapshot = this.changed.event;
	private readonly input = this._register(new Emitter<TerminalEditorInputEvent>()); readonly onDidInput = this.input.event;
	constructor(initial: ITerminalEditorProjectionSnapshot, private readonly handle: (event: TerminalEditorInputEvent) => void | Promise<void>) { super(); this.current = terminalEditorSnapshot(initial); }
	get snapshot() { return this.current; }
	publish(value: ITerminalEditorProjectionSnapshot): boolean {
		const next = terminalEditorSnapshot(value); if (next.terminalId !== this.current.terminalId || next.generation <= this.current.generation) { return false; }
		this.current = next; this.changed.fire(next); return true;
	}
	dispatch(event: TerminalEditorInputEvent): boolean {
		if (event.terminalId !== this.current.terminalId || event.generation !== this.current.generation) { return false; }
		const frozen = Object.freeze({ ...event }); this.input.fire(frozen); void this.handle(frozen); return true;
	}
}

export interface ITerminalCollectionProjectionSnapshot {
	readonly kind: 'terminal-collection';
	readonly collectionId: string;
	readonly generation: number;
	readonly sessions: readonly Readonly<ITerminalEditorProjectionSnapshot>[];
	readonly groups: readonly Readonly<ITerminalGroupProjectionSnapshot>[];
	readonly activeTerminalId: string | undefined;
	readonly focusedTerminalId: string | undefined;
	readonly opening: boolean;
	readonly error: string | undefined;
	/** Actionable collection/process state only; undefined is the healthy steady state. */
	readonly status: string | undefined;
	readonly profiles: readonly Readonly<ITerminalCollectionProfile>[];
	readonly profilesLoading: boolean;
	readonly profileError: string | undefined;
}
export interface ITerminalGroupProjectionSnapshot {
	readonly groupId: string;
	readonly terminalIds: readonly string[];
	readonly activeTerminalId: string;
}
export interface ITerminalCollectionProfile { readonly id: string; readonly label: string }

interface ITerminalCollectionAddress { readonly collectionId: string; readonly generation: number }
export type TerminalCollectionInputEvent = ITerminalCollectionAddress & (
	| { readonly kind: 'create'; readonly profileId?: string }
	| { readonly kind: 'split' }
	| { readonly kind: 'select'; readonly terminalId: string }
	| { readonly kind: 'close'; readonly terminalId: string }
	| { readonly kind: 'step'; readonly delta: -1 | 1 }
	| { readonly kind: 'terminal'; readonly event: TerminalEditorInputEvent }
);

export function terminalCollectionSnapshot(value: ITerminalCollectionProjectionSnapshot): ITerminalCollectionProjectionSnapshot {
	if (!value.collectionId || !Number.isSafeInteger(value.generation) || value.generation < 1) { throw new Error('invalid terminal collection projection'); }
	const sessions = Object.freeze(value.sessions.map(terminalEditorSnapshot));
	const ids = new Set(sessions.map(session => session.terminalId));
	if (ids.size !== sessions.length || (value.activeTerminalId && !ids.has(value.activeTerminalId)) ||
		(value.focusedTerminalId && !ids.has(value.focusedTerminalId))) { throw new Error('invalid terminal collection membership'); }
	const groupedIds = new Set<string>();
	const groupIds = new Set<string>();
	const groups = Object.freeze(value.groups.map(group => {
		if (!group.groupId || groupIds.has(group.groupId) || group.terminalIds.length < 1 ||
			!group.terminalIds.includes(group.activeTerminalId)) { throw new Error(`invalid terminal group ${group.groupId}`); }
		groupIds.add(group.groupId);
		const terminalIds = Object.freeze([...group.terminalIds]);
		for (const id of terminalIds) {
			if (!ids.has(id) || groupedIds.has(id)) { throw new Error(`invalid terminal group member ${id}`); }
			groupedIds.add(id);
		}
		return Object.freeze({ ...group, terminalIds });
	}));
	if (groupedIds.size !== sessions.length) { throw new Error('terminal sessions must belong to exactly one group'); }
	const profileIds = new Set<string>();
	const profiles = Object.freeze(value.profiles.map(profile => {
		if (!profile.id || !profile.label || profileIds.has(profile.id)) { throw new Error(`invalid terminal profile ${profile.id}`); }
		profileIds.add(profile.id); return Object.freeze({ ...profile });
	}));
	return Object.freeze({ ...value, sessions, groups, profiles });
}

export interface ITerminalCollectionProjectionSource {
	readonly snapshot: ITerminalCollectionProjectionSnapshot;
	readonly onDidSnapshot: Event<ITerminalCollectionProjectionSnapshot>;
	readonly onDidInput: Event<TerminalCollectionInputEvent>;
	dispatch(event: TerminalCollectionInputEvent): boolean;
}

export class TerminalCollectionProjectionGateway extends Disposable implements ITerminalCollectionProjectionSource {
	private current: ITerminalCollectionProjectionSnapshot;
	private readonly changed = this._register(new Emitter<ITerminalCollectionProjectionSnapshot>()); readonly onDidSnapshot = this.changed.event;
	private readonly input = this._register(new Emitter<TerminalCollectionInputEvent>()); readonly onDidInput = this.input.event;
	constructor(initial: ITerminalCollectionProjectionSnapshot, private readonly handle: (event: TerminalCollectionInputEvent) => void | Promise<void>) {
		super(); this.current = terminalCollectionSnapshot(initial);
	}
	get snapshot(): ITerminalCollectionProjectionSnapshot { return this.current; }
	publish(value: ITerminalCollectionProjectionSnapshot): boolean {
		const next = terminalCollectionSnapshot(value);
		if (next.collectionId !== this.current.collectionId || next.generation <= this.current.generation) { return false; }
		this.current = next; this.changed.fire(next); return true;
	}
	dispatch(event: TerminalCollectionInputEvent): boolean {
		if (event.collectionId !== this.current.collectionId || event.generation !== this.current.generation) { return false; }
		if (event.kind === 'terminal' && !this.current.sessions.some(session =>
			session.terminalId === event.event.terminalId && session.generation === event.event.generation)) { return false; }
		const frozen = Object.freeze(event.kind === 'terminal' ? { ...event, event: Object.freeze({ ...event.event }) } : { ...event }) as TerminalCollectionInputEvent;
		this.input.fire(frozen); void this.handle(frozen); return true;
	}
}
