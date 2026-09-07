/*---------------------------------------------------------------------------------------------
 * Content adapters for platform editor panes. Editor groups own tabs and lifecycle.
 * Text/diff/terminal content projections remain a separate rendering migration.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../vs/base/common/event.js';
import type { IDisposable } from '../vs/base/common/lifecycle.js';
import type { ITextModel } from '../vs/editor/common/model.js';
import type { TextEditorInputEvent, TextProjectionSnapshot } from './textProjection.js';
import type { ITerminalEditorProjectionSource } from '../terminal/terminalProjection.js';
import type { IMarkdownProjectionSource } from './markdownProjection.js';

export type EditorContentKind = 'text' | 'diff' | 'terminal' | 'markdown';

export interface IEditorAreaChildProjectionSource {
	readonly snapshot: TextProjectionSnapshot;
	readonly onDidSnapshot: Event<TextProjectionSnapshot>;
	dispatch(event: TextEditorInputEvent): boolean;
}

export interface IEditorAreaResolvedChild extends IDisposable {
	readonly projection: IEditorAreaChildProjectionSource | ITerminalEditorProjectionSource | IMarkdownProjectionSource;
	readonly textModel?: ITextModel;
	whenSettled?(): Promise<void>;
}

export interface IEditorAreaTextOpenOptions {
	readonly preserveFocus?: boolean;
	readonly selection?: Readonly<{ readonly startLineNumber: number; readonly startColumn: number; readonly endLineNumber?: number; readonly endColumn?: number }>;
}

export interface IEditorAreaTerminalOpenRequest {
	readonly id: string; readonly label: string; readonly executable?: string; readonly args?: readonly string[];
	readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>>;
}

export interface IEditorAreaResolver {
	resolveText(resource: string, options?: Readonly<IEditorAreaTextOpenOptions>): Promise<IEditorAreaResolvedChild>;
	resolveDiff(original: string, modified: string): Promise<IEditorAreaResolvedChild>;
	resolveMarkdown(resource: string): Promise<IEditorAreaResolvedChild>;
	resolveTerminal?(request: Readonly<IEditorAreaTerminalOpenRequest>): Promise<IEditorAreaResolvedChild>;
}
