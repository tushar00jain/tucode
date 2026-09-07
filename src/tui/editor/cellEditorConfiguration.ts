/*---------------------------------------------------------------------------------------------
 *  Editor options computed for a cell-grid frontend.
 *
 *  `ViewModel` and `CursorsController` both take an `IEditorConfiguration`, and upstream's
 *  implementation cannot be constructed here: its constructor builds an `ElementSizeObserver`
 *  over a container and subscribes to `PixelRatio`, whose monitor asks a canvas for a 2d
 *  context. That is rung 4 for the *class* and rung 1 for everything inside it —
 *  `ComputedEditorOptions` is exported, and `validate()` / `compute()` are each option's own, so
 *  what is written here is the two registry loops upstream keeps in a non-exported
 *  `EditorOptionsUtil` and nothing else. Every option value is still upstream's own arithmetic.
 *
 *  **Pixel geometry is zeroed rather than left at its defaults**, in `CELL_OPTIONS` below,
 *  and that is not tidiness: with stock defaults and an 80×24 frame, `layoutInfo` computes
 *  `contentWidth 15` and `wrappingColumn 1` — silently, because a layout that makes no sense is
 *  still a layout. The margins upstream reserves are pixel constants (`lineDecorationsWidth`
 *  10, folding's +16, the minimap, the scrollbars) and a terminal cell is one unit wide, so
 *  each of them would eat columns of text.
 *
 *  Upstream counterpart: src/vs/editor/browser/config/editorConfiguration.ts
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { equals } from '../../vs/base/common/objects.js';
import { IEditorConfiguration } from '../../vs/editor/common/config/editorConfiguration.js';
import { ComputedEditorOptions } from '../../vs/editor/browser/config/editorConfiguration.js';
import { ComputeOptionsMemory, ConfigurationChangedEvent, editorOptionsRegistry, IEditorOptions, IEnvironmentalOptions } from '../../vs/editor/common/config/editorOptions.js';
import { FontInfo } from '../../vs/editor/common/config/fontInfo.js';
import { AccessibilitySupport } from '../../vs/platform/accessibility/common/accessibility.js';
import { MenuId } from '../../vs/platform/actions/common/actions.js';

/**
 * A terminal cell, as a font. Every width is in cells rather than pixels, which is the unit the
 * wrap computer divides in and the unit `layoutInfo` then reserves its margins in, and
 * `isMonospace` is what a terminal is.
 *
 * The ratio is the only thing `MonospaceLineBreaksComputerFactory` reads —
 * `typicalFullwidthCharacterWidth / typicalHalfwidthCharacterWidth`, the columns a full-width
 * character occupies — and in a terminal that is 2 by definition of the grid.
 */
export const CELL_FONT = new FontInfo({
	pixelRatio: 1,
	fontFamily: 'monospace',
	fontWeight: 'normal',
	fontSize: 1,
	fontFeatureSettings: '',
	fontVariationSettings: '',
	lineHeight: 1,
	letterSpacing: 0,
	isMonospace: true,
	typicalHalfwidthCharacterWidth: 1,
	typicalFullwidthCharacterWidth: 2,
	canUseHalfwidthRightwardsArrow: true,
	spaceWidth: 1,
	middotWidth: 1,
	wsmiddotWidth: 1,
	maxDigitWidth: 1
}, true);

/**
 * What every editor in this frontend is configured with, before a caller's own options.
 *
 * Two groups, and neither is a preference:
 *
 * - **The margins**, zeroed, because this fork paints its own gutter (`textView.ts`) and its own
 *   scrollbars (`pane.ts`), and upstream reserves each of them in pixels. Left at their
 *   defaults they take columns away from the text.
 * - **Auto-closing and auto-indent, off.** Vim types a character to mean that character. A
 *   *plaintext* model still auto-closed `(` to `()` and auto-indented three lines out of one,
 *   because the default language configuration has brackets and `plaintext` does not opt out.
 */
const CELL_OPTIONS: IEditorOptions = {
	glyphMargin: false,
	lineNumbers: 'off',
	lineDecorationsWidth: 0,
	folding: false,
	minimap: { enabled: false },
	overviewRulerLanes: 0,
	overviewRulerBorder: false,
	scrollbar: { vertical: 'hidden', horizontal: 'hidden', verticalScrollbarSize: 0, horizontalScrollbarSize: 0, verticalHasArrows: false, horizontalHasArrows: false, arrowSize: 0 },
	scrollBeyondLastLine: false,
	scrollBeyondLastColumn: 0,
	padding: { top: 0, bottom: 0 },
	renderLineHighlight: 'none',
	autoClosingBrackets: 'never',
	autoClosingQuotes: 'never',
	autoClosingComments: 'never',
	autoClosingDelete: 'never',
	autoClosingOvertype: 'never',
	autoSurround: 'never',
	autoIndent: 'none',
	// `simple` is the strategy that does not measure a DOM node, which is the only other one.
	wrappingStrategy: 'simple',
	wrappingIndent: 'same'
};

/**
 * `IEditorConfiguration` over a frame rather than over an element.
 *
 * The size is set by the caller — `layout(cols, rows)` — rather than observed, because a
 * terminal pane is told its size and there is no `ResizeObserver` that ever fires (§3.1).
 */
export class CellEditorConfiguration extends Disposable implements IEditorConfiguration {

	private readonly _onDidChange = this._register(new Emitter<ConfigurationChangedEvent>());
	readonly onDidChange: Event<ConfigurationChangedEvent> = this._onDidChange.event;

	private readonly _onDidChangeFast = this._register(new Emitter<ConfigurationChangedEvent>());
	readonly onDidChangeFast: Event<ConfigurationChangedEvent> = this._onDidChangeFast.event;

	/** False, so the options compute as a real code editor's: a simple widget drops the font ligatures and the accessibility page size. */
	readonly isSimpleWidget = false;
	readonly contextMenuId = MenuId.EditorContext;

	options: ComputedEditorOptions;

	private readonly raw: IEditorOptions;
	private validated: ComputedEditorOptions;

	/** Carried across recomputes, as upstream carries it: the minimap layout's stability cache. */
	private readonly memory = new ComputeOptionsMemory();

	private isDominatedByLongLines = false;
	private viewLineCount = 1;
	private lineNumbersDigitCount = 1;
	private reservedHeight = 0;
	private glyphMarginDecorationLaneCount = 1;

	constructor(private cols: number, private rows: number, options?: IEditorOptions) {
		super();

		this.raw = { ...CELL_OPTIONS, ...options };
		this.validated = validate(this.raw);
		this.options = compute(this.validated, this.environment());
	}

	/** The frame changed size. Answers whether any option moved, which is what a wrap re-check is. */
	layout(cols: number, rows: number): boolean {
		if (cols === this.cols && rows === this.rows) {
			return false;
		}

		this.cols = cols;
		this.rows = rows;

		return this.recompute();
	}

	getRawOptions(): IEditorOptions {
		return this.raw;
	}

	updateOptions(newOptions: Readonly<IEditorOptions>): void {
		Object.assign(this.raw, newOptions);
		this.validated = validate(this.raw);
		this.recompute();
	}

	/** Nothing observes a container: `layout` is how this one is told its size. */
	observeContainer(): void { }

	setIsDominatedByLongLines(isDominatedByLongLines: boolean): void {
		this.isDominatedByLongLines = isDominatedByLongLines;
		this.recompute();
	}

	setModelLineCount(modelLineCount: number): void {
		this.lineNumbersDigitCount = String(Math.max(1, modelLineCount)).length;
		this.recompute();
	}

	setViewLineCount(viewLineCount: number): void {
		this.viewLineCount = viewLineCount;
		this.recompute();
	}

	setReservedHeight(reservedHeight: number): void {
		this.reservedHeight = reservedHeight;
		this.recompute();
	}

	setGlyphMarginDecorationLaneCount(decorationLaneCount: number): void {
		this.glyphMarginDecorationLaneCount = decorationLaneCount;
		this.recompute();
	}

	/**
	 * Recomputes and fires. Answers whether anything changed — upstream returns nothing here and
	 * has `onDidChange` for every consumer; a terminal pane is the only consumer and asks
	 * directly, so the event and the answer are the same fact said twice.
	 */
	private recompute(): boolean {
		const computed = compute(this.validated, this.environment());
		const change = changes(this.options, computed);

		if (!change) {
			return false;
		}

		this.options = computed;
		this._onDidChangeFast.fire(change);
		this._onDidChange.fire(change);

		return true;
	}

	private environment(): IEnvironmentalOptions {
		return {
			memory: this.memory,
			outerWidth: this.cols,
			outerHeight: this.rows - this.reservedHeight,
			fontInfo: CELL_FONT,
			extraEditorClassName: '',
			isDominatedByLongLines: this.isDominatedByLongLines,
			viewLineCount: this.viewLineCount,
			lineNumbersDigitCount: this.lineNumbersDigitCount,
			// `editor.emptySelectionClipboard` is a WebKit/Firefox quirk upstream reads off the
			// browser; a terminal copies what is selected.
			emptySelectionClipboard: false,
			pixelRatio: 1,
			tabFocusMode: false,
			// Read from the process-global `InputMode` upstream, which is where vim's `R` lands —
			// §19 says why that is not scoped to one editor here.
			inputMode: 'insert',
			accessibilitySupport: AccessibilitySupport.Disabled,
			glyphMarginDecorationLaneCount: this.glyphMarginDecorationLaneCount,
			editContextSupported: false
		};
	}
}

/**
 * `EditorOptionsUtil.validateOptions`, which is not exported. Every `validate` is upstream's.
 *
 * The bag is `ComputedEditorOptions` because upstream's `ValidatedEditorOptions` is not exported
 * either, and the two classes are the same `_read`/`_write` array behind different names.
 */
function validate(options: IEditorOptions): ComputedEditorOptions {
	const result = new ComputedEditorOptions();

	for (const option of editorOptionsRegistry) {
		result._write(option.id, option.validate(option.name === '_never_' ? undefined : (options as Record<string, unknown>)[option.name]));
	}

	return result;
}

/** `EditorOptionsUtil.computeOptions`, likewise. Every `compute` is upstream's. */
function compute(validated: ComputedEditorOptions, environment: IEnvironmentalOptions): ComputedEditorOptions {
	const result = new ComputedEditorOptions();

	for (const option of editorOptionsRegistry) {
		result._write(option.id, option.compute(environment, result, validated._read(option.id)));
	}

	return result;
}

/**
 * `EditorOptionsUtil.checkEquals`, likewise — except that the deep comparison is
 * `objects.equals` rather than a second one, which is the one line upstream would have shared
 * had its own predicate been reachable.
 */
function changes(before: ComputedEditorOptions, after: ComputedEditorOptions): ConfigurationChangedEvent | null {
	const changed: boolean[] = [];
	let any = false;

	for (const option of editorOptionsRegistry) {
		changed[option.id] = !equals(before._read(option.id), after._read(option.id));
		any ||= changed[option.id];
	}

	return any ? new ConfigurationChangedEvent(changed) : null;
}
