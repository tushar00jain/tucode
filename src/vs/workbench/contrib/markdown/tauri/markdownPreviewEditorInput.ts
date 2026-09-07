/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/**
 * The scheme a preview tab is addressed by, encoded the way `scm/tauri/gitUri.ts` encodes its
 * baseline: the document's own URI with the scheme swapped and what the swap displaced kept in
 * `query`. A preview of `a.md` is therefore never the same resource as the text editor on
 * `a.md`, which is what keeps `EditorInput.matches`' untyped path from confusing the two.
 */
const MARKDOWN_PREVIEW_SCHEME = 'markdown-preview';

interface IMarkdownPreviewUriParams {
	readonly scheme: string;
	readonly query: string;
}

function toMarkdownPreviewUri(resource: URI): URI {
	const params: IMarkdownPreviewUriParams = { scheme: resource.scheme, query: resource.query };
	return resource.with({ scheme: MARKDOWN_PREVIEW_SCHEME, query: JSON.stringify(params) });
}

/**
 * A read-only preview of one markdown document. The document itself is never held here — the
 * pane resolves it through `ITextModelService` — so the input is nothing but the identity of
 * the tab, and `matches` is what makes that identity one per document.
 */
export class MarkdownPreviewEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.markdownPreviewInput';

	override get typeId(): string {
		return MarkdownPreviewEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	readonly resource: URI;

	constructor(readonly documentResource: URI) {
		super();

		this.resource = toMarkdownPreviewUri(documentResource);
	}

	override getName(): string {
		return localize('markdownPreview.title', "Preview {0}", basename(this.documentResource));
	}

	override getIcon(): ThemeIcon {
		return Codicon.openPreview;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof MarkdownPreviewEditorInput) {
			return isEqual(this.documentResource, other.documentResource);
		}

		return super.matches(other);
	}
}

export class MarkdownPreviewEditorInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): editor is MarkdownPreviewEditorInput {
		return editor instanceof MarkdownPreviewEditorInput;
	}

	serialize(editor: MarkdownPreviewEditorInput): string | undefined {
		if (!this.canSerialize(editor)) {
			return undefined;
		}

		return JSON.stringify(editor.documentResource.toJSON());
	}

	deserialize(_instantiationService: IInstantiationService, serializedEditor: string): EditorInput {
		return new MarkdownPreviewEditorInput(URI.revive(JSON.parse(serializedEditor)));
	}
}
