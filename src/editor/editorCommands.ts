/*---------------------------------------------------------------------------------------------
 * Frontend-neutral registration of the shared editor-area open commands.
 *--------------------------------------------------------------------------------------------*/
import { combinedDisposable, IDisposable } from '../vs/base/common/lifecycle.js';
import { URI } from '../vs/base/common/uri.js';
import { CommandsRegistry } from '../vs/platform/commands/common/commands.js';
import { ITextEditorOptions } from '../vs/platform/editor/common/editor.js';
import type { EditorGroupColumn } from '../vs/workbench/services/editor/common/editorGroupColumn.js';

export interface IEditorOpener {
	openFile(resource: URI, options?: ITextEditorOptions): Promise<void>;
	openDiff(original: URI, modified: URI, label?: string): Promise<void>;
}

export function registerOpenCommands(editors: IEditorOpener, reveal: () => void): IDisposable {
	return combinedDisposable(
		CommandsRegistry.registerCommand({
			id: 'vscode.open', metadata: { description: 'Open a file', args: [] },
			handler: async (_accessor, resource: URI, columnAndOptions?: [EditorGroupColumn?, ITextEditorOptions?]) => {
				const options = columnAndOptions?.[1];
				const opening = editors.openFile(URI.revive(resource), options);
				if (!options?.preserveFocus) { reveal(); }
				await opening;
			}
		}),
		CommandsRegistry.registerCommand({
			id: 'vscode.diff', metadata: { description: 'Compare two files', args: [] },
			handler: async (_accessor, original: URI, modified: URI, label?: string) => {
				const opening = editors.openDiff(URI.revive(original), URI.revive(modified), label);
				reveal(); await opening;
			}
		})
	);
}
