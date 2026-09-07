/*---------------------------------------------------------------------------------------------
 * Terminal content renderer hosted by upstream EditorPanes. This is the remaining text/diff
 * rendering adapter; tabs, activation, close confirmation and disposal are upstream lifecycle.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../vs/base/common/cancellation.js';
import { Emitter } from '../../vs/base/common/event.js';
import { DisposableStore } from '../../vs/base/common/lifecycle.js';
import { IEditorOptions, ITextEditorOptions } from '../../vs/platform/editor/common/editor.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../vs/platform/storage/common/storage.js';
import { ITelemetryService } from '../../vs/platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { EditorPane } from '../../vs/workbench/browser/parts/editor/editorPane.js';
import { EditorInput } from '../../vs/workbench/common/editor/editorInput.js';
import { DiffEditorInput } from '../../vs/workbench/common/editor/diffEditorInput.js';
import { IEditorOpenContext } from '../../vs/workbench/common/editor.js';
import { IEditorGroup } from '../../vs/workbench/services/editor/common/editorGroupsService.js';
import { WorkbenchEditorAreaResolver } from '../../editor/editorAreaResolver.js';
import { IEditorAreaChildProjectionSource, IEditorAreaResolvedChild, IEditorAreaTerminalOpenRequest } from '../../editor/editorContent.js';
import { PlatformEditorInput } from '../../editor/platformEditorInput.js';
import { EmbeddedRegionTerminalBackend } from '../terminal/embeddedRegionBackend.js';
import { CellTextLayoutBackendFactory } from './cellTextLayout.js';
import { MarkdownPreviewEditorInput } from '../../vs/workbench/contrib/markdown/tauri/markdownPreviewEditorInput.js';

export function editorContentKind(input: EditorInput | undefined) {
	return input instanceof MarkdownPreviewEditorInput ? 'markdown' : input instanceof PlatformEditorInput ? input.kind : input instanceof DiffEditorInput ? 'diff' : input ? 'text' : undefined;
}

export class TerminalContentEditorPane extends EditorPane {
	static readonly ID = 'tucode.terminalContentEditor';
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeContent = this.changed.event;
	private readonly resolver: WorkbenchEditorAreaResolver;
	private readonly contents = new Map<EditorInput, { promise: Promise<IEditorAreaResolvedChild>; store: DisposableStore; child?: IEditorAreaResolvedChild }>();
	private failure: string | undefined;
	get child(): IEditorAreaResolvedChild | undefined { return this.input ? this.contents.get(this.input)?.child : undefined; }
	get error(): string | undefined { return this.failure; }
	get idle(): boolean { return !this.input || !!this.child || !!this.failure; }

	constructor(group: IEditorGroup,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITelemetryService telemetry: ITelemetryService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService
	) {
		super(TerminalContentEditorPane.ID, group, telemetry, theme, storage);
		const backends = { create: (request: Readonly<IEditorAreaTerminalOpenRequest>) => new EmbeddedRegionTerminalBackend(request, instantiationService) };
		this.resolver = this._register(instantiationService.createInstance(WorkbenchEditorAreaResolver, backends, new CellTextLayoutBackendFactory()));
	}
	protected createEditor(parent: HTMLElement): void { parent.tabIndex = 0; }
	layout(): void { }
	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.failure = undefined;
		let content = this.contents.get(input);
		if (!content) {
			const store = new DisposableStore();
			const promise = (async () => {
				await input.resolve();
				if (input instanceof MarkdownPreviewEditorInput) { return this.resolver.resolveMarkdown(input.documentResource.toString()); }
				if (input instanceof PlatformEditorInput) {
					return this.resolver.resolveTerminal(input.terminalRequest!);
				}
				if (input instanceof DiffEditorInput) { return this.resolver.resolveDiff(input.original.resource!.toString(), input.modified.resource!.toString()); }
				return this.resolver.resolveText(input.resource!.toString(), options as ITextEditorOptions);
			})();
			content = { promise, store };
			this.contents.set(input, content);
			store.add(input.onWillDispose(() => { this.contents.delete(input); store.dispose(); }));
			const entry = content;
			void promise.then(child => {
				if (store.isDisposed) { child.dispose(); return; }
				entry.child = store.add(child);
				store.add(child.projection.onDidSnapshot(snapshot => {
					// A process exiting destroys its resource. EditorGroupView observes input disposal
					// and performs the close/active-neighbor lifecycle itself.
					if (snapshot.kind === 'terminal' && snapshot.exited) { input.dispose(); return; }
					if (this.input === input) { this.changed.fire(); }
				}));
			}, () => { });
		}
		try { await content.promise; }
		catch (error) { if (!token.isCancellationRequested) { this.failure = String(error); } }
		if (!token.isCancellationRequested) { this.setOptions(options); this.changed.fire(); }
	}
	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		const selection = (options as ITextEditorOptions | undefined)?.selection;
		const projection = this.child?.projection; const snapshot = projection?.snapshot;
		if (selection && snapshot?.kind === 'text') {
			(projection as IEditorAreaChildProjectionSource).dispatch({ kind: 'select', generation: snapshot.generation,
				documentId: snapshot.documentId, anchor: { lineNumber: selection.startLineNumber, column: selection.startColumn },
				active: { lineNumber: selection.endLineNumber ?? selection.startLineNumber,
					column: selection.endColumn ?? selection.startColumn }, source: 'programmatic' });
		}
	}
	override clearInput(): void { super.clearInput(); this.changed.fire(); }
	override focus(): void { this.getContainer()?.focus(); }
	async whenSettled(): Promise<void> {
		const content = this.input ? this.contents.get(this.input) : undefined;
		if (content) { await content.promise.then(child => child.whenSettled?.()); }
	}
	override dispose(): void { for (const value of this.contents.values()) { value.store.dispose(); } this.contents.clear(); super.dispose(); }
}
