/*---------------------------------------------------------------------------------------------
 *  A `TextModel` as frontend-neutral projected rows: editing, folding and syntax colour.
 *
 *  All three are upstream's, and none of them is computed here:
 *
 *  | | |
 *  | --- | --- |
 *  | wrap, the cursor and the edits | **`ViewModel`** (`editor/common/viewModel/viewModelImpl.ts`), over the `ITextLayoutBackend` supplied by the frontend. It holds the model→view mapping and `CursorsController`; the frontend chooses cell, DOM or native geometry without replacing those semantics. |
 *  | the fold ranges | `IndentRangeProvider` over the language's `foldingRules`, and `FoldingModel` / `HiddenRangeModel` for the collapse state and what it hides |
 *  | the colours | `getViewLineData(n).tokens`, whose `getPresentation` gives a `ColorId` into `TokenizationRegistry.getColorMap()` — the map `TextMateTokenizationFeature` fills from the loaded theme's `tokenColorMap`. Same grammars, same theme, same registry |
 *
 *  What is written here is the semantic adapter: an `IDecorationProvider` over the model rather
 *  than an `ICodeEditor`, plus plain row/mapping records. Geometry is injected through
 *  `textLayout.ts`; cell-specific configuration stays under `src/tui`.
 *
 *  Upstream counterpart: src/vs/editor/browser/view.ts, src/vs/editor/browser/viewParts/viewLines/viewLines.ts
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../vs/base/common/async.js';
import { CancellationToken } from '../vs/base/common/cancellation.js';
import { Color } from '../vs/base/common/color.js';
import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../vs/base/common/lifecycle.js';
import { EditorOptions } from '../vs/editor/common/config/editorOptions.js';
import { EditOperationType } from '../vs/editor/common/cursorCommon.js';
import { DeleteOperations } from '../vs/editor/common/cursor/cursorDeleteOperations.js';
import { CursorChangeReason } from '../vs/editor/common/cursorEvents.js';
import { CursorMove, CursorMoveCommands } from '../vs/editor/common/cursor/cursorMoveCommands.js';
import { Position } from '../vs/editor/common/core/position.js';
import { Range } from '../vs/editor/common/core/range.js';
import { TokenizationRegistry } from '../vs/editor/common/languages.js';
import { ILanguageConfigurationService } from '../vs/editor/common/languages/languageConfigurationRegistry.js';
import type { TokenizationTextModelPart } from '../vs/editor/common/model/tokens/tokenizationTextModelPart.js';
import { BackgroundTokenizationState } from '../vs/editor/common/tokenizationTextModelPart.js';
import { IAttachedView, IModelDecorationOptions, IModelDecorationsChangeAccessor, ITextModel, TrackedRangeStickiness } from '../vs/editor/common/model.js';
import { ViewModel } from '../vs/editor/common/viewModel/viewModelImpl.js';
import { FoldingModel, IDecorationProvider } from '../vs/editor/contrib/folding/browser/foldingModel.js';
import { FoldingLimitReporter } from '../vs/editor/contrib/folding/browser/folding.js';
import { HiddenRangeModel } from '../vs/editor/contrib/folding/browser/hiddenRangeModel.js';
import { IndentRangeProvider } from '../vs/editor/contrib/folding/browser/indentRangeProvider.js';
import { editorForeground } from '../vs/platform/theme/common/colors/editorColors.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { ITextRenderLine as ILine, ITextRenderSpan as ISpan } from './textRender.js';
import type { ITextProjectionMappingSpan } from './textProjection.js';
import type { ITextLayoutBackend, ITextLayoutBackendFactory } from './textLayout.js';

/**
 * `editor.foldingMaximumRegions`' registered default, read off the option rather than repeated —
 * a folding computation that hits it reports it; this projection currently has no notification
 * surface for that report.
 */
const FOLDING_LIMIT: FoldingLimitReporter = {
	limit: EditorOptions.foldingMaximumRegions.defaultValue,
	update: () => { }
};

/** The fold state of the model line a row starts on, for whichever gutter a frontend draws. */
export const enum FoldState {
	None,
	Expanded,
	Collapsed
}

/** Plain cursor geometry used by frontend projections. */
export interface IViewCaretRecord {
	readonly column: number;
	readonly primary: boolean;
}

/** Plain selection geometry used by frontend projections. */
export interface IViewSelectionRecord {
	readonly start: number;
	readonly end: number;
	readonly toEndOfLine: boolean;
}

/** UTF-16 document offsets, independent of either frontend's text-input API. */
export interface ITextOffsetRange {
	readonly location: number;
	readonly length: number;
}

/** A model/view position carried across the projection boundary as scalar data. */
export interface ITextPositionRecord {
	readonly lineNumber: number;
	readonly column: number;
}

export interface ITextSelectionRecord {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber?: number;
	readonly endColumn?: number;
}

export interface ITextSelectionSnapshotRecord {
	readonly anchor: ITextPositionRecord;
	readonly active: ITextPositionRecord;
	readonly location: number;
	readonly length: number;
	readonly primary: boolean;
}

export type TextEditorInputAction = 'newline' | 'delete-left' | 'delete-right' | 'left' | 'right' | 'up' | 'down'
	| 'select-left' | 'select-right' | 'select-up' | 'select-down' | 'line-start' | 'line-end'
	| 'select-line-start' | 'select-line-end';

/**
 * How long `whenTokenized` waits. It is the same order as `editor.maxComputationTime`'s 5,000 ms:
 * long enough for a grammar and the oniguruma wasm to load on a cold start, short enough that a
 * language whose tokens never become accurate does not stall a run.
 */
const TOKENIZATION_TIMEOUT = 5_000;

export class TextView extends Disposable {
	private readonly layoutBackend: ITextLayoutBackend;
	private layoutModelLineCount: number;

	/** The editor's own view model: the projection, the cursor and the edits. */
	readonly viewModel: ViewModel;

	private readonly folding: FoldingModel;
	private readonly hidden: HiddenRangeModel;
	private readonly foldingRanges: IndentRangeProvider;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the rows changed — a fold toggled, or tokens arriving from the worker. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly attached: IAttachedView;

	/** The model lines `renderRow` has been asked for since the last `publishViewport`. */
	private rendered: { first: number; last: number } | undefined;

	constructor(
		readonly model: ITextModel,
		private width: number,
		private wrap: boolean,
		layoutFactory: ITextLayoutBackendFactory,
		@IThemeService private readonly themeService: IThemeService,
		@ILanguageConfigurationService languageConfigurationService: ILanguageConfigurationService
	) {
		super();

		this.layoutModelLineCount = model.getLineCount();
		this.layoutBackend = this._register(layoutFactory.create({ width, wrap, modelLineCount: this.layoutModelLineCount }));
		this.viewModel = new ViewModel(
			// The editor id a projection is keyed by; there is one view per model here.
			1,
			this.layoutBackend.configuration,
			model,
			this.layoutBackend.lineBreaksComputerFactory,
			this.layoutBackend.lineBreaksComputerFactory,
			// A frame, as a scheduler. `unref`'d because a scheduled repaint must not be a reason
			// for the process to stay alive — the lesson `textMateTokenizationFeatureImpl.ts`'s
			// one-hour timer taught (§1.4).
			callback => {
				const immediate = setImmediate(callback).unref();

				return toDisposable(() => clearImmediate(immediate));
			},
			languageConfigurationService,
			this.themeService,
			// Not `model.onBeforeAttached()`: the viewport tokenized for is the rows a frontend
			// reports through `publishViewport`, not `ViewLayout`'s private scroll position.
			{ setVisibleLines: () => { } },
			{ batchChanges: callback => callback() }
		);
		// Guarded, as every teardown below is: `TextModelResolver` and this view live in the same pane's
		// store, so the model can go first, and a disposed `TextModel` throws on every method — here
		// on the `deltaDecorations` that clears the hidden-area decorations.
		this._register(toDisposable(() => !model.isDisposed() && this.viewModel.dispose()));

		// What a widget's focus tracker does. Undo records the selection it was made with and
		// restores it only for a focused editor, so without this an undo lands the cursor wherever
		// it happened to be.
		this.viewModel.setHasFocus(true);

		this.folding = this._register(new FoldingModel(model, new ModelDecorationProvider(model)));
		this.hidden = this._register(new HiddenRangeModel(this.folding));
		this.foldingRanges = new IndentRangeProvider(model, languageConfigurationService, FOLDING_LIMIT);

		this._register(this.hidden.onDidChange(ranges => {
			this.viewModel.setHiddenAreas(ranges.map(range => Range.lift(range)));
			this._onDidChange.fire();
		}));

		// Tokens arrive from the tokenization worker after the first paint, which is what
		// upstream's own async tokenization does; the rows do not change, their colours do.
		this._register(model.onDidChangeTokens(() => this._onDidChange.fire()));
		this._register(TokenizationRegistry.onDidChange(() => this._onDidChange.fire()));

		// A model tokenizes for its *attached views*, and only the lines they say are visible:
		// `TokenizerSyntaxTokenBackend` joins every attached view's line ranges and asks the
		// background tokenizer for those. `ViewModel` does exactly this pair — attach, then report
		// the viewport on every scroll — and without it a model's tokenization state stays
		// `InProgress` for ever and every token keeps the default colour.
		this.attached = model.onBeforeAttached();
		// Guarded, because the model can go first: `TextModelResolver` and the view live in the same
		// pane's store, and a disposed `TextModel` throws on every method including this one.
		this._register(toDisposable(() => !model.isDisposed() && model.onBeforeDetached(this.attached)));
	}

	/** Computes the fold regions. Awaited by the pane before its first paint. */
	async open(): Promise<void> {
		this.folding.update(await this.foldingRanges.compute(CancellationToken.None));
	}

	/**
	 * Resolves once the rows are showing the tokenizer's colours rather than the default ones.
	 *
	 * Tokenization is asynchronous by design and this is not a workaround for it: the grammar and
	 * the oniguruma wasm are loaded on the first ask, and with
	 * `editor.experimental.asyncTokenization` — on by default — the tokens are then computed on a
	 * worker. So a first paint is uncoloured and a repaint follows, which is what
	 * `onDidChangeTokens` above is for. What needs this is the driven run: it reads the screen when
	 * the work a keystroke started has settled, and without this the colours are not part of that.
	 *
	 * Bounded, because a language with a grammar this fork does not ship never becomes accurate and
	 * a viewer must not wait for ever on one. And abandoned as soon as the model goes, because a
	 * pane can be told to show something else while this is still out.
	 */
	async whenTokenized(): Promise<void> {
		if (!await TokenizationRegistry.getOrCreate(this.model.getLanguageId()) || this.model.isDisposed()) {
			return;
		}

		// A viewport can finish tokenizing synchronously without the background worker
		// reporting completion. Accurate end-of-file tokens also settle the model, but
		// require real tokens: the uninitialized fallback reports accurate lines too.
		const deadline = Date.now() + TOKENIZATION_TIMEOUT;
		while (this.model.tokenization.backgroundTokenizationState !== BackgroundTokenizationState.Completed
			&& !(this.model.tokenization.hasTokens && this.model.tokenization.hasAccurateTokensForLine(this.model.getLineCount()))
			&& Date.now() < deadline) {
			// Completion can arrive after the last token-change event (including when a
			// reopened model already has tokens). Wait for the tokenizer's completion too.
			const tokens = (this.model.tokenization as TokenizationTextModelPart).tokens.get();
			const listeners = new DisposableStore();
			try {
				await raceTimeout(Event.toPromise(Event.any(
					Event.map(this.model.onDidChangeTokens, () => undefined),
					tokens.onDidChangeBackgroundTokenizationState,
					this.model.onWillDispose
				), listeners), deadline - Date.now());
			} finally { listeners.dispose(); }
			if (this.model.isDisposed()) { return; }
		}
	}

	get lineCount(): number {
		return this.viewModel.getLineCount();
	}

	get documentLength(): number {
		return this.model.getValueLength();
	}

	get modelLineCount(): number {
		return this.model.getLineCount();
	}

	get languageId(): string {
		return this.model.getLanguageId();
	}

	async undo(): Promise<void> { await this.model.undo(); }
	async redo(): Promise<void> { await this.model.redo(); }

	setSelection(selection: ITextSelectionRecord, source: string): void {
		this.viewModel.setSelections(source, [{
			selectionStartLineNumber: selection.startLineNumber,
			selectionStartColumn: selection.startColumn,
			positionLineNumber: selection.endLineNumber ?? selection.startLineNumber,
			positionColumn: selection.endColumn ?? selection.startColumn
		}]);
	}

	get primarySelectionOffsets(): ITextOffsetRange {
		const selection = this.viewModel.getSelections()[0];
		const start = this.model.getOffsetAt(selection.getStartPosition());

		return { location: start, length: this.model.getOffsetAt(selection.getEndPosition()) - start };
	}

	textForOffsets(range: ITextOffsetRange): string {
		return this.model.getValueInRange(Range.fromPositions(
			this.model.getPositionAt(range.location),
			this.model.getPositionAt(range.location + range.length)
		));
	}

	viewPositionAtOffset(offset: number): ITextPositionRecord {
		return this.viewModel.coordinatesConverter.convertModelPositionToViewPosition(this.model.getPositionAt(offset));
	}

	modelPositionAtViewPosition(position: ITextPositionRecord): ITextPositionRecord {
		return this.viewModel.coordinatesConverter.convertViewPositionToModelPosition(Position.lift(position));
	}

	offsetAtModelPosition(position: ITextPositionRecord): number {
		return this.model.getOffsetAt(Position.lift(position));
	}

	/** Shared text-input gateway for focus state; frontends do not mutate ViewModel directly. */
	setInputFocused(focused: boolean): void {
		this.viewModel.setHasFocus(focused);
	}

	/** Text-input gateway for replacing an explicit model range. */
	selectOffsets(range: ITextOffsetRange, source: string): void {
		const start = this.model.getPositionAt(range.location);
		const end = this.model.getPositionAt(range.location + range.length);
		this.viewModel.setSelections(source, [{
			selectionStartLineNumber: start.lineNumber,
			selectionStartColumn: start.column,
			positionLineNumber: end.lineNumber,
			positionColumn: end.column
		}]);
	}

	moveSelectionTo(position: ITextPositionRecord, extend: boolean, source: string): void {
		const anchor = extend ? this.viewModel.getSelections()[0].getSelectionStart() : Position.lift(position);
		this.viewModel.setSelections(source, [{
			selectionStartLineNumber: anchor.lineNumber,
			selectionStartColumn: anchor.column,
			positionLineNumber: position.lineNumber,
			positionColumn: position.column
		}]);
	}

	performInputAction(action: TextEditorInputAction): void {
		switch (action) {
			case 'newline': this.viewModel.type('\n', 'keyboard'); break;
			case 'delete-left': this.deleteInput(false); break;
			case 'delete-right': this.deleteInput(true); break;
			case 'left': this.moveInput(CursorMove.Direction.Left, false); break;
			case 'right': this.moveInput(CursorMove.Direction.Right, false); break;
			case 'up': this.moveInput(CursorMove.Direction.Up, false); break;
			case 'down': this.moveInput(CursorMove.Direction.Down, false); break;
			case 'select-left': this.moveInput(CursorMove.Direction.Left, true); break;
			case 'select-right': this.moveInput(CursorMove.Direction.Right, true); break;
			case 'select-up': this.moveInput(CursorMove.Direction.Up, true); break;
			case 'select-down': this.moveInput(CursorMove.Direction.Down, true); break;
			case 'line-start': this.moveLineEdgeInput(false, false); break;
			case 'line-end': this.moveLineEdgeInput(true, false); break;
			case 'select-line-start': this.moveLineEdgeInput(false, true); break;
			case 'select-line-end': this.moveLineEdgeInput(true, true); break;
		}
	}

	selectAllInput(): void {
		this.viewModel.model.pushStackElement();
		this.viewModel.setCursorStates('keyboard', CursorChangeReason.Explicit, [
			CursorMoveCommands.selectAll(this.viewModel, this.viewModel.getPrimaryCursorState())
		]);
	}

	startComposition(): void { this.viewModel.startComposition(); }
	compositionType(text: string, replacePrevious: number, positionDelta: number, source: string): void {
		this.viewModel.compositionType(text, replacePrevious, 0, positionDelta, source);
	}
	typeInput(text: string, source: string): void { this.viewModel.type(text, source); }
	endComposition(source: string): void { this.viewModel.endComposition(source); }
	get primaryCursorOffset(): number { return this.model.getOffsetAt(this.viewModel.getPosition()); }

	/** Complete scalar selection state for immutable frontend snapshots. */
	get selectionSnapshot(): readonly ITextSelectionSnapshotRecord[] {
		const primary = this.viewModel.getPosition();
		return this.viewModel.getSelections().map(selection => {
			const anchor = selection.getSelectionStart();
			const active = selection.getPosition();
			const start = this.model.getOffsetAt(selection.getStartPosition());
			return {
				anchor: { lineNumber: anchor.lineNumber, column: anchor.column },
				active: { lineNumber: active.lineNumber, column: active.column },
				location: start,
				length: this.model.getOffsetAt(selection.getEndPosition()) - start,
				primary: active.equals(primary)
			};
		});
	}

	private moveInput(direction: CursorMove.SimpleMoveDirection, select: boolean): void {
		this.viewModel.model.pushStackElement();
		this.viewModel.setCursorStates('keyboard', CursorChangeReason.Explicit, CursorMoveCommands.simpleMove(
			this.viewModel, this.viewModel.getCursorStates(), direction, select, 1,
			direction === CursorMove.Direction.Up || direction === CursorMove.Direction.Down ? CursorMove.Unit.WrappedLine : CursorMove.Unit.None
		));
	}

	private moveLineEdgeInput(end: boolean, select: boolean): void {
		const states = end
			? CursorMoveCommands.moveToEndOfLine(this.viewModel, this.viewModel.getCursorStates(), select, false)
			: CursorMoveCommands.moveToBeginningOfLine(this.viewModel, this.viewModel.getCursorStates(), select);
		this.viewModel.model.pushStackElement();
		this.viewModel.setCursorStates('keyboard', CursorChangeReason.Explicit, states);
	}

	private deleteInput(forward: boolean): void {
		const [pushBefore, commands] = forward
			? DeleteOperations.deleteRight(this.viewModel.getPrevEditOperationType(), this.viewModel.cursorConfig, this.viewModel.model, this.viewModel.getSelections())
			: DeleteOperations.deleteLeft(this.viewModel.getPrevEditOperationType(), this.viewModel.cursorConfig, this.viewModel.model,
				this.viewModel.getSelections(), this.viewModel.getCursorAutoClosedCharacters());
		if (pushBefore) { this.viewModel.model.pushStackElement(); }
		this.viewModel.executeCommands(commands.filter(command => !!command), forward ? 'deleteRight' : 'deleteLeft');
		this.viewModel.setPrevEditOperationType(forward ? EditOperationType.DeletingRight : EditOperationType.DeletingLeft);
	}

	layout(width: number): void {
		const modelLineCount = this.model.getLineCount();
		if (width !== this.width || modelLineCount !== this.layoutModelLineCount) {
			this.width = width;
			this.layoutModelLineCount = modelLineCount;
			this.applyWrappingSettings();
		}
	}

	/** Turns word wrap on or off, which is `editor.wordWrap` with nothing between the two states. */
	setWrap(wrap: boolean): void {
		if (wrap !== this.wrap) {
			this.wrap = wrap;
			this.applyWrappingSettings();
		}
	}

	get wrapping(): boolean {
		return this.wrap;
	}

	/**
	 * Republishes the wrapping column. `ViewModel` answers a configuration change by calling
	 * `setWrappingSettings` itself, so this reaches the same code by upstream's own path.
	 */
	private applyWrappingSettings(): void {
		this.layoutModelLineCount = this.model.getLineCount();
		this.layoutBackend.update({ width: this.width, wrap: this.wrap, modelLineCount: this.layoutModelLineCount });
		this._onDidChange.fire();
	}

	/** The text of one row, which is what a caller matches a search overlay against. */
	rowContent(index: number): string {
		return this.viewModel.getLineContent(index + 1);
	}

	/**
	 * Compact document mapping for one rendered row. This editor currently renders model text only:
	 * folding removes whole view rows and wrapping divides a model line, so each surviving row is
	 * one linear span. The explicit kind keeps that fact at the producer boundary and leaves room
	 * for upstream injected/fold replacement segments without teaching either frontend about them.
	 */
	mappingForViewRow(index: number): readonly ITextProjectionMappingSpan[] {
		const content = this.rowContent(index);
		const converter = this.viewModel.coordinatesConverter;
		const start = converter.convertViewPositionToModelPosition(new Position(index + 1, 1));
		const end = converter.convertViewPositionToModelPosition(new Position(index + 1, content.length + 1));
		const continuation = index > 0 && this.modelLineAt(index - 1) === start.lineNumber;

		return [{
			viewStart: 0,
			viewEnd: content.length,
			documentStart: this.model.getOffsetAt(start),
			documentEnd: this.model.getOffsetAt(end),
			kind: continuation ? 'wrapped-continuation' : 'linear',
			affinity: 'both'
		}];
	}

	/** The primary cursor's view row, in the same zero-based coordinates as `renderRow`. */
	get cursorRow(): number {
		return this.viewModel.coordinatesConverter.convertModelPositionToViewPosition(this.viewModel.getPosition()).lineNumber - 1;
	}

	/** Every caret on a one-based view line, as frontend-neutral column records. */
	caretsForViewLine(line: number): readonly IViewCaretRecord[] {
		const converter = this.viewModel.coordinatesConverter;
		const primary = this.viewModel.getPosition();

		return this.viewModel.getSelections()
			.map(selection => ({ model: selection.getPosition(), view: converter.convertModelPositionToViewPosition(selection.getPosition()) }))
			.filter(caret => caret.view.lineNumber === line)
			.map(caret => ({ column: caret.view.column - 1, primary: caret.model.equals(primary) }));
	}

	/** Every non-empty selection crossing a one-based view line, as plain column records. */
	selectionsForViewLine(line: number): readonly IViewSelectionRecord[] {
		const converter = this.viewModel.coordinatesConverter;
		const ranges: IViewSelectionRecord[] = [];

		for (const selection of this.viewModel.getSelections()) {
			if (selection.isEmpty()) {
				continue;
			}

			const start = converter.convertModelPositionToViewPosition(selection.getStartPosition());
			const end = converter.convertModelPositionToViewPosition(selection.getEndPosition());
			if (line < start.lineNumber || line > end.lineNumber) {
				continue;
			}

			ranges.push({
				start: line === start.lineNumber ? start.column - 1 : 0,
				end: line === end.lineNumber ? end.column - 1 : 0,
				toEndOfLine: line !== end.lineNumber
			});
		}

		return ranges;
	}

	/** The model line a row shows, which is what a fold gesture and a status line are about. */
	modelLineAt(index: number): number {
		return this.viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(index + 1, 1)).lineNumber;
	}

	/**
	 * The fold state of the model line a row starts on, and `None` for a row that only continues a
	 * wrapped line, since a fold glyph belongs to the first row of one. Frontends receive the state
	 * directly rather than parsing presentation output.
	 */
	foldStateAt(index: number): FoldState {
		const modelLine = this.modelLineAt(index);

		return this.foldStateOfLine(modelLine, index === 0 || this.modelLineAt(index - 1) !== modelLine);
	}

	/** The same, for a caller that has already worked out both — as `renderRow` has. */
	private foldStateOfLine(modelLine: number, first: boolean): FoldState {
		const region = first ? this.folding.getRegionAtLine(modelLine) : undefined;

		return !region || region.startLineNumber !== modelLine
			? FoldState.None
			: region.isCollapsed ? FoldState.Collapsed : FoldState.Expanded;
	}

	/** Folds or unfolds the region starting at the row's model line. Answers whether one did. */
	toggleFoldAt(index: number): boolean {
		return this.toggleFoldAtModelLine(this.modelLineAt(index));
	}

	/** The same, addressed the way the vim engine's `foldCode` addresses it. */
	toggleFoldAtModelLine(lineNumber: number): boolean {
		const region = this.folding.getRegionAtLine(lineNumber);
		if (!region) {
			return false;
		}

		this.folding.toggleCollapseState([region]);

		return true;
	}

	/** One row of tokenized content. Gutter and decoration presentation belong to render adapters. */
	renderRow(index: number): ILine {
		const theme = this.themeService.getColorTheme();
		const data = this.viewModel.getViewLineData(index + 1);
		const modelLine = this.modelLineAt(index);

		this.rendered = {
			first: Math.min(this.rendered?.first ?? modelLine, modelLine),
			last: Math.max(this.rendered?.last ?? modelLine, modelLine)
		};

		return tokenSpans(data.content, data.tokens, theme.getColor(editorForeground));
	}

	/**
	 * Tells the model which lines are on screen, which is what makes it tokenize them. The rows
	 * just rendered *are* the viewport, so a caller reports it once a frame after laying out —
	 * `ViewModel` reports the same thing on every scroll.
	 *
	 * `stabilized` is false, as it is for a scroll: it is what lets the tokenizer answer
	 * asynchronously instead of blocking on the spot, keeping viewport movement responsive.
	 */
	publishViewport(): void {
		if (this.rendered) {
			this.attached.setVisibleLines([{ startLineNumber: this.rendered.first, endLineNumber: this.rendered.last }], false);
			this.rendered = undefined;
		}
	}

}

/** The part of `IViewLineTokens` a row needs. */
export type ILineTokens = ReturnType<ViewModel['getViewLineData']>['tokens'];

/**
 * The tokens of one line as spans. `getPresentation` is what the editor's own renderer reads, and
 * the colour map is `TokenizationRegistry`'s — so a token's colour here is the colour tscode paints
 * it, or `fallback` while the tokenizer has not answered yet.
 *
 * Module scope rather than a member because the markdown preview's fenced blocks want exactly this
 * and have no `ViewModel`: they tokenize a string with `tokenizeEncoded` and nothing else about a
 * `TextView` applies. Two copies of this loop would be two answers to what colour a token is.
 */
export function tokenSpans(content: string, tokens: ILineTokens, fallback: Color | undefined, bg?: Color): ISpan[] {
	const colorMap = TokenizationRegistry.getColorMap();
	const spans: ISpan[] = [];
	let offset = 0;

	for (let token = 0; token < tokens.getCount(); token++) {
		const end = tokens.getEndOffset(token);
		const presentation = tokens.getPresentation(token);

		spans.push({
			text: content.substring(offset, end),
			fg: colorMap?.[presentation.foreground] ?? fallback,
			bg,
			bold: presentation.bold,
			italic: presentation.italic,
			underline: presentation.underline,
			strikethrough: presentation.strikethrough
		});
		offset = end;
	}

	return spans.length ? spans : [{ text: content, fg: fallback, bg }];
}

/**
 * `FoldingModel`'s decoration seam, over a `TextModel`.
 *
 * Upstream's `FoldingDecorationProvider` takes an `ICodeEditor` because its decorations are
 * margin glyphs and a collapsed-region widget. A projection frontend draws the state itself from
 * `FoldingRegion.isCollapsed`, so what the model needs to carry is the range and its stickiness —
 * which is what makes a fold survive an edit — and nothing visual.
 */
class ModelDecorationProvider implements IDecorationProvider {

	private static readonly COLLAPSED: IModelDecorationOptions = {
		description: 'tucode-folded',
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
	};

	private static readonly EXPANDED: IModelDecorationOptions = {
		description: 'tucode-fold-range',
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
	};

	constructor(private readonly model: ITextModel) { }

	getDecorationOption(isCollapsed: boolean): IModelDecorationOptions {
		return isCollapsed ? ModelDecorationProvider.COLLAPSED : ModelDecorationProvider.EXPANDED;
	}

	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null {
		return this.model.isDisposed() ? null : this.model.changeDecorations(callback);
	}

	/** A model that has gone has no decorations left to remove, and answers every call by throwing. */
	removeDecorations(decorationIds: string[]): void {
		this.changeDecorations(accessor => {
			for (const id of decorationIds) {
				accessor.removeDecoration(id);
			}
		});
	}
}
