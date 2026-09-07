/*---------------------------------------------------------------------------------------------
 * Immutable editor state at a frontend boundary.
 *
 * The shared editor controller owns the model, view model, keybindings, Vim and composition.
 * Frontends receive frozen scalar render records and return generation/document-addressed input.
 * Neither side of this protocol carries a model, service, native object or callback.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { nextCharLength } from '../vs/base/common/strings.js';
import type { IEditorFindSnapshot } from './editorFind.js';
import type { INormalizedKey } from '../input/key.js';

export interface ITextProjectionRange {
	readonly location: number;
	readonly length: number;
}

export interface ITextProjectionPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export interface ITextProjectionSelection {
	readonly anchor: ITextProjectionPosition;
	readonly active: ITextProjectionPosition;
	readonly offsets: ITextProjectionRange;
	readonly primary: boolean;
}

/** Plain Vim command-line state; callbacks and adapter objects never cross the frontend boundary. */
export interface IVimProjectionStatus {
	readonly pending: string;
	readonly prompt: Readonly<{ readonly prefix: string; readonly value: string }> | undefined;
	readonly message: string | undefined;
}

/** CSS colours and booleans only; a `Color`, attributed string, font or native run is forbidden. */
export interface ITextProjectionStyle {
	readonly foreground?: string;
	readonly background?: string;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly strikethrough?: boolean;
}

export interface ITextProjectionRun {
	readonly start: number;
	readonly length: number;
	readonly text: string;
	readonly style: Readonly<ITextProjectionStyle>;
}

/**
 * A compact monotone map between a rendered row and the document. Linear and wrapped spans map
 * equal UTF-16 distances. Replacement/injected spans state their edge affinity explicitly because
 * one side can have zero width. Frontends never synthesize a model position from line numbers.
 */
export interface ITextProjectionMappingSpan {
	readonly viewStart: number;
	readonly viewEnd: number;
	readonly documentStart: number;
	readonly documentEnd: number;
	readonly kind: 'linear' | 'wrapped-continuation' | 'folded-replacement' | 'injected' | 'composition';
	readonly affinity: 'start' | 'end' | 'both';
}

export interface ITextProjectionRow {
	readonly id: string;
	readonly viewLineNumber: number;
	readonly modelLineNumber: number;
	readonly lineNumber: number | undefined;
	readonly fold: 'none' | 'expanded' | 'collapsed';
	readonly content: string;
	readonly runs: readonly Readonly<ITextProjectionRun>[];
	readonly mapping: readonly Readonly<ITextProjectionMappingSpan>[];
	readonly carets: readonly { readonly column: number; readonly primary: boolean }[];
	readonly selections: readonly { readonly start: number; readonly end: number; readonly toEndOfLine: boolean }[];
	readonly searchMatches: readonly { readonly start: number; readonly end: number }[];
}

export interface ITextEditorProjectionSnapshot {
	readonly kind: 'text';
	readonly generation: number;
	/** Stable for the lifetime of the resource, unlike generation. */
	readonly documentId: string;
	readonly resource: string;
	readonly version: number;
	readonly languageId: string;
	readonly readonly: boolean;
	readonly dirty: boolean;
	readonly focused: boolean;
	readonly mode: 'viewer' | 'normal' | 'insert' | 'replace' | 'visual' | 'visual-line' | 'visual-block';
	readonly vim: Readonly<IVimProjectionStatus> | undefined;
	readonly selections: readonly Readonly<ITextProjectionSelection>[];
	readonly primaryCursor: Readonly<ITextProjectionPosition>;
	readonly primaryCursorView: Readonly<ITextProjectionPosition>;
	readonly markedRange: Readonly<ITextProjectionRange> | undefined;
	readonly find: Readonly<IEditorFindSnapshot>;
	readonly rows: readonly Readonly<ITextProjectionRow>[];
	readonly geometry: Readonly<{
		/** Identifies the frontend's width metric contract; a frontend must relayout when it changes. */
		readonly metricsId: string;
		readonly width: number;
		readonly wrap: boolean;
		readonly firstVisibleRow: number;
		readonly visibleRowCount: number;
		readonly scrollColumn: number;
		readonly totalRows: number;
		readonly modelLineCount: number;
	}>;
}

export interface IDiffProjectionDocument {
	readonly documentId: string;
	readonly resource: string;
	readonly version: number;
	readonly languageId: string;
}

export interface IDiffProjectionRow extends ITextProjectionRow {
	readonly sourceDocumentId: string;
	readonly side: 'original' | 'modified' | 'unchanged';
	readonly marker: '-' | '+' | ' ';
	readonly decorations: readonly Readonly<{ readonly start: number; readonly end: number; readonly kind: 'line' | 'inner-change' }>[];
}

export interface IDiffEditorProjectionSnapshot {
	readonly kind: 'diff';
	readonly generation: number;
	readonly documentId: string;
	readonly original: Readonly<IDiffProjectionDocument>;
	readonly modified: Readonly<IDiffProjectionDocument>;
	readonly focused: boolean;
	readonly rows: readonly Readonly<IDiffProjectionRow>[];
	readonly geometry: ITextEditorProjectionSnapshot['geometry'];
}

export type TextProjectionSnapshot = ITextEditorProjectionSnapshot | IDiffEditorProjectionSnapshot;

export type ITextProjectionKey = INormalizedKey;

interface ITextInputAddress { readonly generation: number; readonly documentId: string }

export type TextEditorInputEvent = ITextInputAddress & (
	| { readonly kind: 'key'; readonly key: Readonly<ITextProjectionKey> }
	| { readonly kind: 'text'; readonly text: string; readonly replacement?: Readonly<ITextProjectionRange> }
	| { readonly kind: 'composition'; readonly phase: 'update'; readonly text: string; readonly selected: Readonly<ITextProjectionRange>; readonly replacement?: Readonly<ITextProjectionRange> }
	| { readonly kind: 'composition'; readonly phase: 'commit'; readonly text?: string }
	| { readonly kind: 'composition'; readonly phase: 'cancel' }
	| { readonly kind: 'move'; readonly action: 'left' | 'right' | 'up' | 'down' | 'line-start' | 'line-end'; readonly extend: boolean }
	| { readonly kind: 'command'; readonly action: 'newline' | 'delete-left' | 'delete-right' | 'left' | 'right' | 'up' | 'down' | 'select-left' | 'select-right' | 'select-up' | 'select-down' | 'line-start' | 'line-end' | 'select-line-start' | 'select-line-end' }
	| { readonly kind: 'select-all' }
	| { readonly kind: 'select'; readonly anchor: Readonly<ITextProjectionPosition>; readonly active: Readonly<ITextProjectionPosition>; readonly source: 'mouse' | 'navigation' | 'programmatic' }
	| { readonly kind: 'pointer'; readonly action: 'place-caret' | 'toggle-fold'; readonly rowId: string; readonly column: number; readonly extend: boolean }
	| { readonly kind: 'undo' | 'redo' | 'save' | 'toggle-vim' | 'toggle-wrap' }
	| { readonly kind: 'find'; readonly action: 'open' | 'query' | 'next' | 'previous' | 'close'; readonly query?: string }
	| { readonly kind: 'focus'; readonly focused: boolean }
	| { readonly kind: 'viewport'; readonly width: number; readonly wrap: boolean; readonly firstVisibleRow: number; readonly visibleRowCount: number; readonly scrollColumn: number }
);

export interface ITextEditorProjectionSource {
	readonly snapshot: ITextEditorProjectionSnapshot;
	readonly onDidSnapshot: Event<ITextEditorProjectionSnapshot>;
	readonly onDidInput: Event<TextEditorInputEvent>;
	dispatch(event: TextEditorInputEvent): boolean;
}

export interface IDiffEditorProjectionSource {
	readonly snapshot: IDiffEditorProjectionSnapshot;
	readonly onDidSnapshot: Event<IDiffEditorProjectionSnapshot>;
	readonly onDidInput: Event<TextEditorInputEvent>;
	dispatch(event: TextEditorInputEvent): boolean;
}

export type TextEditorInputHandler = (event: TextEditorInputEvent) => void | Promise<void>;

function freezePosition(position: ITextProjectionPosition): Readonly<ITextProjectionPosition> {
	return Object.freeze({ ...position });
}

function freezeRange(range: ITextProjectionRange): Readonly<ITextProjectionRange> {
	return Object.freeze({ ...range });
}

function assertPlain(value: unknown, path = 'snapshot', seen = new Set<unknown>()): void {
	if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return; }
	if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') { throw new Error(`${path} is not plain data`); }
	if (typeof value !== 'object') { throw new Error(`${path} is not plain data`); }
	if (seen.has(value)) { throw new Error(`${path} is cyclic`); }
	seen.add(value);
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) { throw new Error(`${path} has a live object prototype`); }
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) { assertPlain(child, `${path}.${key}`, seen); }
	seen.delete(value);
}

/** Validate and freeze a producer record without retaining any previous generation. */
export function textEditorSnapshot(value: ITextEditorProjectionSnapshot): ITextEditorProjectionSnapshot {
	// Validate the caller's values before spreading them: spreading a live model-shaped object would
	// erase its prototype and make a boundary violation look like a valid record.
	assertPlain(value);
	if (!Number.isSafeInteger(value.generation) || value.generation < 1) { throw new Error('invalid editor generation'); }
	if (!value.documentId || !value.resource) { throw new Error('editor snapshot needs stable document and resource identities'); }
	const rowIds = new Set<string>();
	const rows = value.rows.map(row => {
		if (rowIds.has(row.id)) { throw new Error(`duplicate editor row identity ${row.id}`); }
		rowIds.add(row.id);
		let offset = 0;
		const runs = row.runs.map(run => {
			if (run.start !== offset || run.length !== run.text.length) { throw new Error(`non-contiguous editor run in ${row.id}`); }
			offset += run.length;
			return Object.freeze({ ...run, style: Object.freeze({ ...run.style }) });
		});
		if (offset !== row.content.length || runs.map(run => run.text).join('') !== row.content) { throw new Error(`editor runs do not project ${row.id}`); }
		let viewEnd = 0;
		let documentEnd = -1;
		const graphemeBoundaries = new Set<number>([0]);
		for (let at = 0; at < row.content.length;) { at += nextCharLength(row.content, at); graphemeBoundaries.add(at); }
		const mapping = row.mapping.map(span => {
			if (span.viewStart !== viewEnd || span.viewEnd < span.viewStart) { throw new Error(`non-contiguous editor mapping in ${row.id}`); }
			if (span.documentStart < documentEnd || span.documentEnd < span.documentStart) { throw new Error(`non-monotone editor mapping in ${row.id}`); }
			if ((span.kind === 'linear' || span.kind === 'wrapped-continuation' || span.kind === 'composition')
				&& span.viewEnd - span.viewStart !== span.documentEnd - span.documentStart) {
				throw new Error(`non-linear editor mapping labeled ${span.kind} in ${row.id}`);
			}
			if (!graphemeBoundaries.has(span.viewStart) || !graphemeBoundaries.has(span.viewEnd)) { throw new Error(`editor mapping splits grapheme in ${row.id}`); }
			viewEnd = span.viewEnd;
			documentEnd = span.documentEnd;
			return Object.freeze({ ...span });
		});
		if (!mapping.length || viewEnd !== row.content.length) { throw new Error(`editor mapping does not cover ${row.id}`); }
		return Object.freeze({
			...row,
			runs: Object.freeze(runs),
			mapping: Object.freeze(mapping),
			carets: Object.freeze(row.carets.map(caret => Object.freeze({ ...caret }))),
			selections: Object.freeze(row.selections.map(selection => Object.freeze({ ...selection }))),
			searchMatches: Object.freeze(row.searchMatches.map(match => Object.freeze({ ...match })))
		});
	});
	const snapshot: ITextEditorProjectionSnapshot = Object.freeze({
		...value,
		find: Object.freeze({ ...value.find }),
		vim: value.vim && Object.freeze({ ...value.vim, prompt: value.vim.prompt && Object.freeze({ ...value.vim.prompt }) }),
		markedRange: value.markedRange && freezeRange(value.markedRange),
		primaryCursor: freezePosition(value.primaryCursor),
		primaryCursorView: freezePosition(value.primaryCursorView),
		selections: Object.freeze(value.selections.map(selection => Object.freeze({ ...selection,
			anchor: freezePosition(selection.anchor), active: freezePosition(selection.active), offsets: freezeRange(selection.offsets) }))),
		rows: Object.freeze(rows), geometry: Object.freeze({ ...value.geometry })
	});
	assertPlain(snapshot);
	return snapshot;
}

export function diffEditorSnapshot(value: IDiffEditorProjectionSnapshot): IDiffEditorProjectionSnapshot {
	assertPlain(value);
	if (value.kind !== 'diff' || value.original.documentId === value.modified.documentId) { throw new Error('invalid diff document identities'); }
	const ids = new Set<string>();
	let order = -1;
	const rows = value.rows.map(row => {
		if (ids.has(row.id) || row.viewLineNumber <= order) { throw new Error(`invalid diff row identity/order ${row.id}`); }
		if (row.sourceDocumentId !== value.original.documentId && row.sourceDocumentId !== value.modified.documentId) { throw new Error(`orphan diff row ${row.id}`); }
		ids.add(row.id); order = row.viewLineNumber;
		return Object.freeze({ ...row, runs: Object.freeze(row.runs.map(run => Object.freeze({ ...run, style: Object.freeze({ ...run.style }) }))),
			mapping: Object.freeze(row.mapping.map(span => Object.freeze({ ...span }))), carets: Object.freeze([]), selections: Object.freeze([]), searchMatches: Object.freeze([]),
			decorations: Object.freeze(row.decorations.map(decoration => Object.freeze({ ...decoration }))) });
	});
	return Object.freeze({ ...value, original: Object.freeze({ ...value.original }), modified: Object.freeze({ ...value.modified }),
		rows: Object.freeze(rows), geometry: Object.freeze({ ...value.geometry }) });
}

export class DiffEditorProjectionGateway extends Disposable implements IDiffEditorProjectionSource {
	private current: IDiffEditorProjectionSnapshot;
	private readonly _onDidSnapshot = this._register(new Emitter<IDiffEditorProjectionSnapshot>());
	readonly onDidSnapshot = this._onDidSnapshot.event;
	private readonly _onDidInput = this._register(new Emitter<TextEditorInputEvent>());
	readonly onDidInput = this._onDidInput.event;
	constructor(initial: IDiffEditorProjectionSnapshot, private readonly handle: TextEditorInputHandler) { super(); this.current = diffEditorSnapshot(initial); }
	get snapshot() { return this.current; }
	publish(value: IDiffEditorProjectionSnapshot): boolean {
		const next = diffEditorSnapshot(value);
		if (next.documentId !== this.current.documentId || next.generation <= this.current.generation) { return false; }
		this.current = next; this._onDidSnapshot.fire(next); return true;
	}
	dispatch(event: TextEditorInputEvent): boolean {
		if (event.generation !== this.current.generation || event.documentId !== this.current.documentId) { return false; }
		this._onDidInput.fire(event); void this.handle(event); return true;
	}
}

/**
 * The sole publication/input boundary. It retains one snapshot, no trace/history, and rejects
 * input from a replaced native or terminal generation before shared behavior sees it.
 */
export class TextEditorProjectionGateway extends Disposable implements ITextEditorProjectionSource {
	private current: ITextEditorProjectionSnapshot;
	private readonly _onDidSnapshot = this._register(new Emitter<ITextEditorProjectionSnapshot>());
	readonly onDidSnapshot = this._onDidSnapshot.event;
	private readonly _onDidInput = this._register(new Emitter<TextEditorInputEvent>());
	readonly onDidInput = this._onDidInput.event;

	constructor(initial: ITextEditorProjectionSnapshot, private readonly handle: TextEditorInputHandler) {
		super();
		this.current = textEditorSnapshot(initial);
	}

	get snapshot(): ITextEditorProjectionSnapshot { return this.current; }

	publish(snapshot: ITextEditorProjectionSnapshot): boolean {
		const next = textEditorSnapshot(snapshot);
		if (next.documentId !== this.current.documentId || next.generation <= this.current.generation) { return false; }
		this.current = next;
		this._onDidSnapshot.fire(next);
		return true;
	}

	dispatch(event: TextEditorInputEvent): boolean {
		if (event.generation !== this.current.generation || event.documentId !== this.current.documentId) { return false; }
		if (event.kind === 'pointer' && !this.current.rows.some(row => row.id === event.rowId)) { return false; }
		const frozen = Object.freeze({ ...event }) as TextEditorInputEvent;
		assertPlain(frozen, 'input');
		this._onDidInput.fire(frozen);
		void this.handle(frozen);
		return true;
	}
}
