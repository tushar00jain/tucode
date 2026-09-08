/*---------------------------------------------------------------------------------------------
 * Copy a file location through the shared editor and clipboard services.
 * GUI entry points opt in; terminal editors do not yet expose a text clipboard.
 *--------------------------------------------------------------------------------------------*/

import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Schemas } from '../../../../base/common/network.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize2 } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';

class CopyFileLocationAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.copyFilePathAndLineNumber',
			label: localize2('copyFilePathAndLineNumber', "Copy File Path and Line Number"),
			precondition: ResourceContextKey.Scheme.isEqualTo(Schemas.file),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.Shift | KeyCode.KeyP),
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyS },
				weight: KeybindingWeight.WorkbenchContrib
			},
			contextMenuOpts: { group: '9_cutcopypaste', order: 5 }
		});
	}

	override async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		const resource = editor.getModel()?.uri;
		const position = editor.getPosition();
		if (!resource || resource.scheme !== Schemas.file || !position) { return; }
		await accessor.get(IClipboardService).writeText(`${resource.fsPath}:${position.lineNumber}`);
	}
}

registerEditorAction(CopyFileLocationAction);
