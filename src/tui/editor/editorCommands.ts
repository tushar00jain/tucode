/*---------------------------------------------------------------------------------------------
 *  The keys an open file answers, and the two commands that open one.
 *
 *  `vscode.open` and `vscode.diff` are `openCommands.ts`'s and are imported rather than declared
 *  here: they are the same two commands on either frontend, over an area with the same two methods.
 *  What is this file's is the four keys, which are a terminal's.
 *
 *  Nothing here decides *what* to open or which side of a diff is which. `TauriGitResource` — the
 *  port of upstream's `ResourceCommandResolver` — already builds a `Command` per row: `vscode.diff`
 *  with the `git:` baseline and the working-tree file for a change, `vscode.open` for a resource
 *  that has no left-hand side, and `git.openChange`, `git.openFile` and `git.openHEADFile` are
 *  registered in `git.contribution.ts` and dispatch to those two ids. Every one of them was a
 *  `command not found` until this file existed.
 *
 *  So this is the seam, not a feature: two commands with upstream's own argument shapes, handed to
 *  the editor area, which decides whether that is a new tab or an existing one brought forward.
 *
 *  The fold and wrap keys are declared once here. A command dispatched to the active editor is
 *  also what upstream does with
 *  `editor.action.*`: the rule names the editor, not an instance of it.
 *
 *  Upstream counterpart: src/vs/workbench/browser/parts/editor/editorCommands.ts, src/vs/workbench/contrib/files/browser/fileCommands.ts
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../vs/base/common/errors.js';
import { KeyChord, KeyCode, KeyMod } from '../../vs/base/common/keyCodes.js';
import { combinedDisposable, IDisposable } from '../../vs/base/common/lifecycle.js';
import { localize } from '../../vs/nls.js';
import { ContextKeyExpr } from '../../vs/platform/contextkey/common/contextkey.js';
import { ResourceContextKey } from '../../vs/workbench/common/contextkeys.js';
import { TEXT_FILE_EDITOR_ID } from '../../vs/workbench/contrib/files/common/files.js';
import { registerPaneCommand } from '../workbench/commands.js';
import { registerOpenCommands } from '../../editor/editorCommands.js';
import { EditorArea, MARKDOWN_PREVIEW_EDITOR_ID } from './editorArea.js';
import { SIDE_GROUP } from '../../vs/workbench/services/editor/common/editorService.js';

/** The language `markdown.showPreview`'s precondition names, as upstream's contribution names it. */
const MARKDOWN_LANGUAGE_ID = 'markdown';

/**
 * The two commands, registered against the editor area that answers them.
 *
 * `reveal` moves keyboard focus to the editor area, which is what opening an editor does in
 * tscode unless the caller asked for `preserveFocus`; `main.ts` supplies it, because the parts a
 * focus can be in are the workbench's business rather than the area's.
 */
export function registerEditorCommands(editors: EditorArea, reveal: () => void): IDisposable {
	/** The active projected resource, when it is a text editor. */
	const activeFile = () => editors.activeKind === 'text' ? editors.activeResource : undefined;

	return combinedDisposable(
		// The two commands themselves, which are the same on either frontend.
		registerOpenCommands(editors, reveal),
		registerPaneCommand(TEXT_FILE_EDITOR_ID, {
			id: 'tscode.file.toggleFold',
			title: localize('tscode.file.toggleFold', "Fold"),
			primary: KeyCode.KeyF,
			handler: () => editors.toggleFold()
		}),
		// Not `E`, which is `tscode.editFile` and stays it: handing the file to `$EDITOR` gives the
		// user the editor they already configured, and nothing in this fork will match that (§19).
		// In-app editing is a second way to edit rather than a replacement for the first, so it
		// takes a key of its own. `V` for vim, and it is the only letter left that no *unscoped*
		// rule answers — `I` is `tscode.editInput` and `T` and `Q` are global.
		registerPaneCommand(TEXT_FILE_EDITOR_ID, {
			id: 'tscode.file.edit',
			title: localize('tscode.file.edit', "Vim"),
			primary: KeyCode.KeyV,
			handler: () => editors.dispatchCommand('toggle-vim')
		}),
		// **Upstream's command id at a key of ours, and the key is the divergence.** Upstream binds
		// `markdown.showPreview` to `Ctrl+Shift+V`, which is *byte-identical to `Ctrl+V`* on the
		// wire (§5) — the same wall `Ctrl+Shift+P` hit — and `Ctrl+V` is already vim's. Its sibling
		// `markdown.showPreviewToSide` is `Ctrl+K V`, a chord this fork's resolver would deliver,
		// so this terminal uses `P`, scoped to the file editor the way `F`, `V` and `W` are, and it
		// is in the keys overlay because `registerPaneCommand` declares it there.
		//
		// The precondition is upstream's own, verbatim: `resourceLangId == markdown`, which
		// `Workbench` publishes through upstream's `ResourceContextKey` — so the key is offered on a
		// `.md` tab and on no other, which is what keeps the overlay a list of keys that work.
		registerPaneCommand(TEXT_FILE_EDITOR_ID, {
			id: 'markdown.showPreview',
			title: localize('markdown.preview.title', "Open Preview"),
			primary: KeyCode.KeyP,
			when: ContextKeyExpr.equals(ResourceContextKey.LangId.key, MARKDOWN_LANGUAGE_ID),
			handler: () => {
				const resource = activeFile();
				if (resource) {
					reveal();
					editors.track(editors.openMarkdownPreview(resource).catch(onUnexpectedError));
				}
			}
		}),
		registerPaneCommand(TEXT_FILE_EDITOR_ID, {
			id: 'markdown.showPreviewToSide',
			title: localize('markdown.previewSide.title', "Open Preview to the Side"),
			primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyV),
			when: ContextKeyExpr.equals(ResourceContextKey.LangId.key, MARKDOWN_LANGUAGE_ID),
			handler: () => {
				const resource = activeFile();
				if (resource) { reveal(); editors.track(editors.openMarkdownPreview(resource, SIDE_GROUP).catch(onUnexpectedError)); }
			}
		}),
		registerPaneCommand(MARKDOWN_PREVIEW_EDITOR_ID, {
			id: 'markdown.showSource',
			title: localize('markdown.showSource.title', "Open Source"),
			primary: KeyCode.KeyP,
			handler: () => { reveal(); editors.track(editors.openMarkdownSource().catch(onUnexpectedError)); }
		}),
		registerPaneCommand(TEXT_FILE_EDITOR_ID, {
			id: 'tscode.file.toggleWordWrap',
			title: localize('tscode.file.toggleWordWrap', "Wrap"),
			primary: KeyCode.KeyW,
			handler: () => editors.dispatchCommand('toggle-wrap')
		})
	);
}
