/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dispose, IDisposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditOperation, ISingleEditOperation } from '../../../../editor/common/core/editOperation.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { EndOfLineSequence, ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IProgress } from '../../../../platform/progress/common/progress.js';
import { IUndoRedoService, UndoRedoGroup, UndoRedoSource } from '../../../../platform/undoRedo/common/undoRedo.js';
import { SingleModelEditStackElement, MultiModelEditStackElement } from '../../../../editor/common/model/editStack.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { SnippetParser } from '../../../../editor/contrib/snippet/browser/snippetParser.js';
import { TextModelEditSource } from '../../../../editor/common/textModelEditSource.js';

type ValidationResult = { canApply: true } | { canApply: false; reason: URI };

type ISingleSnippetEditOperation = ISingleEditOperation & { insertAsSnippet?: boolean; keepWhitespace?: boolean };

class ModelEditTask implements IDisposable {

	readonly model: ITextModel;

	private _expectedModelVersionId: number | undefined;
	protected _edits: ISingleSnippetEditOperation[];
	protected _newEol: EndOfLineSequence | undefined;

	constructor(private readonly _modelReference: IReference<IResolvedTextEditorModel>) {
		this.model = this._modelReference.object.textEditorModel;
		this._edits = [];
	}

	dispose() {
		this._modelReference.dispose();
	}

	isNoOp() {
		if (this._edits.length > 0) {
			// contains textual edits
			return false;
		}
		if (this._newEol !== undefined && this._newEol !== this.model.getEndOfLineSequence()) {
			// contains an eol change that is a real change
			return false;
		}
		return true;
	}

	addEdit(resourceEdit: ResourceTextEdit): void {
		this._expectedModelVersionId = resourceEdit.versionId;
		const { textEdit } = resourceEdit;

		if (typeof textEdit.eol === 'number') {
			// honor eol-change
			this._newEol = textEdit.eol;
		}
		if (!textEdit.range && !textEdit.text) {
			// lacks both a range and the text
			return;
		}
		if (Range.isEmpty(textEdit.range) && !textEdit.text) {
			// no-op edit (replace empty range with empty text)
			return;
		}

		// create edit operation
		let range: Range;
		if (!textEdit.range) {
			range = this.model.getFullModelRange();
		} else {
			range = Range.lift(textEdit.range);
		}
		this._edits.push({ ...EditOperation.replaceMove(range, textEdit.text), insertAsSnippet: textEdit.insertAsSnippet, keepWhitespace: textEdit.keepWhitespace });
	}

	validate(): ValidationResult {
		if (typeof this._expectedModelVersionId === 'undefined' || this.model.getVersionId() === this._expectedModelVersionId) {
			return { canApply: true };
		}
		return { canApply: false, reason: this.model.uri };
	}

	getBeforeCursorState(): Selection[] | null {
		return null;
	}

	apply(reason?: TextModelEditSource): void {
		if (this._edits.length > 0) {
			this._edits = this._edits
				.map(this._transformSnippetStringToInsertText, this) // no editor -> no snippet mode
				.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
			this.model.pushEditOperations(null, this._edits, () => null, undefined, reason);
		}
		if (this._newEol !== undefined) {
			this.model.pushEOL(this._newEol);
		}
	}

	protected _transformSnippetStringToInsertText(edit: ISingleSnippetEditOperation): ISingleSnippetEditOperation {
		// transform a snippet edit (and only those) into a normal text edit
		// for that we need to parse the snippet and get its actual text, e.g without placeholder
		// or variable syntaxes
		if (!edit.insertAsSnippet) {
			return edit;
		}
		if (!edit.text) {
			return edit;
		}
		const text = SnippetParser.asInsertText(edit.text);
		return { ...edit, insertAsSnippet: false, text };
	}
}

export class BulkTextEdits {

	private readonly _edits = new ResourceMap<ResourceTextEdit[]>();

	constructor(
		private readonly _label: string,
		private readonly _code: string,
		// Not kept: `EditorEditTask` was the only reader and this fork cut it with the code editor.
		// The parameter stays so `bulkEditService.ts`'s positional `createInstance` is unchanged.
		_editor: ICodeEditor | undefined,
		private readonly _undoRedoGroup: UndoRedoGroup,
		private readonly _undoRedoSource: UndoRedoSource | undefined,
		private readonly _progress: IProgress<void>,
		private readonly _token: CancellationToken,
		edits: ResourceTextEdit[],
		@IModelService private readonly _modelService: IModelService,
		@ITextModelService private readonly _textModelResolverService: ITextModelService,
		@IUndoRedoService private readonly _undoRedoService: IUndoRedoService
	) {

		for (const edit of edits) {
			let array = this._edits.get(edit.resource);
			if (!array) {
				array = [];
				this._edits.set(edit.resource, array);
			}
			array.push(edit);
		}
	}

	private _validateBeforePrepare(): void {
		// First check if loaded models were not changed in the meantime
		for (const array of this._edits.values()) {
			for (const edit of array) {
				if (typeof edit.versionId === 'number') {
					const model = this._modelService.getModel(edit.resource);
					if (model && model.getVersionId() !== edit.versionId) {
						// model changed in the meantime
						throw new Error(`${model.uri.toString()} has changed in the meantime`);
					}
				}
			}
		}
	}

	private async _createEditsTasks(): Promise<ModelEditTask[]> {

		const tasks: ModelEditTask[] = [];
		const promises: Promise<any>[] = [];

		for (const [key, edits] of this._edits) {
			const promise = this._textModelResolverService.createModelReference(key).then(async ref => {
				const task: ModelEditTask = new ModelEditTask(ref);
				tasks.push(task);

				edits.forEach(task.addEdit, task);
			});
			promises.push(promise);
		}

		await Promise.all(promises);
		return tasks;
	}

	private _validateTasks(tasks: ModelEditTask[]): ValidationResult {
		for (const task of tasks) {
			const result = task.validate();
			if (!result.canApply) {
				return result;
			}
		}
		return { canApply: true };
	}

	async apply(reason?: TextModelEditSource): Promise<readonly URI[]> {

		this._validateBeforePrepare();
		const tasks = await this._createEditsTasks();

		try {
			if (this._token.isCancellationRequested) {
				return [];
			}

			const resources: URI[] = [];
			const validation = this._validateTasks(tasks);
			if (!validation.canApply) {
				throw new Error(`${validation.reason.toString()} has changed in the meantime`);
			}
			if (tasks.length === 1) {
				// This edit touches a single model => keep things simple
				const task = tasks[0];
				if (!task.isNoOp()) {
					const singleModelEditStackElement = new SingleModelEditStackElement(this._label, this._code, task.model, task.getBeforeCursorState());
					this._undoRedoService.pushElement(singleModelEditStackElement, this._undoRedoGroup, this._undoRedoSource);
					task.apply(reason);
					singleModelEditStackElement.close();
					resources.push(task.model.uri);
				}
				this._progress.report(undefined);
			} else {
				// prepare multi model undo element
				const multiModelEditStackElement = new MultiModelEditStackElement(
					this._label,
					this._code,
					tasks.map(t => new SingleModelEditStackElement(this._label, this._code, t.model, t.getBeforeCursorState()))
				);
				this._undoRedoService.pushElement(multiModelEditStackElement, this._undoRedoGroup, this._undoRedoSource);
				for (const task of tasks) {
					task.apply();
					this._progress.report(undefined);
					resources.push(task.model.uri);
				}
				multiModelEditStackElement.close();
			}

			return resources;

		} finally {
			dispose(tasks);
		}
	}
}
