/*---------------------------------------------------------------------------------------------
 * Terminal painting and input translation over upstream editor parts, groups and panes.
 *--------------------------------------------------------------------------------------------*/
import { Color } from '../../vs/base/common/color.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { IProcessEnvironment } from '../../vs/base/common/platform.js';
import { URI } from '../../vs/base/common/uri.js';
import { localize } from '../../vs/nls.js';
import { ITextEditorOptions } from '../../vs/platform/editor/common/editor.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../vs/platform/terminal/common/terminal.js';
import { IColorTheme, IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { editorLineNumbers } from '../../vs/editor/common/core/editorColorRegistry.js';
import { editorBackground } from '../../vs/platform/theme/common/colors/editorColors.js';
import { EditorInput } from '../../vs/workbench/common/editor/editorInput.js';
import { EDITOR_GROUP_EMPTY_BACKGROUND, EDITOR_GROUP_HEADER_TABS_BACKGROUND, TAB_ACTIVE_BACKGROUND, TAB_ACTIVE_FOREGROUND, TAB_BORDER, TAB_INACTIVE_BACKGROUND, TAB_INACTIVE_FOREGROUND } from '../../vs/workbench/common/theme.js';
import { TerminalConfigurationService } from '../../vs/workbench/contrib/terminal/browser/terminalConfigurationService.js';
import { TEXT_FILE_EDITOR_ID } from '../../vs/workbench/contrib/files/common/files.js';
import { activeLineHighlight, renderDiffProjectionContent, renderTextProjectionContent } from '../../editor/textRender.js';
import { IDiffProjectionRow, ITextEditorProjectionSnapshot, ITextProjectionRow, TextEditorInputEvent, TextProjectionSnapshot } from '../../editor/textProjection.js';
import { lineRenderRecords, renderRecordsLine } from '../../render/domRecords.js';
import { blend, ILine, ISpan, IViewport, spanWidth } from '../terminal/screen.js';
import { IKey, IMouse } from '../terminal/input.js';
import { Pane } from '../workbench/pane.js';
import { PendingWork } from '../../vs/workbench/browser/tauri/pendingWork.js';
import { MarkdownInputEvent, IMarkdownProjectionSource } from '../../editor/markdownProjection.js';
import { textCursorRevealRow } from './projectionFocus.js';
import { IEditorGroupsService } from '../../vs/workbench/services/editor/common/editorGroupsService.js';
import { EditorParts } from '../../vs/workbench/browser/parts/editor/editorParts.js';


import { ACTIVE_GROUP, IEditorService, PreferredGroup } from '../../vs/workbench/services/editor/common/editorService.js';
import { OpenNextEditor, OpenPreviousEditor } from '../../vs/workbench/browser/parts/editor/editorActions.js';
import { IEditorAreaChildProjectionSource } from '../../editor/editorContent.js';
import { ITerminalEditorProjectionSource } from '../../terminal/terminalProjection.js';
import { vimKeyName } from '../../editor/vimKey.js';
import { vimConsumesKey } from '../../vs/workbench/contrib/vim/tauri/vimEditorPolicy.js';
import { keepReason } from '../../vs/workbench/services/keybinding/tauri/keyboardTakeover.js';
import { TerminalContentEditorPane, editorContentKind } from './contentEditorPane.js';
import { PlatformEditorInput } from '../../editor/platformEditorInput.js';
import { EditorExtensions, EditorsOrder } from '../../vs/workbench/common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../vs/workbench/browser/editor.js';
import { Registry } from '../../vs/platform/registry/common/platform.js';
import { SyncDescriptor } from '../../vs/platform/instantiation/common/descriptors.js';
import { FileEditorInput } from '../../vs/workbench/contrib/files/browser/editors/fileEditorInput.js';
import { TextResourceEditorInput } from '../../vs/workbench/common/editor/textResourceEditorInput.js';
import { DiffEditorInput } from '../../vs/workbench/common/editor/diffEditorInput.js';
import { onUnexpectedError } from '../../vs/base/common/errors.js';
import { MarkdownPreviewEditorInput } from '../../vs/workbench/contrib/markdown/tauri/markdownPreviewEditorInput.js';
import { ILanguageService } from '../../vs/editor/common/languages/language.js';
import { renderMarkdown } from './markdownRender.js';
import { IMarkdownSpan } from './markdownRows.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(TerminalContentEditorPane, TerminalContentEditorPane.ID, 'Terminal editor'),
	[new SyncDescriptor(FileEditorInput), new SyncDescriptor(TextResourceEditorInput), new SyncDescriptor(DiffEditorInput), new SyncDescriptor(PlatformEditorInput), new SyncDescriptor(MarkdownPreviewEditorInput)]
);

export const TAB_STRIP_ROWS = 1;
export const MARKDOWN_PREVIEW_EDITOR_ID = 'workbench.editor.markdownPreview';
const TAB_BORDER_GLYPH = '│';
const FOLD_GLYPH = { none: ' ', expanded: '⌄', collapsed: '›' } as const;

function color(value: string | undefined): Color | undefined {
	if (!value) { return undefined; }
	try { return Color.Format.CSS.parse(value) ?? undefined; } catch { return undefined; }
}

class ProjectionPane extends Pane {
	override keybindingTarget(): HTMLElement | undefined { return this.area.content?.getContainer(); }
	private previousText: TextProjectionSnapshot | undefined;
	private readonly configuration: TerminalConfigurationService;
	private markdownRows: ILine[] = [];
	private markdownRender: { source: IMarkdownProjectionSource; tokens: IMarkdownProjectionSource['snapshot']['tokens']; width: number; theme: IColorTheme } | undefined;
	constructor(private readonly area: EditorArea, private readonly viewport: IViewport,
		@IThemeService themeService: IThemeService, @IInstantiationService instantiationService: IInstantiationService,
		@ILanguageService private readonly languages: ILanguageService) {
		super(themeService);
		this.configuration = this._register(instantiationService.createInstance(TerminalConfigurationService));
		this._register(area.onDidChange(() => {
			if (this.markdownRender && this.markdownRender.source !== this.area.content?.child?.projection) {
				this.markdownRender = undefined; this.markdownRows = [];
			}
			const text = this.text;
			const reveal = textCursorRevealRow(this.previousText, text);
			this.previousText = text;
			this.didChangeRows(undefined, false);
			if (reveal !== undefined) { this.focusTo(reveal); }
		}));
	}
	private get snapshot() { return this.area.content?.child?.projection.snapshot; }
	private get text() { const value = this.snapshot; return value?.kind === 'text' || value?.kind === 'diff' ? value : undefined; }
	private get terminal() { const value = this.snapshot; return value?.kind === 'terminal' ? value : undefined; }
	private get markdown() { const value = this.snapshot; return value?.kind === 'markdown' ? value : undefined; }

	get title(): string { return this.area.activeEditor?.getName() ?? localize('editorArea.empty', "No editor open"); }
	get viewId(): string { return this.markdown ? MARKDOWN_PREVIEW_EDITOR_ID : this.area.activeKind === 'text' ? TEXT_FILE_EDITOR_ID : this.area.content?.getId() ?? TEXT_FILE_EDITOR_ID; }
	get rowCount(): number {
		return this.text?.geometry.totalRows ?? this.terminal?.content.length ?? (this.markdown ? Math.max(1, this.markdownRows.length) : this.area.content?.error ? 1 : 0);
	}
	override get editing(): boolean {
		return !!this.terminal ? !this.terminal!.exited : this.text?.kind === 'text' && this.text.mode !== 'viewer';
	}
	override get hint(): string | undefined {
		if (!!this.terminal) { return this.terminal!.exited
			? localize('terminalEditorPane.exited', "process exited ({0})", this.terminal!.exitCode ?? 0)
			: localize('terminalEditorPane.attached', "keys go to the process"); }
		const text = this.text;
		if (text?.kind !== 'text' || !text.vim) { return undefined; }
		return text.vim.prompt ? `${text.vim.prompt.prefix}${text.vim.prompt.value}`
			: localize('filePane.vim', "vim: {0}{1} — :q to leave", text.mode, text.vim.pending ? ` ${text.vim.pending}` : '');
	}
	override takesKey(commandId: () => string | undefined, key?: IKey): boolean {
		if (!this.editing) { return false; }
		if (!!this.terminal && this.configuration.config.sendKeybindingsToShell) { return true; }
		if (this.text?.kind === 'text' && key) { return !key.meta && vimConsumesKey(this.text.mode, vimKeyName(key), commandId, id => !!id && keepReason({ command: id, when: undefined }) !== undefined); }
		const id = commandId(); return !id || !this.configuration.shouldCommandSkipShell(id);
	}
	override handleKey(key: IKey): boolean {
		if (!!this.terminal) { return this.dispatchTerminal({ kind: 'key', sequence: key.sequence }); }
		if (this.text?.kind === 'text' && this.text.mode !== 'viewer') { return this.dispatchText({ kind: 'key', key }); }
		return super.handleKey(key);
	}
	override handlePaste(text: string): boolean {
		return !!this.terminal ? this.dispatchTerminal({ kind: 'paste', text }) : super.handlePaste(text);
	}
	override handleMouse(mouse: IMouse, top: number): boolean {
		const handled = super.handleMouse(mouse, top); const projection = this.text;
		if (handled && mouse.kind === 'down' && projection) {
			const row = projection.rows.find(candidate => candidate.viewLineNumber === this.focus + 1);
			if (row) { this.dispatchText({ kind: 'pointer', action: 'place-caret', rowId: row.id, column: Math.max(0, mouse.col), extend: !!mouse.shift }); }
		}
		if (handled && mouse.kind === 'down' && this.markdown) {
			let column = 0;
			for (const span of (this.markdownRows[this.focus] ?? []) as readonly IMarkdownSpan[]) {
				const length = spanWidth(span.text);
				if (span.href && mouse.col >= column && mouse.col < column + length) { return this.dispatchMarkdown({ kind: 'open-link', linkId: span.href }); }
				column += length;
			}
		}
		return handled;
	}
	toggleFold(): boolean {
		const projection = this.text;
		const row = projection?.rows.find(candidate => candidate.viewLineNumber === this.focus + 1);
		return !!row && this.dispatchText({ kind: 'pointer', action: 'toggle-fold', rowId: row.id, column: 0, extend: false });
	}
	override layout(height: number): ILine[] {
		if (this.terminal) { this.dispatchTerminal({ kind: 'viewport', columns: Math.max(1, this.viewport.cols), rows: Math.max(1, height) }); }
		// The projection window follows the scrolled viewport, not the keyboard row. Using `focus`
		// here dropped every still-visible row above a Vim caret from the shared snapshot.
		else if (this.text) { this.dispatchText({ kind: 'viewport', width: Math.max(1, this.viewport.cols),
			wrap: this.text.kind === 'text' && this.text.geometry.wrap, firstVisibleRow: this.firstVisibleRow,
			visibleRowCount: Math.max(1, height), scrollColumn: 0 }); }
		else if (this.markdown) {
			const { tokens } = this.markdown; const width = Math.max(1, this.viewport.cols); const theme = this.themeService.getColorTheme();
			if (this.markdownRender?.tokens !== tokens || this.markdownRender.width !== width || this.markdownRender.theme !== theme) {
				const source = this.area.content!.child!.projection as IMarkdownProjectionSource;
				const request = this.markdownRender = { source, tokens, width, theme };
				this.track(renderMarkdown(tokens, width, theme, this.languages).then(rows => {
					if (this._store.isDisposed || this.markdownRender !== request || this.area.content?.child?.projection !== source || this.markdown?.tokens !== tokens) { return; }
					this.markdownRows = rows; this.didChangeRows(undefined, false);
				}).catch(onUnexpectedError));
			}
			this.dispatchMarkdown({ kind: 'viewport', firstVisibleRow: this.firstVisibleRow, visibleRowCount: Math.max(1, height) });
		}
		return super.layout(height, this.viewport.cols);
	}
	protected renderRow(index: number, focused: boolean): ILine {
		if (this.area.content?.error) { return [{ text: this.area.content.error }]; }
		if (!this.snapshot) { return []; }
		if (this.markdown) {
			const markdown = this.markdown;
			if (markdown.status !== 'ready') { return [{ text: ` ${markdown.status === 'loading' ? localize('editorArea.markdownLoading', "Loading…") : markdown.error ?? localize('editorArea.markdownFailure', "Markdown preview failed")}` }]; }
			const row = this.markdownRows[index] ?? [];
			const background = focused ? blend(activeLineHighlight(this.themeService), this.themeService.getColorTheme().getColor(editorBackground)) : undefined;
			return row.map(span => span.bg ? span : { ...span, bg: background });
		}
		if (this.terminal) {
			const row = this.terminal.content[index];
			return row ? this.records(row.runs.map(run => ({ text: run.text, fg: color(run.foreground), bg: color(run.background), bold: run.bold, italic: run.italic, underline: run.underline }))) : [];
		}
		const projection = this.text; const row = projection?.rows.find(candidate => candidate.viewLineNumber === index + 1);
		if (!projection || !row) { return []; }
		return projection.kind === 'diff' ? this.diffRow(row as IDiffProjectionRow, projection.geometry.modelLineCount, focused)
			: this.textRow(row, projection, focused);
	}
	private textRow(row: ITextProjectionRow, projection: ITextEditorProjectionSnapshot, focused: boolean): ILine {
		const theme = this.themeService.getColorTheme(); const background = focused ? blend(activeLineHighlight(this.themeService), theme.getColor(editorBackground)) : undefined;
		const gutterWidth = String(projection.geometry.modelLineCount).length;
		const gutter: ISpan = { text: `${row.lineNumber ? String(row.lineNumber).padStart(gutterWidth) : ' '.repeat(gutterWidth)}${FOLD_GLYPH[row.fold]} `,
			fg: theme.getColor(editorLineNumbers), bg: background };
		return this.records([gutter, ...renderTextProjectionContent(row, projection, this.themeService, background)]);
	}
	private diffRow(row: IDiffProjectionRow, lineCount: number, focused: boolean): ILine {
		const rendered = renderDiffProjectionContent(row, this.themeService, focused);
		return this.records([{ text: `${String(row.lineNumber ?? '').padStart(String(lineCount).length)}${row.marker} `, bg: rendered.background },
			...rendered.spans]);
	}
	private records(line: ILine): ILine { return renderRecordsLine(lineRenderRecords(line)) as ILine; }
	override dispose(): void { this.markdownRender = undefined; this.markdownRows = []; super.dispose(); }
	private dispatchText(event: TextEditorInputEvent extends infer E ? E extends TextEditorInputEvent ? Omit<E, 'generation' | 'documentId'> : never : never): boolean {
		const child = this.text; const projection = this.area.content?.child?.projection;
		return !!child && !!projection && (projection as IEditorAreaChildProjectionSource).dispatch({ ...event, generation: child.generation, documentId: child.documentId } as TextEditorInputEvent);
	}
	private dispatchMarkdown(event: MarkdownInputEvent extends infer E ? E extends MarkdownInputEvent ? Omit<E, 'generation' | 'documentId'> : never : never): boolean {
		const child = this.markdown; const projection = this.area.content?.child?.projection;
		return !!child && !!projection && (projection as IMarkdownProjectionSource).dispatch({ ...event, generation: child.generation, documentId: child.documentId } as MarkdownInputEvent);
	}
	private dispatchTerminal(event: { readonly kind: 'key'; readonly sequence: string } | { readonly kind: 'paste'; readonly text: string } | { readonly kind: 'viewport'; readonly columns: number; readonly rows: number }): boolean {
		const child = this.terminal; const projection = this.area.content?.child?.projection;
		return !!child && !!projection && (projection as ITerminalEditorProjectionSource).dispatch({ ...event, generation: child.generation, terminalId: child.terminalId });
	}
}

export class EditorArea extends Disposable {
	private readonly projectionPane: ProjectionPane;
	private readonly changedEmitter = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this.changedEmitter.event;
	readonly onDidRequestPaint: Event<void>;
	readonly groups: EditorParts;
	private readonly editorService: IEditorService;
	cols = 0;
	private terminalSequence = 0;
	private focused = false;
	private readonly pending = this._register(new PendingWork('editor-area-command'));
	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService, @IThemeService private readonly themeService: IThemeService) {
		super();
		this.groups = instantiationService.invokeFunction(accessor => accessor.get(IEditorGroupsService)) as EditorParts;
		this._register(this.groups);
		this.editorService = instantiationService.invokeFunction(accessor => accessor.get(IEditorService));
		// Quick access and Explorer call the real service directly. Observe that promise as well
		// as terminal commands so the input handshake cannot finish before upstream pane focus.
		const openEditor = this.editorService.openEditor;
		this.editorService.openEditor = ((...args: Parameters<IEditorService['openEditor']>) =>
			this.pending.track(openEditor.apply(this.editorService, args))) as IEditorService['openEditor'];
		this._register({ dispose: () => { this.editorService.openEditor = openEditor; } });
		this.groups.mainPart.create(document.createElement('div'), { restorePreviousState: false });
		this.groups.mainPart.layout(1, 1, 0, 0);
		this.projectionPane = this._register(instantiationService.createInstance(ProjectionPane, this, this as IViewport));
		// Native render completion invalidates paint, not document content. Feeding this back
		// into onDidChange would make ProjectionPane's content listener invalidate itself.
		this.onDidRequestPaint = this.projectionPane.onDidChange;
		this._register(this.editorService.onDidEditorsChange(() => this.changedEmitter.fire()));
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const content = this.content;
			if (content && !this.observed.has(content)) {
				this.observed.add(content); this._register(content.onDidChangeContent(() => this.changedEmitter.fire()));
			}
			this.changedEmitter.fire();
		}));
	}
	private readonly observed = new WeakSet<TerminalContentEditorPane>();
	get content(): TerminalContentEditorPane | undefined { const pane = this.groups.activeGroup.activeEditorPane; return pane instanceof TerminalContentEditorPane ? pane : undefined; }
	get pane(): Pane | undefined { return this.count ? this.projectionPane : undefined; }
	get activeEditor(): EditorInput | undefined { return this.editorService.activeEditor; }
	get editors(): readonly EditorInput[] { return this.editorService.editors; }
	get count(): number { return this.editorService.count; }
	get idle(): boolean { return this.pending.idle && (!this.content || this.content.idle) && this.projectionPane.idle; }
	async whenSettled(): Promise<void> { await this.pending.whenSettled(); await this.content?.whenSettled(); await this.projectionPane.whenSettled(); }
	track(work: Promise<unknown>): void { this.pending.track(work); }
	get activeResource(): URI | undefined { return this.activeEditor?.resource; }
	get activeKind() { return editorContentKind(this.activeEditor); }
	setFocused(focused: boolean): boolean {
		if (this.focused === focused) { return false; }
		this.focused = focused;
		if (focused) { this.groups.activeGroup.focus(); }
		else {
			const active = document.activeElement;
			if (active instanceof HTMLElement && this.content?.getContainer()?.contains(active)) { active.blur(); }
		}
		const projection = this.content?.child?.projection; const snapshot = projection?.snapshot;
		if (snapshot && projection) {
			if (snapshot.kind === 'terminal') { (projection as ITerminalEditorProjectionSource).dispatch({ kind: 'focus', focused, generation: snapshot.generation, terminalId: snapshot.terminalId }); }
			else if (snapshot.kind === 'markdown') { (projection as IMarkdownProjectionSource).dispatch({ kind: 'focus', focused, generation: snapshot.generation, documentId: snapshot.documentId }); }
			else { (projection as IEditorAreaChildProjectionSource).dispatch({ kind: 'focus', focused, generation: snapshot.generation, documentId: snapshot.documentId }); }
		}
		return true;
	}
	private async opened(work: Promise<unknown>): Promise<void> { this.track(work); await work; }
	async openFile(resource: URI, options?: ITextEditorOptions): Promise<void> { await this.opened(this.editorService.openEditor({ resource, options })); }
	async openMarkdownPreview(resource: URI, group: PreferredGroup = ACTIVE_GROUP): Promise<void> {
		await this.opened(this.editorService.openEditor(new MarkdownPreviewEditorInput(resource), { pinned: true }, group));
	}
	async openMarkdownSource(): Promise<void> {
		const input = this.activeEditor;
		if (input instanceof MarkdownPreviewEditorInput) {
			await this.opened(this.editorService.openEditor({ resource: input.documentResource }, ACTIVE_GROUP));
		}
	}
	async openDiff(original: URI, modified: URI, label?: string): Promise<void> { await this.opened(this.editorService.openEditor({ original: { resource: original }, modified: { resource: modified }, label })); }
	async openTerminal(launch: IShellLaunchConfig, cwd: string, env: IProcessEnvironment, label: string): Promise<void> {
		await this.opened(this.editorService.openEditor(new PlatformEditorInput('terminal', undefined, { id: 'tui-terminal:' + ++this.terminalSequence, label, executable: launch.executable,
			args: Array.isArray(launch.args) ? launch.args.map(String) : undefined, cwd, env: { ...env } })));
	}
	closeActive(): void { this.track(this.groups.activeGroup.closeEditor().catch(onUnexpectedError)); }
	focusEditorBy(delta: number): void {
		const action = delta > 0 ? new OpenNextEditor() : new OpenPreviousEditor();
		this.track(this.instantiationService.invokeFunction(accessor => action.run(accessor)).catch(onUnexpectedError));
	}
	handleKey(key: IKey): boolean { return this.projectionPane.handleKey(key); }
	toggleFold(): boolean { return this.projectionPane.toggleFold(); }
	handleMouse(mouse: IMouse, top: number): boolean {
		if (mouse.row !== top) { return this.projectionPane.handleMouse(mouse, top + TAB_STRIP_ROWS); }
		if (mouse.kind !== 'down') { return false; }
		let column = 0;
		for (const input of this.groups.activeGroup.getEditors(EditorsOrder.SEQUENTIAL)) {
			column += input.getName().length + (input.isDirty() ? 5 : 3);
			if (mouse.col < column) { this.track(this.groups.activeGroup.openEditor(input).catch(onUnexpectedError)); return true; }
		}
		return false;
	}
	tabStrip(): ILine {
		const theme = this.themeService.getColorTheme(); const container = theme.getColor(EDITOR_GROUP_HEADER_TABS_BACKGROUND); const spans: ISpan[] = [];
		const group = this.groups.activeGroup;
		for (const input of group.getEditors(EditorsOrder.SEQUENTIAL)) {
			const active = group.activeEditor === input;
			spans.push({ text: ' ' + input.getName() + (input.isDirty() ? ' •' : '') + ' ', fg: theme.getColor(active ? TAB_ACTIVE_FOREGROUND : TAB_INACTIVE_FOREGROUND), bg: theme.getColor(active ? TAB_ACTIVE_BACKGROUND : TAB_INACTIVE_BACKGROUND) });
			spans.push({ text: TAB_BORDER_GLYPH, fg: theme.getColor(TAB_BORDER), bg: container });
		}
		if (!spans.length) { spans.push({ text: ' ' + localize('editorArea.empty', 'No editor open'), fg: theme.getColor(TAB_INACTIVE_FOREGROUND), bg: container }); }
		spans.push({ text: ' '.repeat(Math.max(0, this.cols)), bg: container }); return renderRecordsLine(lineRenderRecords(spans)) as ILine;
	}
	lines(height: number): ILine[] {
		this.groups.mainPart.layout(this.cols, height + TAB_STRIP_ROWS, 0, 0);
		return this.pane ? this.projectionPane.layout(height) : [[{ text: ' ' + localize('editorArea.nothing', 'Open a file from the side bar') }]];
	}
	get background(): Color | undefined { const theme = this.themeService.getColorTheme(); return theme.getColor(this.count ? editorBackground : EDITOR_GROUP_EMPTY_BACKGROUND) ?? theme.getColor(editorBackground); }
	dispatchCommand(command: 'save' | 'revert' | 'undo' | 'redo' | 'select-all' | 'toggle-vim' | 'toggle-wrap'): boolean {
		const input = this.activeEditor; if (!input) { return false; }
		if (command === 'save') { this.track(this.editorService.save({ editor: input, groupId: this.groups.activeGroup.id })); return true; }
		if (command === 'revert') { this.track(this.editorService.revert({ editor: input, groupId: this.groups.activeGroup.id })); return true; }
		const projection = this.content?.child?.projection; const snapshot = projection?.snapshot;
		return !!projection && !!snapshot && snapshot.kind === 'text' && (projection as IEditorAreaChildProjectionSource).dispatch({ kind: command, generation: snapshot.generation, documentId: snapshot.documentId });
	}
}
