import { IEditorGroupViewOptions } from '../vs/workbench/browser/parts/editor/editor.js';
import { MainEditorPart } from '../vs/workbench/browser/parts/editor/editorPart.js';
import { EditorParts } from '../vs/workbench/browser/parts/editor/editorParts.js';

/** AppKit owns the surrounding UI; the browser mounts only file-editing content. */
class MacMainEditorPart extends MainEditorPart {
	protected override getGroupViewOptions(): IEditorGroupViewOptions {
		return { ...super.getGroupViewOptions(), showWatermark: false };
	}
}

export class MacEditorParts extends EditorParts {
	protected override createMainEditorPart(): MainEditorPart {
		return this.instantiationService.createInstance(MacMainEditorPart, this);
	}
}
