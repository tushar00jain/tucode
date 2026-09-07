/*---------------------------------------------------------------------------------------------
 * Terminal text presentation and input over the upstream text and working-copy models.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../vs/base/common/color.js';
import { Disposable, IDisposable } from '../vs/base/common/lifecycle.js';
import type { ITextFileEditorModel } from '../vs/workbench/services/textfile/common/textfiles.js';
import { EditorOption } from '../vs/editor/common/config/editorOptions.js';
import { ITextModel } from '../vs/editor/common/model.js';
import { ILanguageConfigurationService } from '../vs/editor/common/languages/languageConfigurationRegistry.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { Composition } from './composition.js';
import {
	ITextEditorProjectionSnapshot, ITextProjectionMappingSpan,
	TextEditorInputEvent, TextEditorProjectionGateway, textEditorSnapshot
} from './textProjection.js';
import { FoldState, TextEditorInputAction, TextView } from './textView.js';
import { VimMode } from './vimMode.js';
import { EditorFindSession } from './editorFind.js';
import type { ITextLayoutBackendFactory } from './textLayout.js';

export interface ITextEditorControllerOptions {
	readonly documentId: string;
	readonly resource: string;
	readonly width: number;
	readonly visibleRowCount: number;
	readonly wrap: boolean;
	readonly workingCopy: Pick<ITextFileEditorModel, 'isDirty' | 'onDidChangeDirty' | 'save' | 'revert'>;
	readonly focused?: boolean;
}

const FOLD: Record<FoldState, 'none' | 'expanded' | 'collapsed'> = {
	[FoldState.None]: 'none', [FoldState.Expanded]: 'expanded', [FoldState.Collapsed]: 'collapsed'
};

function color(value: Color | undefined): string | undefined {
	return value && Color.Format.CSS.formatHexA(value, true);
}

export class TextEditorController extends Disposable {
	readonly projection: TextEditorProjectionGateway;
	private readonly view: TextView;
	private readonly composition: Composition;
	private readonly find: EditorFindSession;
	private vim: VimMode | undefined;
	private vimListener: IDisposable | undefined;
	private generation = 1;
	private focused: boolean;
	private firstVisibleRow = 0;
	private visibleRowCount: number;
	private scrollColumn = 0;
	private width: number;
	private readonly metricsId: string;
	private wrap: boolean;
	private alive = true;

	constructor(
		readonly model: ITextModel,
		private readonly options: ITextEditorControllerOptions,
		layoutFactory: ITextLayoutBackendFactory,
		@IThemeService themeService: IThemeService,
		@ILanguageConfigurationService languageConfigurationService: ILanguageConfigurationService
	) {
		super();
		this.width = options.width;
		this.metricsId = layoutFactory.metricsId;
		this.visibleRowCount = options.visibleRowCount;
		this.wrap = options.wrap;
		this.focused = options.focused ?? true;
		this.view = this._register(new TextView(model, this.width, this.wrap, layoutFactory, themeService, languageConfigurationService));
		this.composition = this._register(new Composition(this.view));
		this.find = new EditorFindSession(model, this.view);
		this.view.setInputFocused(this.focused);
		this.projection = this._register(new TextEditorProjectionGateway(this.makeSnapshot(), event => this.handle(event)));
		this._register(this.view.onDidChange(() => this.publish()));
		this._register(model.onDidChangeContent(() => { this.find.refresh(); this.publish(); }));
		this._register(options.workingCopy.onDidChangeDirty(() => this.publish()));
	}

	async open(): Promise<void> {
		await this.view.open();
		if (!this.alive) { return; }
		this.publish();
	}

	async whenTokenized(): Promise<void> {
		await this.view.whenTokenized();
		if (this.alive) { this.publish(); }
	}

	setVim(enabled: boolean): void {
		if (enabled === !!this.vim) { return; }
		this.vimListener?.dispose(); this.vimListener = undefined;
		this.vim?.dispose(); this.vim = undefined;
		if (enabled) {
			this.vim = new VimMode(this.view, () => { void this.save(); }, () => queueMicrotask(() => {
				if (this.alive) { this.setVim(false); }
			}));
			this.vimListener = this.vim.onDidChange(() => this.publish());
		}
		this.publish();
	}
	get vimEnabled(): boolean { return !!this.vim; }
	get mode() { return this.vim?.mode; }
	handleKey(key: Parameters<VimMode['handleKey']>[0]): boolean { return this.vim?.handleKey(key) ?? false; }

	async save(): Promise<boolean> { return this.options.workingCopy.save(); }
	async revert(): Promise<void> { await this.options.workingCopy.revert(); }

	private publish(): void {
		if (this.alive) { this.projection.publish(this.makeSnapshot()); }
	}

	private makeSnapshot(): ITextEditorProjectionSnapshot {
		const totalRows = this.view.lineCount;
		const first = Math.max(0, Math.min(this.firstVisibleRow, Math.max(0, totalRows - 1)));
		const end = Math.min(totalRows, first + Math.max(1, this.visibleRowCount));
		const rows = [];
		for (let index = first; index < end; index++) {
			const spans = this.view.renderRow(index);
			const content = spans.map(span => span.text).join('');
			let runStart = 0;
			const runs = spans.map(span => {
				const run = { start: runStart, length: span.text.length, text: span.text, style: {
					foreground: color(span.fg), background: color(span.bg), bold: span.bold, italic: span.italic,
					underline: span.underline, strikethrough: span.strikethrough
				} };
				runStart += span.text.length;
				return run;
			});
			const mapping = this.withComposition(this.view.mappingForViewRow(index));
			const modelLine = this.view.modelLineAt(index);
			rows.push({
				id: `${this.options.documentId}#view:${index + 1}`,
				viewLineNumber: index + 1,
				modelLineNumber: modelLine,
				lineNumber: index === 0 || this.view.modelLineAt(index - 1) !== modelLine ? modelLine : undefined,
				fold: FOLD[this.view.foldStateAt(index)], content, runs, mapping,
				carets: this.view.caretsForViewLine(index + 1),
				selections: this.view.selectionsForViewLine(index + 1),
				searchMatches: this.vim?.highlights(content).map(match => ({ start: match.start, end: match.endExclusive })) ?? []
			});
		}
		this.view.publishViewport();
		const selections = this.view.selectionSnapshot.map(selection => ({
			anchor: selection.anchor, active: selection.active,
			offsets: { location: selection.location, length: selection.length }, primary: selection.primary
		}));
		const primary = selections.find(selection => selection.primary)?.active ?? { lineNumber: 1, column: 1 };
		return textEditorSnapshot({
			kind: 'text',
			generation: this.generation++, documentId: this.options.documentId, resource: this.options.resource,
			version: this.model.getVersionId(), languageId: this.view.languageId,
			readonly: this.view.viewModel.getEditorOption(EditorOption.readOnly), dirty: this.options.workingCopy.isDirty(), focused: this.focused,
			mode: this.vim?.mode ?? 'viewer',
			vim: this.vim && {
				pending: this.vim.pending,
				prompt: this.vim.openPrompt && { prefix: this.vim.openPrompt.prefix, value: this.vim.openPrompt.value },
				message: this.vim.message
			},
			selections, primaryCursor: primary, markedRange: this.composition.range,
			find: this.find.snapshot,
			primaryCursorView: { lineNumber: this.view.cursorRow + 1, column: (this.view.caretsForViewLine(this.view.cursorRow + 1).find(caret => caret.primary)?.column ?? 0) + 1 },
			rows, geometry: { metricsId: this.metricsId, width: this.width, wrap: this.wrap,
				firstVisibleRow: first, visibleRowCount: this.visibleRowCount, scrollColumn: this.scrollColumn, totalRows,
				modelLineCount: this.view.modelLineCount }
		});
	}

	/** Split a linear visible span only at composition edges; no per-code-unit mapping is retained. */
	private withComposition(spans: readonly ITextProjectionMappingSpan[]): readonly ITextProjectionMappingSpan[] {
		const marked = this.composition.range;
		if (!marked) { return spans; }
		const markedEnd = marked.location + marked.length;
		return spans.flatMap(span => {
			const from = Math.max(span.documentStart, marked.location);
			const to = Math.min(span.documentEnd, markedEnd);
			if (to <= from || span.viewEnd - span.viewStart !== span.documentEnd - span.documentStart) { return [span]; }
			const cuts = [span.documentStart, from, to, span.documentEnd].filter((value, index, all) => !index || value !== all[index - 1]);
			return cuts.slice(0, -1).map((start, index) => ({
				viewStart: span.viewStart + start - span.documentStart,
				viewEnd: span.viewStart + cuts[index + 1] - span.documentStart,
				documentStart: start, documentEnd: cuts[index + 1],
				kind: start >= from && cuts[index + 1] <= to ? 'composition' as const : span.kind,
				affinity: span.affinity
			}));
		});
	}

	private async handle(event: TextEditorInputEvent): Promise<void> {
		switch (event.kind) {
			case 'text': if (event.replacement) { this.view.selectOffsets(event.replacement, 'keyboard'); } this.composition.insertText(event.text); break;
			case 'composition':
				if (event.phase === 'update') { if (event.replacement) { this.view.selectOffsets(event.replacement, 'keyboard'); } this.composition.setMarkedText(event.text, event.selected); }
				else if (event.phase === 'commit') { event.text === undefined ? this.composition.unmark() : this.composition.insertText(event.text); }
				else { this.composition.setMarkedText('', { location: 0, length: 0 }); }
				break;
			case 'move': this.view.performInputAction(`${event.extend ? 'select-' : ''}${event.action}` as TextEditorInputAction); break;
			case 'command': this.view.performInputAction(event.action); break;
			case 'select-all': this.view.selectAllInput(); break;
			case 'select': this.view.setSelection({ startLineNumber: event.anchor.lineNumber, startColumn: event.anchor.column,
				endLineNumber: event.active.lineNumber, endColumn: event.active.column }, event.source); break;
			case 'pointer': {
				const row = this.projection.snapshot.rows.find(candidate => candidate.id === event.rowId);
				if (!row) { break; }
				if (event.action === 'toggle-fold') { this.view.toggleFoldAt(row.viewLineNumber - 1); break; }
				const span = row.mapping.find(candidate => event.column >= candidate.viewStart && event.column <= candidate.viewEnd);
				if (!span) { break; }
				const documentOffset = span.documentStart + Math.min(event.column - span.viewStart, span.documentEnd - span.documentStart);
				const position = this.model.getPositionAt(documentOffset);
				this.view.moveSelectionTo(position, event.extend, 'mouse'); break;
			}
			case 'key': this.vim?.handleKey({ ...event.key, sequence: event.key.sequence ?? event.key.char ?? '' }); break;
			case 'undo': await this.view.undo(); break;
			case 'redo': await this.view.redo(); break;
			case 'save': await this.save(); break;
			case 'find':
				if (event.action === 'open') { this.find.open(); }
				else if (event.action === 'query') { this.find.setQuery(event.query ?? ''); }
				else if (event.action === 'next') { this.find.next(); }
				else if (event.action === 'previous') { this.find.previous(); }
				else { this.find.close(); }
				break;
			case 'toggle-vim': this.setVim(!this.vimEnabled); break;
			case 'toggle-wrap': this.wrap = !this.wrap; this.view.setWrap(this.wrap); this.view.layout(this.width); this.publish(); break;
			case 'focus': this.focused = event.focused; this.view.setInputFocused(event.focused); this.publish(); break;
			case 'viewport':
				if (this.width === event.width && this.wrap === event.wrap
					&& this.firstVisibleRow === event.firstVisibleRow
					&& this.visibleRowCount === event.visibleRowCount
					&& this.scrollColumn === event.scrollColumn) { return; }
				this.width = event.width; this.wrap = event.wrap; this.firstVisibleRow = event.firstVisibleRow;
				this.visibleRowCount = event.visibleRowCount; this.scrollColumn = event.scrollColumn;
				this.view.setWrap(event.wrap); this.view.layout(event.width); this.publish(); break;
		}
		if (this.alive && event.kind !== 'focus' && event.kind !== 'viewport') { this.publish(); }
	}

	override dispose(): void {
		if (!this.alive) { return; }
		this.alive = false;
		this.vimListener?.dispose(); this.vim?.dispose();
		super.dispose();
	}
}
