/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension, getWindow, reset } from '../../../../base/browser/dom.js';
import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags, IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { MarkdownPreviewEditorInput } from './markdownPreviewEditorInput.js';
import { MarkedKatexSupport } from '../browser/markedKatexSupport.js';
// Upstream's preview stylesheet, copied by `copy-from-vscode.ps1` and confined to this pane by
// the `@scope` rule that copy is wrapped in. Ours comes second, so it wins where the two meet.
import '../../../../../extensions/markdown-language-features/media/markdown.css';
import './markdownPreview.css';

/**
 * How long the pane waits after the last edit before re-rendering. Typing produces one content
 * change per keystroke, and a re-render reparses the whole document.
 */
const RENDER_DEBOUNCE = 300;

/**
 * Paints a markdown document into the editor area through `IMarkdownRendererService` — the same
 * renderer, sanitizer and code-block tokenizer the hovers and the SCM input already use.
 */
export class MarkdownPreviewEditor extends EditorPane {

	static readonly ID = 'workbench.editor.markdownPreview';

	private content!: HTMLElement;
	private scrollbar!: DomScrollableElement;

	/** Held for as long as one input is set: the model reference and its change listener. */
	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly rendered = this._register(new MutableDisposable<IRenderedMarkdown>());
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.render(), RENDER_DEBOUNCE));

	private model: ITextModel | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService
	) {
		super(MarkdownPreviewEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = append(parent, $('.markdown-preview'));

		this.content = $('.markdown-preview-content', { tabindex: '0' });
		this.scrollbar = this._register(new DomScrollableElement(this.content, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Auto
		}));

		append(root, this.scrollbar.getDomNode());
	}

	override layout(dimension: Dimension): void {
		const node = this.scrollbar.getDomNode();
		node.style.width = `${dimension.width}px`;
		node.style.height = `${dimension.height}px`;

		this.scrollbar.scanDomNode();
	}

	override focus(): void {
		super.focus();

		this.content.focus();
	}

	override async setInput(input: MarkdownPreviewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		this.inputDisposables.clear();
		this.model = undefined;

		await MarkedKatexSupport.loadExtension(getWindow(this.content));
		if (token.isCancellationRequested) {
			return;
		}

		const reference = await this.textModelService.createModelReference(input.documentResource);
		if (token.isCancellationRequested) {
			reference.dispose();
			return;
		}
		this.inputDisposables.add(reference);

		this.model = reference.object.textEditorModel;
		this.inputDisposables.add(this.model.onDidChangeContent(() => this.renderScheduler.schedule()));

		this.render();
	}

	override clearInput(): void {
		this.renderScheduler.cancel();
		this.inputDisposables.clear();
		this.rendered.clear();
		this.model = undefined;
		reset(this.content);

		super.clearInput();
	}

	private render(): void {
		const input = this.input;
		if (!this.model || !(input instanceof MarkdownPreviewEditorInput)) {
			return;
		}

		// `baseUri` is what resolves relative links and images against the document's own
		// directory. The renderer decodes URL paths before resolving them and sends image
		// sources through `FileAccess.uriToBrowserUri` to the host's asset handler. Links
		// reach `IOpenerService` through the renderer service's default action handler.
		const markdown = new MarkdownString(this.model.getValue(), { supportHtml: true, supportThemeIcons: true, supportAlertSyntax: true });
		markdown.baseUri = input.documentResource;

		this.rendered.value = this.markdownRendererService.render(markdown, {
			markedExtensions: [MarkedKatexSupport.getExtension(getWindow(this.content))!],
			sanitizerConfig: MarkedKatexSupport.getSanitizerOptions({
				allowedTags: allowedMarkdownHtmlTags,
				allowedAttributes: allowedMarkdownHtmlAttributes
			}),
			asyncRenderCallback: () => this.scrollbar.scanDomNode()
		}, this.content);

		this.scrollbar.scanDomNode();
	}
}
