/*---------------------------------------------------------------------------------------------
 * Shared semantic owner for a unified text diff projection.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../vs/base/common/color.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { ITextModel } from '../vs/editor/common/model.js';
import { ILanguageConfigurationService } from '../vs/editor/common/languages/languageConfigurationRegistry.js';
import { IThemeService } from '../vs/platform/theme/common/themeService.js';
import { computeDiff, Side, unifiedRows } from './diffModel.js';
import { DiffEditorProjectionGateway, IDiffEditorProjectionSnapshot, diffEditorSnapshot, TextEditorInputEvent } from './textProjection.js';
import { TextView } from './textView.js';
import type { ITextLayoutBackendFactory } from './textLayout.js';

function css(value: Color | undefined) { return value && Color.Format.CSS.formatHexA(value, true); }

export class DiffEditorController extends Disposable {
	readonly projection: DiffEditorProjectionGateway;
	private readonly originalView: TextView;
	private readonly modifiedView: TextView;
	private generation = 1;
	private firstVisibleRow = 0;
	private visibleRowCount: number;
	private width: number;
	private readonly metricsId: string;
	private focused = false;
	private alive = true;

	constructor(
		private readonly originalModel: ITextModel,
		private readonly modifiedModel: ITextModel,
		private readonly originalResource: string,
		private readonly modifiedResource: string,
		layoutFactory: ITextLayoutBackendFactory,
		@IThemeService themeService: IThemeService,
		@ILanguageConfigurationService languageService: ILanguageConfigurationService
	) {
		super();
		this.width = layoutFactory.initialWidth;
		this.visibleRowCount = layoutFactory.initialVisibleRows;
		this.metricsId = layoutFactory.metricsId;
		this.originalView = this._register(new TextView(originalModel, this.width, false, layoutFactory, themeService, languageService));
		this.modifiedView = this._register(new TextView(modifiedModel, this.width, false, layoutFactory, themeService, languageService));
		this.projection = this._register(new DiffEditorProjectionGateway(this.snapshot(), event => this.handle(event)));
		this._register(this.originalView.onDidChange(() => this.publish()));
		this._register(this.modifiedView.onDidChange(() => this.publish()));
	}

	async open(): Promise<void> { await Promise.all([this.originalView.open(), this.modifiedView.open()]); if (this.alive) { this.publish(); } }
	async whenTokenized(): Promise<void> { await Promise.all([this.originalView.whenTokenized(), this.modifiedView.whenTokenized()]); if (this.alive) { this.publish(); } }

	private publish() { if (this.alive) { this.projection.publish(this.snapshot()); } }
	private snapshot(): IDiffEditorProjectionSnapshot {
		const arranged = unifiedRows(computeDiff(this.originalModel.getLinesContent(), this.modifiedModel.getLinesContent()), this.modifiedModel.getLineCount());
		const first = Math.min(this.firstVisibleRow, Math.max(0, arranged.length - 1));
		const records = arranged.slice(first, first + this.visibleRowCount).map((diff, visible) => {
			const view = diff.side === Side.Original ? this.originalView : this.modifiedView;
			const sourceDocumentId = diff.side === Side.Original ? this.originalResource : this.modifiedResource;
			const index = diff.lineNumber - 1;
			const sourceRuns = view.renderRow(index);
			let start = 0;
			const runs = sourceRuns.map(span => { const record = { start, length: span.text.length, text: span.text, style: {
				foreground: css(span.fg), background: css(span.bg), bold: span.bold, italic: span.italic,
				underline: span.underline, strikethrough: span.strikethrough } }; start += span.text.length; return record; });
			return {
				id: `${sourceDocumentId}#diff:${diff.lineNumber}:${first + visible}`, sourceDocumentId,
				side: diff.side === Side.Original ? 'original' as const : diff.side === Side.Modified ? 'modified' as const : 'unchanged' as const,
				marker: diff.side === Side.Original ? '-' as const : diff.side === Side.Modified ? '+' as const : ' ' as const,
				viewLineNumber: first + visible + 1, modelLineNumber: diff.lineNumber, lineNumber: diff.lineNumber,
				fold: 'none' as const, content: sourceRuns.map(run => run.text).join(''), runs,
				mapping: view.mappingForViewRow(index), carets: [], selections: [], searchMatches: [],
				decorations: [{ start: 0, end: start, kind: 'line' as const }, ...diff.highlights.map(range => ({ start: range.start, end: Math.min(start, range.endExclusive), kind: 'inner-change' as const }))]
			};
		});
		this.originalView.publishViewport(); this.modifiedView.publishViewport();
		return diffEditorSnapshot({ kind: 'diff', generation: this.generation++, documentId: `diff:${this.originalResource}::${this.modifiedResource}`,
			original: { documentId: this.originalResource, resource: this.originalResource, version: this.originalModel.getVersionId(), languageId: this.originalModel.getLanguageId() },
			modified: { documentId: this.modifiedResource, resource: this.modifiedResource, version: this.modifiedModel.getVersionId(), languageId: this.modifiedModel.getLanguageId() },
			focused: this.focused, rows: records, geometry: { metricsId: this.metricsId, width: this.width, wrap: false,
				firstVisibleRow: first, visibleRowCount: this.visibleRowCount, scrollColumn: 0, totalRows: arranged.length,
				modelLineCount: Math.max(this.originalModel.getLineCount(), this.modifiedModel.getLineCount()) } });
	}
	private handle(event: TextEditorInputEvent) {
		if (event.kind === 'viewport') {
			if (this.width === event.width && this.firstVisibleRow === event.firstVisibleRow
				&& this.visibleRowCount === event.visibleRowCount) { return; }
			this.width = event.width; this.firstVisibleRow = event.firstVisibleRow; this.visibleRowCount = event.visibleRowCount;
			this.originalView.layout(event.width); this.modifiedView.layout(event.width); this.publish();
		}
		else if (event.kind === 'focus') { this.focused = event.focused; this.publish(); }
	}
	override dispose() { this.alive = false; super.dispose(); }
}
