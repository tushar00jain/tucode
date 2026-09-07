/*---------------------------------------------------------------------------------------------
 * Input for platform terminals. Text, diff and Markdown use upstream inputs.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../vs/base/common/resources.js';
import { URI } from '../vs/base/common/uri.js';
import { EditorInput } from '../vs/workbench/common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../vs/workbench/common/editor.js';
import { IEditorAreaTerminalOpenRequest } from './editorContent.js';

export class PlatformEditorInput extends EditorInput {
	static readonly ID = 'tucode.platformEditorInput';
	override readonly typeId = PlatformEditorInput.ID;
	constructor(readonly kind: 'terminal', override readonly resource: URI | undefined,
		readonly terminalRequest?: Readonly<IEditorAreaTerminalOpenRequest>) { super(); }
	override getName(): string { return this.terminalRequest?.label ?? (this.resource ? basename(this.resource) : ''); }
	override getTitle(): string { return this.resource?.toString() ?? this.terminalRequest?.cwd ?? this.getName(); }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other === this || other instanceof PlatformEditorInput && this.kind === other.kind
			&& this.resource?.toString() === other.resource?.toString() && this.terminalRequest?.id === other.terminalRequest?.id;
	}
}
