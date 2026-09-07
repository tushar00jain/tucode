/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ActiveEditorContext, ResourceContextKey } from '../../../common/contextkeys.js';
import { EditorExtensions, EditorResourceAccessor, IEditorFactoryRegistry, SideBySideEditor } from '../../../common/editor.js';
import { ACTIVE_GROUP, IEditorService, PreferredGroup, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { MarkdownPreviewEditor } from './markdownPreviewEditor.js';
import { MarkdownPreviewEditorInput, MarkdownPreviewEditorInputSerializer } from './markdownPreviewEditorInput.js';
// The `markdownAlert-*` colours the rendered blockquotes read, and the stylesheet that reads
// them. Upstream imports both from this same file; nothing else in this port reaches it.
import '../browser/markdown.contribution.js';

const MARKDOWN_LANGUAGE_ID = 'markdown';

const category = localize2('markdown.category', "Markdown");

/** The document the command acts on: an explicit argument, else the active editor's resource. */
async function showPreview(accessor: ServicesAccessor, resource: URI | undefined, group: PreferredGroup): Promise<void> {
	const editorService = accessor.get(IEditorService);

	const documentResource = resource ?? EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
	if (!documentResource) {
		return;
	}

	await editorService.openEditor(new MarkdownPreviewEditorInput(documentResource), { pinned: true }, group);
}

class ShowPreviewAction extends Action2 {

	static readonly ID = 'markdown.showPreview';

	constructor() {
		super({
			id: ShowPreviewAction.ID,
			title: localize2('markdown.preview.title', "Open Preview"),
			category,
			icon: Codicon.preview,
			f1: true,
			precondition: ContextKeyExpr.equals(ResourceContextKey.LangId.key, MARKDOWN_LANGUAGE_ID),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
				when: ContextKeyExpr.and(EditorContextKeys.focus, ContextKeyExpr.equals(EditorContextKeys.languageId.key, MARKDOWN_LANGUAGE_ID)),
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}

	override run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		return showPreview(accessor, resource, ACTIVE_GROUP);
	}
}

class ShowPreviewToSideAction extends Action2 {

	static readonly ID = 'markdown.showPreviewToSide';

	constructor() {
		super({
			id: ShowPreviewToSideAction.ID,
			title: localize2('markdown.previewSide.title', "Open Preview to the Side"),
			category,
			icon: Codicon.openPreview,
			f1: true,
			precondition: ContextKeyExpr.equals(ResourceContextKey.LangId.key, MARKDOWN_LANGUAGE_ID),
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyV),
				when: ContextKeyExpr.and(EditorContextKeys.focus, ContextKeyExpr.equals(EditorContextKeys.languageId.key, MARKDOWN_LANGUAGE_ID)),
				weight: KeybindingWeight.WorkbenchContrib
			},
			menu: {
				// Upstream's `editor/title` `navigation@1` item, gated the way the preview tab
				// itself is excluded: its resource is a `markdown-preview:` URI of a `.md` path,
				// so `resourceLangId` says markdown there too.
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals(ResourceContextKey.LangId.key, MARKDOWN_LANGUAGE_ID),
					ActiveEditorContext.notEqualsTo(MarkdownPreviewEditor.ID)
				)
			}
		});
	}

	override run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		return showPreview(accessor, resource, SIDE_GROUP);
	}
}

registerAction2(ShowPreviewAction);
registerAction2(ShowPreviewToSideAction);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(MarkdownPreviewEditor, MarkdownPreviewEditor.ID, localize('markdownPreview.name', "Markdown Preview")),
		[new SyncDescriptor(MarkdownPreviewEditorInput)]
	);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(MarkdownPreviewEditorInput.ID, MarkdownPreviewEditorInputSerializer);
