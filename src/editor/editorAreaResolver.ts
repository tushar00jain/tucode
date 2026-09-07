/*---------------------------------------------------------------------------------------------
 * Remaining terminal content controllers, hosted by upstream editor panes.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../vs/base/common/lifecycle.js';
import { Emitter } from '../vs/base/common/event.js';
import { URI } from '../vs/base/common/uri.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../vs/workbench/services/textfile/common/textfiles.js';
import { TextModelResolver } from './textModelResolver.js';
import { DiffEditorController } from './diffEditorController.js';
import { IEditorAreaChildProjectionSource, IEditorAreaResolvedChild, IEditorAreaResolver, IEditorAreaTextOpenOptions } from './editorContent.js';
import { TextEditorController } from './textEditorController.js';
import { ITerminalEditorProjectionSource } from '../terminal/terminalProjection.js';
import { ITerminalEditorBackend, TerminalEditorController } from '../terminal/terminalEditorController.js';
import { IEditorAreaTerminalOpenRequest } from './editorContent.js';
import { IMarkdownProjectionSource, IResolvedMarkdownDocument, MarkdownController } from './markdownProjection.js';
import { IOpenerService } from '../vs/platform/opener/common/opener.js';
import type { ITextLayoutBackendFactory } from './textLayout.js';
import type { ITextModel } from '../vs/editor/common/model.js';

class ResolvedChild extends Disposable implements IEditorAreaResolvedChild {
	constructor(
		readonly projection: IEditorAreaChildProjectionSource | ITerminalEditorProjectionSource | IMarkdownProjectionSource,
		private readonly settledCallback?: () => Promise<void>,
		store?: DisposableStore,
		readonly textModel?: ITextModel
	) { super(); if (store) { this._register(store); } }
	whenSettled() { return this.settledCallback?.() ?? Promise.resolve(); }
}

export interface IEditorAreaTerminalBackendFactory {
	create(request: Readonly<IEditorAreaTerminalOpenRequest>): ITerminalEditorBackend;
}

/** Content-controller resolution only. EditorInput owns saving and group lifecycle. */
export class WorkbenchEditorAreaResolver extends Disposable implements IEditorAreaResolver {
	private readonly diffDocuments: TextModelResolver;
	constructor(
		private readonly terminalBackends: IEditorAreaTerminalBackendFactory | undefined,
		private readonly textLayouts: ITextLayoutBackendFactory,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IOpenerService private readonly openerService: IOpenerService
	) {
		super(); this.diffDocuments = this._register(instantiationService.createInstance(TextModelResolver));
	}

	async resolveTerminal(request: Readonly<IEditorAreaTerminalOpenRequest>): Promise<IEditorAreaResolvedChild> {
		if (!this.terminalBackends) { throw new Error('terminal editor backend unavailable'); }
		const store = new DisposableStore();
		const controller = store.add(new TerminalEditorController(request.id, this.terminalBackends.create(request)));
		await controller.open();
		return new ResolvedChild(controller.projection, () => controller.whenSettled(), store);
	}

	async resolveText(resource: string, options?: Readonly<IEditorAreaTextOpenOptions>): Promise<IEditorAreaResolvedChild> {
		const model = await this.textFileService.files.resolve(URI.parse(resource));
		if (!model.isResolved()) { throw new Error(`Text file model did not resolve for ${resource}`); }
		const store = new DisposableStore();
		const controller = this.instantiationService.createInstance(TextEditorController, model.textEditorModel, {
			// Upstream's default `editor.wordWrap` is off. Geometry comes from the frontend backend.
			documentId: resource, resource, width: this.textLayouts.initialWidth,
			visibleRowCount: this.textLayouts.initialVisibleRows, wrap: false,
			workingCopy: model
		}, this.textLayouts);
		store.add(controller);
		await controller.open();
		if (options?.selection) {
			const snapshot = controller.projection.snapshot;
			controller.projection.dispatch({ kind: 'select', generation: snapshot.generation, documentId: snapshot.documentId,
				anchor: { lineNumber: options.selection.startLineNumber, column: options.selection.startColumn },
				active: { lineNumber: options.selection.endLineNumber ?? options.selection.startLineNumber,
					column: options.selection.endColumn ?? options.selection.startColumn }, source: 'programmatic' });
		}
		// Model/folding readiness is the mount boundary. Syntax tokens intentionally arrive after
		// first paint (TextView publishes their repaint), so do not leave an already-selected tab on
		// the empty-area placeholder while a cold grammar/Oniguruma worker settles. Driven callers
		// can still await the same bounded tokenization work through the child's settlement contract.
		return new ResolvedChild(controller.projection,
			() => controller.whenTokenized(), store, model.textEditorModel);
	}

	async resolveMarkdown(resource: string): Promise<IEditorAreaResolvedChild> {
		const store = new DisposableStore();
		const backend = {
			resolve: async (target: string): Promise<IResolvedMarkdownDocument> => {
				const model = await this.textFileService.files.resolve(URI.parse(target));
				if (!model.isResolved()) { throw new Error(`Text file model did not resolve for ${target}`); }
				const changed = new Emitter<Readonly<{ version: number; content: string }>>(); let version = 1;
				const listener = model.onDidChangeContent(() => changed.fire(Object.freeze({ version: ++version, content: model.textEditorModel.getValue() })));
				return { version, content: model.textEditorModel.getValue(), onDidChange: changed.event, dispose() { listener.dispose(); changed.dispose(); } };
			},
			open: (target: string) => this.openerService.open(target, { fromUserGesture: true })
		};
		const controller = store.add(new MarkdownController(resource, resource, backend));
		await controller.open();
		return new ResolvedChild(controller.projection, () => controller.whenSettled(), store);
	}

	async resolveDiff(original: string, modified: string): Promise<IEditorAreaResolvedChild> {
		const [left, right] = await Promise.all([
			this.diffDocuments.resolve(URI.parse(original)), this.diffDocuments.resolve(URI.parse(modified))
		]);
		const store = new DisposableStore();
		const controller = store.add(this.instantiationService.createInstance(DiffEditorController, left, right, original, modified, this.textLayouts));
		await controller.open();
		return new ResolvedChild(controller.projection, () => controller.whenTokenized(), store);
	}

}
