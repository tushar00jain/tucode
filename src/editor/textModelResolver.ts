/*---------------------------------------------------------------------------------------------
 *  A URI, resolved to one of upstream's `TextModel`s.
 *
 *  `ITextModelService` is registered and cannot answer: both of its entry points build a
 *  `ResourceModelCollection`, which takes `ITextFileService` by constructor, and that is the wall
 *  T04 measured — `ITextFileService` → `IFileDialogService` → `IEditorService` → `EditorPart`. So
 *  the read is composed here out of the four pieces `AbstractTextFileService.readStream` and
 *  `BaseTextEditorModel.createTextEditorModel` are themselves made of:
 *
 *    `IFileService.readFileStream`  ▸  `toDecodeStream`  ▸  `createTextBufferFactoryFromStream`
 *                                                       ▸  `IModelService.createModel`
 *
 *  Nothing about the bytes, the encoding, the BOM, the line endings or the language association
 *  is decided here. `EncodingOracle` is the class the text file service itself uses to answer
 *  `overwriteEncoding`, and the language is `ILanguageService.createByFilepathOrFirstLine` over
 *  the first line the buffer factory reports, at `BaseTextEditorModel.getFirstLineText`'s own
 *  limit. What is missing is what the wall is actually about: dirty tracking, saving, backups and
 *  untitled files (§19.6).
 *
 *  The `git:` scheme resolves by the same path, which is what makes a diff's left-hand side an
 *  ordinary read: `TauriGitContribution` registers `TauriGitFileSystemProvider` with the file
 *  service, and `toGitUri` addresses a blob through it.
 *
 *  Upstream counterpart: src/vs/workbench/services/textmodelResolver/common/textModelResolverService.ts
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../vs/base/common/errors.js';
import { ResourceMap } from '../vs/base/common/map.js';
import { Disposable, DisposableMap, toDisposable } from '../vs/base/common/lifecycle.js';
import { URI } from '../vs/base/common/uri.js';
import { ITextModel, ModelConstants } from '../vs/editor/common/model.js';
import { createTextBufferFactoryFromStream } from '../vs/editor/common/model/textModel.js';
import { ILanguageService } from '../vs/editor/common/languages/language.js';
import { IModelService } from '../vs/editor/common/services/model.js';
import { ITextResourceConfigurationService } from '../vs/editor/common/services/textResourceConfiguration.js';
import { IFileService } from '../vs/platform/files/common/files.js';
import { IInstantiationService } from '../vs/platform/instantiation/common/instantiation.js';
import { EncodingOracle } from '../vs/workbench/services/textfile/browser/textFileService.js';
import { DecodeStreamError, DecodeStreamErrorKind, toDecodeStream, toEncodeReadable, UTF8 } from '../vs/workbench/services/textfile/common/encoding.js';
import { toBufferOrReadable } from '../vs/workbench/services/textfile/common/textfiles.js';

export class TextModelResolver extends Disposable {

	private readonly encoding = this._register(this.instantiationService.createInstance(EncodingOracle));

	/**
	 * The models this made, by resource. One model per resource, because
	 * `IModelService.createModel` refuses a resource that already has one and a pane reopening
	 * the same file is ordinary; the entry is dropped when the file under it changes, which is
	 * what keeps a stale read a miss rather than a wrong answer.
	 */
	private readonly models = this._register(new DisposableMap<URI>(new ResourceMap()));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITextResourceConfigurationService private readonly textResourceConfigurationService: ITextResourceConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		this._register(this.fileService.onDidFilesChange(event => {
			for (const resource of [...this.models.keys()]) {
				if (event.contains(resource)) {
					this.reload(resource);
				}
			}
		}));
	}

	/**
	 * A file that changed under a model already made from it is **read back into that model**, which
	 * is `TextFileEditorModel.doUpdateTextModel` — `IModelService.updateModel` over a fresh buffer
	 * factory, and upstream's one answer for an external edit.
	 *
	 * What this replaces is disposing the model, and the difference is not staleness: a pane that
	 * is *drawing* the model goes on drawing it, and `TextModel` throws `Model is disposed!` out of
	 * `getLineCount` for every read after the dispose. That throw comes out of `renderRow`, so it
	 * comes out of `Workbench.paint` — and an `Emitter` hands a listener's exception to
	 * `onUnexpectedError` rather than rethrowing it, so the app goes on taking keys while the frame
	 * never changes again. Upstream cannot reach the state at all: a model there is reference
	 * counted (`ResourceModelCollection`) and an open editor holds one of the references.
	 *
	 * A read that fails is a file that has gone, and the model keeps the text it had: disposing it
	 * is the defect above, and the next change event that reads is what puts it right again — a
	 * file deleted and written back reloads on the write.
	 */
	private async reload(resource: URI): Promise<void> {
		const model = this.modelService.getModel(resource);
		if (!model || model.isDisposed()) {
			return;
		}

		try {
			const factory = await this.read(resource);
			if (!model.isDisposed()) {
				this.modelService.updateModel(model, factory);
			}
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	async resolve(resource: URI): Promise<ITextModel> {
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}

		const factory = await this.read(resource);
		const language = this.languageService.createByFilepathOrFirstLine(resource, factory.getFirstLineText(ModelConstants.FIRST_LINE_DETECTION_LENGTH_LIMIT));
		const model = this.modelService.createModel(factory, language, resource);

		this.models.set(resource, toDisposable(() => model.dispose()));

		return model;
	}

	/**
	 * The model's text, written back to the file it was read from — `:w`.
	 *
	 * The same composition as `read` in the other direction, out of the pieces
	 * `AbstractTextFileService.write` and `getEncodedReadable` are themselves made of:
	 *
	 *     `EncodingOracle.getWriteEncoding`  ▸  `toEncodeReadable`  ▸  `IFileService.writeFile`
	 *
	 * Nothing about the encoding, the BOM or the line endings is decided here: the encoding is the
	 * one the oracle answers for this resource, and the snapshot carries the model's own EOL.
	 *
	 * **What upstream has and this does not is everything around the write**, and it is the same
	 * list `read`'s header ends with: no dirty tracking, no backup, no save participant, no
	 * conflict detection against the file's mtime, and no `onDidSave`. A write here is
	 * unconditional.
	 */
	async save(model: ITextModel): Promise<void> {
		const resource = model.uri;
		const { encoding, addBOM } = await this.encoding.getWriteEncoding(resource);
		const snapshot = model.createSnapshot();

		await this.fileService.writeFile(resource, encoding === UTF8 && !addBOM
			? toBufferOrReadable(snapshot)
			: await toEncodeReadable(snapshot, encoding, { addBOM }));
	}

	/**
	 * `AbstractTextFileService.readStream`, composed. `acceptTextOnly` is on because a viewer has
	 * nothing to show for a binary file, and the two guessing settings are read off the
	 * configuration keys the text file service reads them off.
	 */
	private async read(resource: URI) {
		const content = await this.fileService.readFileStream(resource);
		const decoded = await toDecodeStream(content.value, {
			acceptTextOnly: true,
			guessEncoding: this.textResourceConfigurationService.getValue(resource, 'files.autoGuessEncoding'),
			candidateGuessEncodings: this.textResourceConfigurationService.getValue(resource, 'files.candidateGuessEncodings'),
			overwriteEncoding: async detected => (await this.encoding.getPreferredReadEncoding(resource, undefined, detected ?? undefined)).encoding
		});

		return createTextBufferFactoryFromStream(decoded.stream);
	}
}

/** Whether a failed `resolve` failed because the file is not text, which a viewer reports rather than logs. */
export function isBinaryFile(error: unknown): boolean {
	return error instanceof DecodeStreamError && error.decodeStreamErrorKind === DecodeStreamErrorKind.STREAM_IS_BINARY;
}
