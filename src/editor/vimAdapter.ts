/*---------------------------------------------------------------------------------------------
 *  The vim engine's editor, over a `TextView`.
 *
 *  `src/vendor/codemirror-vim/vim.js` drives one interface — `CM5EditorInterface`, declared in
 *  `types.ts` beside it — and `initVim(TerminalCodeMirror)` binds the engine to this
 *  implementation of it. `packages/codemirror-vim/src/cm_adapter.ts` in the origin repo is the
 *  same class over CodeMirror 6 and is the model for this one; it is not copyable, because every
 *  one of its bodies is a `state.doc` / `dispatch` call.
 *
 *  **Three quarters of it is not written here**, which is the whole reason this was worth doing:
 *
 *  | | |
 *  | --- | --- |
 *  | the text | `ITextModel` — `getLineContent`, `getValueInRange`, `getOffsetAt`, `getPositionAt`, `validatePosition`, `findMatches`, `bracketPairs.matchBracket`, `deltaDecorations` for a mark that survives an edit |
 *  | the cursor and the edits | `ViewModel` — `getPosition`, `getSelections`, `setSelections`, `type`, `executeEdits`, the read-only guard, and the `registerViewModel` wiring that recovers a cursor from an edit made elsewhere |
 *  | the motions | `MoveOperations` over the *view* lines, which is what `findPosV` is: `gj` moves a display line, and a display line in this fork is a wrapped row |
 *  | pixel geometry | nothing. One character is one cell, so `charCoords` and `coordsChar` are the identity and `defaultTextHeight` is 1 |
 *
 *  What is genuinely new is the bookkeeping the engine needs and no editor has: the operation
 *  (`curOp`), the line handles, the overlay, and `StringStream` — see `stringStream.ts`.
 *
 *  Upstream counterpart: none — the vim engine is not tscode's, so no tscode file stands where
 *  this one does. Its model is `packages/codemirror-vim/src/cm_adapter.ts` in the vendored
 *  engine's origin repository, recorded in `src/vendor/codemirror-vim/README.md`.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../vs/editor/common/core/position.js';
import { Range } from '../vs/editor/common/core/range.js';
import { Selection } from '../vs/editor/common/core/selection.js';
import { DeleteOperations } from '../vs/editor/common/cursor/cursorDeleteOperations.js';
import { MoveOperations } from '../vs/editor/common/cursor/cursorMoveOperations.js';
import { EndOfLinePreference, IModelDeltaDecoration, ITextModel, TrackedRangeStickiness } from '../vs/editor/common/model.js';
import { EditorOption } from '../vs/editor/common/config/editorOptions.js';
import { EditSources } from '../vs/editor/common/textModelEditSource.js';
import type { CM5EditorInterface, CM5RangeInterface, LineHandle, Marker, Pos as IPos, vimState } from '../vendor/codemirror-vim/types.js';
import { StringStream } from '../vs/workbench/contrib/vim/tauri/stringStream.js';
import { startsUndoElement } from '../vs/workbench/contrib/vim/tauri/vimEditorPolicy.js';
import { TextView } from './textView.js';

/** A vim position: zero-based line, zero-based character. `Position` is one-based in both. */
export class Pos implements IPos {
	sticky?: string;

	constructor(public line: number, public ch: number) { }
}

/** What `on`/`off`/`signal` keep their listeners in, for anything that is not a DOM node. */
interface IEmitterLike {
	_handlers?: Record<string, Function[]>;
}

/**
 * The engine's own event helpers, copied from `cm_adapter.ts`'s bodies with the
 * `addEventListener` arm deleted — nothing in this frontend is a DOM node, so the `_handlers`
 * arm is the only one that was ever taken.
 */
export function on(emitter: IEmitterLike, type: string, f: Function): void {
	const map = emitter._handlers || (emitter._handlers = {});
	map[type] = (map[type] || []).concat(f);
}

export function off(emitter: IEmitterLike, type: string, f: Function): void {
	const handlers = emitter._handlers?.[type];
	if (handlers) {
		emitter._handlers![type] = handlers.filter(handler => handler !== f);
	}
}

export function signal(emitter: IEmitterLike, type: string, ...args: unknown[]): void {
	for (const handler of emitter._handlers?.[type]?.slice() ?? []) {
		handler(...args);
	}
}

function signalTo(handlers: Function[] | undefined, ...args: unknown[]): void {
	for (const handler of handlers?.slice() ?? []) {
		handler(...args);
	}
}

/** One vim command's worth of accumulated change and cursor activity. */
interface IOperation {
	$d: number;
	isVimOp?: boolean;
	cursorActivityHandlers?: Function[];
	cursorActivity?: boolean;
	lastChange?: { text: string[]; next?: unknown };
	change?: { text: string[]; next?: unknown };
	changeHandlers?: Function[];
	$changeStart?: number;
}

/** `{ line, ch }` as a model offset, clipped to the document exactly as `clipPos` clips. */
function offsetOf(model: ITextModel, pos: IPos): number {
	return model.getOffsetAt(clip(model, pos));
}

function clip(model: ITextModel, pos: IPos): Position {
	return model.validatePosition(new Position(pos.line + 1, (pos.ch ?? 0) + 1));
}

function posOf(position: Position): Pos {
	return new Pos(position.lineNumber - 1, position.column - 1);
}

/** The `Marker` contract, over a model decoration — so a mark moves with the text around it. */
class DecorationMarker implements Marker {

	readonly id: number;
	readonly assoc: number;

	/** The model's decoration id, which is where the position actually lives. */
	private readonly decoration: string;

	constructor(readonly cm: VimAdapter, private readonly model: ITextModel, position: Position, insertLeft: boolean) {
		const decoration: IModelDeltaDecoration = {
			range: Range.fromPositions(position, position),
			options: {
				description: 'vim-mark',
				stickiness: insertLeft
					? TrackedRangeStickiness.GrowsOnlyWhenTypingAfter
					: TrackedRangeStickiness.GrowsOnlyWhenTypingBefore
			}
		};

		this.decoration = model.deltaDecorations([], [decoration])[0];
		this.assoc = insertLeft ? 1 : -1;
		this.id = cm.$mid++;
		cm.marks[this.id] = this;
	}

	/** Where the model says the mark is now. Null once its line has been deleted. */
	get offset(): number | null {
		const range = this.model.isDisposed() ? null : this.model.getDecorationRange(this.decoration);

		return range ? this.model.getOffsetAt(range.getStartPosition()) : null;
	}

	find(): Pos | null {
		const range = this.model.isDisposed() ? null : this.model.getDecorationRange(this.decoration);

		return range ? posOf(range.getStartPosition()) : null;
	}

	/** Nothing to do: a model decoration is moved by the model, which is why it is one. */
	update(): void { }

	clear(): void {
		delete this.cm.marks[this.id];

		if (!this.model.isDisposed()) {
			this.model.deltaDecorations([this.decoration], []);
		}
	}
}

/**
 * The bracket scan `[(`, `])` and `%` are written against — `cm_adapter.ts`'s body, whose only
 * editor calls are `getLine`, `firstLine` and `lastLine`.
 *
 * `findMatchingBracket` below is `ITextModel.bracketPairs.matchBracket` instead, because that one
 * is language-aware where this is a character scan.
 */
/** What the two copied helpers below actually read off an editor, which is all they may read. */
interface ILineReader {
	getLine(row: number): string;
	firstLine(): number;
	lastLine(): number;
}

interface IWrappable extends ILineReader {
	getOption(name: 'textwidth'): number | undefined;
	replaceRange(text: string, s: IPos, e?: IPos): void;
}

const MATCHING: Record<string, string> = { '(': ')>', ')': '(<', '[': ']>', ']': '[<', '{': '}>', '}': '{<', '<': '>>', '>': '<<' };

function scanForBracket(cm: ILineReader, where: IPos, dir: 1 | -1, config: { bracketRegex?: RegExp; maxScanLineLength?: number; maxScanLines?: number } | undefined) {
	const maxScanLen = config?.maxScanLineLength || 10_000;
	const maxScanLines = config?.maxScanLines || 1_000;
	const re = config?.bracketRegex || /[(){}[\]]/;
	const stack: string[] = [];
	const lineEnd = dir > 0
		? Math.min(where.line + maxScanLines, cm.lastLine() + 1)
		: Math.max(cm.firstLine() - 1, where.line - maxScanLines);

	let lineNo = where.line;
	for (; lineNo !== lineEnd; lineNo += dir) {
		const line = cm.getLine(lineNo);
		if (!line || line.length > maxScanLen) {
			continue;
		}

		let pos = dir > 0 ? 0 : line.length - 1;
		const end = dir > 0 ? line.length : -1;
		if (lineNo === where.line) {
			pos = where.ch - (dir < 0 ? 1 : 0);
		}

		for (; pos !== end; pos += dir) {
			const ch = line.charAt(pos);
			if (re.test(ch)) {
				const match = MATCHING[ch];
				if (match && (match.charAt(1) === '>') === (dir > 0)) {
					stack.push(ch);
				} else if (!stack.length) {
					return { pos: new Pos(lineNo, pos), ch };
				} else {
					stack.pop();
				}
			}
		}
	}

	return lineNo - dir === (dir > 0 ? cm.lastLine() : cm.firstLine()) ? false : null;
}

/**
 * `gq`'s reflow — `cm_adapter.ts`'s body, whose only editor calls are `getLine`, `replaceRange`
 * and `getOption('textwidth')`.
 */
function hardWrap(cm: IWrappable, options: { from: number; to: number; column?: number; allowMerge?: boolean }): number {
	const max = options.column || cm.getOption('textwidth') || 80;
	const allowMerge = options.allowMerge !== false;

	let row = Math.min(options.from, options.to);
	let endRow = Math.max(options.from, options.to);

	while (row <= endRow) {
		const line = cm.getLine(row);

		if (line.length > max) {
			const space = findSpace(line, max, 5);
			if (space) {
				const indentation = /^\s*/.exec(line)?.[0];
				cm.replaceRange('\n' + indentation, new Pos(row, space.start), new Pos(row, space.end));
			}
			endRow++;
		} else if (allowMerge && /\S/.test(line) && row !== endRow) {
			const nextLine = cm.getLine(row + 1);
			if (nextLine && /\S/.test(nextLine)) {
				const trimmedLine = line.replace(/\s+$/, '');
				const trimmedNextLine = nextLine.replace(/^\s+/, '');
				const mergedLine = trimmedLine + ' ' + trimmedNextLine;
				const space = findSpace(mergedLine, max, 5);

				if (space && space.start > trimmedLine.length || mergedLine.length < max) {
					cm.replaceRange(' ', new Pos(row, trimmedLine.length), new Pos(row + 1, nextLine.length - trimmedNextLine.length));
					row--;
					endRow--;
				} else if (trimmedLine.length < line.length) {
					cm.replaceRange('', new Pos(row, trimmedLine.length), new Pos(row, line.length));
				}
			}
		}
		row++;
	}

	return row;
}

function findSpace(line: string, max: number, min: number): { start: number; end: number } | undefined {
	if (line.length < max) {
		return undefined;
	}

	const before = line.slice(0, max);
	const after = line.slice(max);
	const spaceAfter = /^(?:(\s+)|(\S+)(\s+))/.exec(after);
	const spaceBefore = /(?:(\s+)|(\s+)(\S+))$/.exec(before);
	let start = 0;
	let end = 0;

	if (spaceBefore && !spaceBefore[2]) {
		start = max - spaceBefore[1].length;
		end = max;
	}
	if (spaceAfter && !spaceAfter[2]) {
		if (!start) {
			start = max;
		}
		end = max + spaceAfter[1].length;
	}
	if (start) {
		return { start, end };
	}
	if (spaceBefore && spaceBefore[2] && spaceBefore.index > min) {
		return { start: spaceBefore.index, end: spaceBefore.index + spaceBefore[2].length };
	}
	if (spaceAfter && spaceAfter[2]) {
		start = max + spaceAfter[2].length;

		return { start, end: start + spaceAfter[3].length };
	}

	return undefined;
}

/** What `openDialog` and `openNotification` hand back to a terminal that has neither yet. */
export interface IVimPrompt {
	/** `:`, `/` or `?` — what the engine put in front of the box. */
	readonly prefix: string;
	/** Called with the committed text, or with nothing when the box is cancelled. */
	readonly commit: (value?: string) => void;
	readonly close: (value?: string) => void;
	readonly value: string;
}

/**
 * `CM5EditorInterface` over a `TextView`.
 *
 * Positions cross this boundary in three coordinate systems and confusing two of them is the
 * defect this note exists to prevent: **vim's are zero-based**, **the model's are one-based**,
 * and **the view's are one-based over wrapped rows**. Everything the engine passes or is handed
 * is a model position — `j` moves a *model* line in vim, as it does in vim — and the view
 * appears in exactly one member, `findPosV`, which is what `gj` and `<C-d>` are written against.
 */
export class VimAdapter implements CM5EditorInterface {

	state: CM5EditorInterface['state'] = {};
	marks: Record<string, Marker> = Object.create(null);
	$mid = 0;
	curOp: IOperation | null | undefined;
	options: Record<string, unknown> = {};
	_handlers: Record<string, Function[]> = {};

	/** The engine's `getInputField()`: nothing, but something `on`/`off` can hold listeners on. */
	readonly cm6: IEmitterLike = {};

	$lastChangeEndOffset = 0;
	$lineHandleChanges: unknown[] | undefined;

	virtualSelection: Selection[] | null = null;

	/** The search overlay's query, which the pane paints as `renderRow`'s `highlights`. */
	overlay: RegExp | undefined;

	/** Where a prompt goes while there is no floating box for it. Set by the pane. */
	prompt: ((prompt: IVimPrompt) => void) | undefined;

	/** `:w` — set by the pane, because saving is a workbench act and not an editor one. */
	save: (() => void) | undefined;

	/** `:q` — likewise: what closing means belongs to whatever opened the buffer. */
	quit: (() => void) | undefined;

	constructor(readonly view: TextView) {
		this.onChange = this.onChange.bind(this);
		this.onSelectionChange = this.onSelectionChange.bind(this);
	}

	private get model(): ITextModel {
		return this.view.model;
	}

	private get viewModel() {
		return this.view.viewModel;
	}

	// ------------------------------------------------------------------ events

	on(type: string, f: Function): void { on(this, type, f); }
	off(type: string, f: Function): void { off(this, type, f); }
	signal(type: string, e: unknown, handlers?: Function[]): void { signal(this, type, e, handlers); }

	// ------------------------------------------------------------------ the text

	getValue(): string {
		return this.model.getValue();
	}

	setValue(text: string): void {
		this.model.setValue(text);
		this.setCursor(new Pos(0, 0));
	}

	getLine(row: number): string {
		return row < 0 || row >= this.model.getLineCount() ? '' : this.model.getLineContent(row + 1);
	}

	lineCount(): number {
		return this.model.getLineCount();
	}

	firstLine(): number { return 0; }
	lastLine(): number { return this.model.getLineCount() - 1; }

	getRange(s: IPos, e: IPos): string {
		return this.model.getValueInRange(Range.fromPositions(clip(this.model, s), clip(this.model, e)), EndOfLinePreference.LF);
	}

	replaceRange(text: string, s: IPos, e?: IPos, _source?: string): void {
		this.edit([{ range: Range.fromPositions(clip(this.model, s), clip(this.model, e ?? s)), text }]);
	}

	indexFromPos(pos: IPos): number {
		return offsetOf(this.model, pos);
	}

	posFromIndex(offset: number): Pos {
		return posOf(this.model.getPositionAt(offset));
	}

	clipPos(p: IPos): Pos {
		return posOf(clip(this.model, p));
	}

	getLineHandle(row: number): LineHandle {
		this.$lineHandleChanges ||= [];

		return { row, index: this.indexFromPos(new Pos(row, 0)) };
	}

	/**
	 * Where the line a handle was taken of has ended up, or null if it is gone.
	 *
	 * `cm_adapter.ts` replays every change since the handle was made through `mapPos`. A model
	 * carries the same fact as a decoration, so the handle is one, and the null case is upstream's
	 * own: a decoration whose range no longer starts a line is a line that was joined away.
	 */
	getLineNumber(handle: LineHandle): number | null {
		if (!this.$lineHandleChanges) {
			return null;
		}

		const pos = this.posFromIndex(handle.index);

		return pos.ch === 0 ? pos.line : null;
	}

	releaseLineHandles(): void {
		this.$lineHandleChanges = undefined;
	}

	getLastEditEnd(): Pos {
		return this.posFromIndex(this.$lastChangeEndOffset);
	}

	// ------------------------------------------------------------------ the cursor

	getCursor(p?: 'head' | 'anchor' | 'start' | 'end'): Pos {
		const selection = this.viewModel.getSelection();
		const position = !p || p === 'head'
			? selection.getPosition()
			: p === 'anchor'
				? new Position(selection.selectionStartLineNumber, selection.selectionStartColumn)
				: p === 'start' ? selection.getStartPosition() : selection.getEndPosition();

		return posOf(position);
	}

	setCursor(line: IPos | number, ch?: number): void {
		const pos = typeof line === 'object' ? line : new Pos(line, ch ?? 0);
		const position = clip(this.model, pos);

		this.viewModel.setSelections('vim', [Selection.fromPositions(position, position)]);

		if (this.curOp && !this.curOp.isVimOp) {
			this.onBeforeEndOperation();
		}
	}

	listSelections(): { anchor: Pos; head: Pos }[] {
		return this.viewModel.getSelections().map(selection => ({
			anchor: posOf(new Position(selection.selectionStartLineNumber, selection.selectionStartColumn)),
			head: posOf(selection.getPosition())
		}));
	}

	setSelections(p: CM5RangeInterface[], primIndex?: number): void {
		if (!p.length) {
			return;
		}

		const selections = p.map(range => Selection.fromPositions(clip(this.model, range.anchor), clip(this.model, range.head)));

		// The primary selection is the first one for a `CursorCollection`, so a non-zero
		// `primIndex` is expressed by rotating rather than by an index nothing here carries.
		const index = primIndex ?? 0;

		this.viewModel.setSelections('vim', [...selections.slice(index), ...selections.slice(0, index)]);
	}

	setSelection(anchor: IPos, head: IPos, options?: { origin?: string }): void {
		this.setSelections([{ anchor, head }], 0);

		if (options?.origin === '*mouse') {
			this.onBeforeEndOperation();
		}
	}

	getSelection(): string {
		return this.getSelections().join('\n');
	}

	getSelections(): string[] {
		return this.viewModel.getSelections().map(selection => this.model.getValueInRange(selection, EndOfLinePreference.LF));
	}

	somethingSelected(): boolean {
		return this.viewModel.getSelections().some(selection => !selection.isEmpty());
	}

	replaceSelection(text: string): void {
		this.replaceSelections(this.viewModel.getSelections().map(() => text));
	}

	replaceSelections(replacements: string[]): void {
		this.edit(this.viewModel.getSelections().map((selection, index) => ({ range: selection, text: replacements[index] || '' })));
	}

	/**
	 * `R`. **`InputMode` is a process-global singleton upstream**, so this cannot be scoped to one
	 * editor without diverging from it — and this fork has at most one editor in vim mode at a
	 * time, so overwrite is applied where the option computation reads it: on the way in to
	 * `overWriteSelection`, which is the only member replace mode reaches.
	 */
	toggleOverwrite(on: boolean): void {
		this.state.overwrite = on;
	}

	overWriteSelection(text: string): void {
		this.setSelections(this.viewModel.getSelections().map(selection => {
			if (!selection.isEmpty()) {
				return { anchor: posOf(selection.getStartPosition()), head: posOf(selection.getEndPosition()) };
			}

			const position = selection.getPosition();
			const end = position.column < this.model.getLineMaxColumn(position.lineNumber)
				? position.delta(0, 1)
				: position;

			return { anchor: posOf(position), head: posOf(end) };
		}));

		// The editor's typing operation replaces the selection and advances to the inserted text's
		// end. A raw `executeEdits` replacement preserves the selection's start, which made every
		// replace-mode character overwrite the same cell instead of walking across the line.
		this.viewModel.type(text, 'keyboard');
	}

	isInMultiSelectMode(): boolean {
		return this.viewModel.getSelections().length > 1;
	}

	virtualSelectionMode(): boolean {
		return !!this.virtualSelection;
	}

	forEachSelection(command: Function): void {
		const selections = this.viewModel.getSelections();
		this.virtualSelection = [...selections];

		for (let i = 0; i < this.virtualSelection.length; i++) {
			this.viewModel.setSelections('vim', [this.virtualSelection[i]]);
			command();
			this.virtualSelection[i] = this.viewModel.getSelections()[0];
		}

		this.viewModel.setSelections('vim', this.virtualSelection);
		this.virtualSelection = null;
	}

	// ------------------------------------------------------------------ motion

	/**
	 * Insert mode's `<BS>`. `DeleteOperations.deleteLeft` is the editor's own — it is what joins a
	 * line to the one before it at column 1, and what takes a whole indent step back rather than
	 * one space when `useTabStops` says so.
	 */
	deleteLeft(): void {
		const [, commands] = DeleteOperations.deleteLeft(
			this.viewModel.getPrevEditOperationType(), this.viewModel.cursorConfig, this.model, this.viewModel.getSelections(), []);

		this.viewModel.executeCommands(commands.filter(command => !!command), 'vim');
	}

	moveH(increment: number, unit: string): void {
		if (unit === 'char') {
			const cursor = this.getCursor();
			this.setCursor(cursor.line, cursor.ch + increment);
		}
	}

	/**
	 * A *display* line or a page from `start`, which is what `gj`, `gk`, `<C-d>` and `<C-f>` mean.
	 *
	 * This is the one member that speaks view coordinates, and it has to: a display line in this
	 * fork is a wrapped row, and `MoveOperations.down`/`up` is the same code the editor moves a
	 * cursor with — it takes a configuration, an `ICursorSimpleModel` and a cursor state, and
	 * nothing else.
	 */
	findPosV(start: IPos, amount: number, unit: 'page' | 'line', goalColumn?: number): Pos & { hitSide?: boolean } {
		const converter = this.viewModel.coordinatesConverter;
		const from = converter.convertModelPositionToViewPosition(clip(this.model, start));
		const column = goalColumn === undefined ? from.column : goalColumn + 1;
		const count = unit === 'page' ? Math.abs(amount) * this.viewModel.cursorConfig.pageSize : Math.abs(amount);

		const moved = amount > 0
			? MoveOperations.down(this.viewModel.cursorConfig, this.viewModel, from.lineNumber, column, 0, count, true)
			: MoveOperations.up(this.viewModel.cursorConfig, this.viewModel, from.lineNumber, column, 0, count, true);

		const position = posOf(converter.convertViewPositionToModelPosition(new Position(moved.lineNumber, moved.column))) as Pos & { hitSide?: boolean };

		// `gj`/`gk` need to know they ran out of document rather than that they moved, which is
		// the fact `moveVertically` reports by clipping. Fewer lines than asked for is that fact.
		if (Math.abs(moved.lineNumber - from.lineNumber) < count) {
			position.hitSide = true;
		}

		return position;
	}

	// ------------------------------------------------------------------ pixels, which are cells

	charCoords(pos: IPos): { left: number; top: number; bottom: number } {
		return { left: pos.ch, top: pos.line, bottom: pos.line + 1 };
	}

	coordsChar(coords: { left: number; top: number }): Pos {
		return this.clipPos(new Pos(coords.top, coords.left));
	}

	defaultTextHeight(): number {
		return 1;
	}

	getScrollInfo(): { left: number; top: number; height: number; width: number; clientHeight: number; clientWidth: number } {
		return { left: 0, top: 0, height: this.view.lineCount, width: 0, clientHeight: this.viewModel.cursorConfig.pageSize, clientWidth: 0 };
	}

	scrollTo(): void { }
	scrollIntoView(): void { }
	setSize(): void { }
	refresh(): void { }

	/** Nothing wraps this editor, and `on`/`off` answer for anything that is not a DOM node. */
	getWrapperElement(): HTMLElement {
		return this.cm6 as unknown as HTMLElement;
	}

	getInputField(): HTMLElement {
		return this.cm6 as unknown as HTMLElement;
	}

	focus(): void { }
	blur(): void { }

	// ------------------------------------------------------------------ what the fork already has

	foldCode(pos: IPos): void {
		this.view.toggleFoldAtModelLine(pos.line + 1);
	}

	findMatchingBracket(pos: IPos): { to: Pos } | { to: undefined } {
		const match = this.model.bracketPairs.matchBracket(clip(this.model, pos));

		return { to: match ? posOf(match[1].getStartPosition()) : undefined };
	}

	scanForBracket(pos: IPos, dir: 1 | -1, _style: unknown, config: { bracketRegex?: RegExp; maxScanLineLength?: number; maxScanLines?: number }) {
		return scanForBracket(this, pos, dir, config);
	}

	/** `hl`'s colours are the theme's, so a token is only ever `comment`, `string` or neither. */
	getTokenTypeAt(pos: IPos): '' | 'string' | 'comment' {
		const position = clip(this.model, pos);
		this.model.tokenization.forceTokenization(position.lineNumber);
		const tokens = this.model.tokenization.getLineTokens(position.lineNumber);
		const type = tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(position.column - 1));

		// `StandardTokenType.Comment` is 1 and `String` is 2; the enum is a const enum, so the
		// names are erased and importing it would not survive type stripping (§13.4).
		return type === 1 ? 'comment' : type === 2 ? 'string' : '';
	}

	getMode(): { name: string } {
		return { name: this.model.getLanguageId() };
	}

	getSearchCursor(query: RegExp, pos: IPos) {
		const model = this.model;
		const search = { pattern: query.source, isRegex: true, matchCase: !query.ignoreCase, wordSeparators: null };
		let last: { range: Range; matches: string[] | null } | null = null;
		const start = clip(model, pos);

		const wrap = (found: { range: Range; matches: string[] | null } | null) => {
			last = found;

			return found?.matches ?? (found ? [model.getValueInRange(found.range)] : null);
		};

		return {
			findNext: function () { return this.find(false); },
			findPrevious: function () { return this.find(true); },
			find(back?: boolean) {
				const from = last ? (back ? last.range.getStartPosition() : last.range.getEndPosition()) : start;

				return wrap(back
					? model.findPreviousMatch(search.pattern, from, true, search.matchCase, null, true)
					: model.findNextMatch(search.pattern, from, true, search.matchCase, null, true));
			},
			from: () => last ? posOf(last.range.getStartPosition()) : undefined,
			to: () => last ? posOf(last.range.getEndPosition()) : undefined,
			replace: (text: string) => {
				if (last) {
					this.edit([{ range: last.range, text }]);
					last = { range: Range.fromPositions(last.range.getStartPosition(), model.getPositionAt(model.getOffsetAt(last.range.getStartPosition()) + text.length)), matches: null };
				}
			},
			get match() {
				return last?.matches ?? null;
			}
		};
	}

	/** The search highlight. A terminal's is `renderRow`'s `highlights`, which the pane reads. */
	addOverlay({ query }: { query: RegExp }): { query: RegExp } {
		this.overlay = query;

		return { query };
	}

	removeOverlay(): void {
		this.overlay = undefined;
	}

	setBookmark(cursor: IPos, options?: { insertLeft: boolean }): Marker {
		return new DecorationMarker(this, this.model, clip(this.model, cursor), !!options?.insertLeft);
	}

	// ------------------------------------------------------------------ indentation

	indentLine(_line: number, more?: boolean): void {
		if (more === false) {
			this.indentLess();
		} else {
			this.indentMore();
		}
	}

	indentMore(): void {
		this.shift(true);
	}

	indentLess(): void {
		this.shift(false);
	}

	private shift(right: boolean): void {
		const options = this.model.getOptions();
		const unit = options.insertSpaces ? ' '.repeat(options.indentSize) : '\t';

		this.edit(this.viewModel.getSelections().flatMap(selection => {
			const edits = [];

			for (let line = selection.startLineNumber; line <= selection.endLineNumber; line++) {
				const content = this.model.getLineContent(line);

				if (right) {
					edits.push({ range: new Range(line, 1, line, 1), text: unit });
				} else {
					const strip = content.startsWith(unit) ? unit.length : /^[ \t]*/.exec(content)![0].length;
					if (strip) {
						edits.push({ range: new Range(line, 1, line, strip + 1), text: '' });
					}
				}
			}

			return edits;
		}));
	}

	hardWrap(options: { from: number; to: number; column?: number; allowMerge?: boolean }): number {
		return hardWrap(this, options);
	}

	// ------------------------------------------------------------------ options

	getOption(name: 'firstLineNumber' | 'tabSize' | 'textwidth'): number;
	getOption(name: string): number | boolean | string | undefined;
	getOption(name: string): number | boolean | string | undefined {
		switch (name) {
			case 'firstLineNumber': return 1;
			case 'tabSize': return this.model.getOptions().tabSize;
			case 'indentUnit': return this.model.getOptions().indentSize;
			case 'indentWithTabs': return !this.model.getOptions().insertSpaces;
			case 'readOnly': return this.viewModel.getEditorOption(EditorOption.readOnly);
			case 'textwidth': return this.state.textwidth;
			case 'keyMap': return this.state.keyMap || 'vim';
			default: return this.options[name] as number | boolean | string | undefined;
		}
	}

	setOption(name: string, val: unknown): void {
		switch (name) {
			case 'keyMap': this.state.keyMap = val as string; break;
			case 'textwidth': this.state.textwidth = val as number; break;
			default: this.options[name] = val;
		}
	}

	execCommand(name: string): void {
		const command = TerminalCodeMirror.commands[name as keyof typeof TerminalCodeMirror.commands];

		if (command) {
			command(this);
		}
	}

	// ------------------------------------------------------------------ the operation

	/**
	 * One vim command.
	 *
	 * **This is where the undo stop is pushed**, and it is the only place that can be: nothing
	 * below a `CodeEditorWidget` calls `pushStackElement`, so without it every consecutive edit
	 * merges into one undo element and a single `u` takes back a whole session. Vim's granularity
	 * is one command, which is exactly this function's extent — and `startsUndoElement` is what
	 * says when that extent begins an element, which is the same answer the GUI adapter gets.
	 */
	operation<T>(fn: () => T, _force?: boolean): T {
		if (!this.curOp) {
			this.curOp = { $d: 0 };

			if (startsUndoElement(this.state)) {
				this.model.pushStackElement();
			}
		}
		this.curOp.$d++;

		try {
			return fn();
		} finally {
			if (this.curOp) {
				this.curOp.$d--;
				if (!this.curOp.$d) {
					this.onBeforeEndOperation();
				}
			}
		}
	}

	onBeforeEndOperation(): void {
		const op = this.curOp;

		if (op) {
			if (op.change) {
				signalTo(op.changeHandlers, this, op.change);
			}
			if (op.cursorActivity) {
				signalTo(op.cursorActivityHandlers, this, null);
			}
			this.curOp = null;
		}
	}

	/**
	 * A change landed in the model. Records it into the operation the way `cm_adapter.ts` records
	 * a `ViewUpdate`, so `.` can repeat an insert and a mark can follow the text it marked.
	 */
	onChange(changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]): void {
		const op = this.curOp = this.curOp || { $d: 0 };

		for (const change of changes) {
			const end = change.rangeOffset + change.text.length;
			op.$changeStart = op.$changeStart === undefined ? change.rangeOffset : Math.min(op.$changeStart, change.rangeOffset);
			this.$lastChangeEndOffset = end;

			const record = { text: change.text.split('\n') };
			if (!op.lastChange) {
				op.lastChange = op.change = record;
			} else {
				(op.lastChange as { next?: unknown }).next = op.lastChange = record;
			}
		}

		op.changeHandlers ||= this._handlers['change']?.slice();

		if (!op.$d) {
			this.onBeforeEndOperation();
		}
	}

	onSelectionChange(): void {
		const op = this.curOp = this.curOp || { $d: 0 };
		op.cursorActivityHandlers ||= this._handlers['cursorActivity']?.slice();
		op.cursorActivity = true;

		if (!op.$d) {
			this.onBeforeEndOperation();
		}
	}

	destroy(): void {
		this.removeOverlay();

		for (const id of Object.keys(this.marks)) {
			this.marks[id].clear();
		}
	}

	// ------------------------------------------------------------------ the prompt

	/**
	 * `:`, `/` and `?`. The engine builds its prompt as an element tree — `makePrompt` is a `div`
	 * holding the prefix and an `<input>` — and hands it over; **the prefix is not an option**, it
	 * is that tree's own text, which is where `showPrompt`'s own no-dialog branch reads it from
	 * too (`options.prefix.textContent`).
	 */
	openDialog(template: Element, callback: Function | undefined, options: { value?: string; onClose?: Function }): (newVal?: string) => void {
		const close = (value?: string) => {
			options.onClose?.(template);
			if (typeof value === 'string') {
				callback?.(value);
			}
		};

		this.prompt?.({ prefix: template.textContent ?? '', value: options.value ?? '', commit: close, close });

		return close;
	}

	openNotification(): () => void {
		return () => { };
	}

	// ------------------------------------------------------------------ edits

	/** Every edit takes this path, so the read-only guard and the cursor recovery are one place. */
	private edit(edits: { range: Range; text: string }[]): void {
		if (!edits.length) {
			return;
		}

		this.viewModel.executeEdits('vim', edits.map(edit => ({ range: edit.range, text: edit.text })), () => null, EditSources.unknown({ name: 'vim' }));
	}
}

/** The vim engine's own word test — `cm_adapter.ts`'s, with its own fallback. */
const WORD_CHAR = (() => {
	try {
		return new RegExp('[\\w\\p{Alphabetic}\\p{Number}_]', 'u');
	} catch {
		return /[\w]/;
	}
})();

/**
 * The constructor-with-statics `initVim` is handed.
 *
 * The engine never constructs it — there is no `new CM(...)` anywhere in `vim.js` — so this is a
 * namespace with a call signature rather than a class, and `VimAdapter` above is what an instance
 * actually is.
 */
export const TerminalCodeMirror = {
	isMac: false,
	Pos,
	StringStream,

	commands: {
		undo: (cm: VimAdapter) => { cm.view.model.undo(); },
		redo: (cm: VimAdapter) => { cm.view.model.redo(); },
		newlineAndIndent: (cm: VimAdapter) => { cm.replaceSelection('\n'); },
		indentAuto: (cm: VimAdapter) => { cm.indentMore(); },
		cursorCharLeft: (cm: VimAdapter) => { cm.moveH(-1, 'char'); },
		deleteLeft: (cm: VimAdapter) => { cm.deleteLeft(); },
		// A comment toggle needs the language's comment configuration, which this fork has and
		// `LineCommentCommand` is written against. Not done — §19 lists it.
		toggleLineComment: () => { },
		newlineAndIndentContinueComment: undefined,
		save: (cm: VimAdapter) => { cm.save?.(); }
	} as Record<string, ((cm: VimAdapter) => void) | undefined>,


	isWordChar: (ch: string) => WORD_CHAR.test(ch),

	keys: {} as Record<string, (cm: VimAdapter) => void>,
	lookupKey: (key: string, _map: string, handle: Function) => {
		const result = TerminalCodeMirror.keys[key];
		if (result) {
			handle(result);
		}
	},

	on,
	off,
	signal,

	addClass: () => { },
	rmClass: () => { },
	e_preventDefault: () => { },
	e_stop: () => { },

	/** As in `cm_adapter.ts`: tag objects need a syntax tree with tag nodes, and neither has one. */
	findMatchingTag: () => null,
	findEnclosingTag: () => undefined,

	keyName: undefined
};

export type { vimState };
