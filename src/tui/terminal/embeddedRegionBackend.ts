/*---------------------------------------------------------------------------------------------
 * TUI adapter from the existing PTY/xterm region to the neutral terminal-editor backend.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../vs/platform/terminal/common/terminal.js';
import { IEditorAreaTerminalOpenRequest } from '../../editor/editorContent.js';
import { ITerminalEditorBackend } from '../../terminal/terminalEditorController.js';
import { ITerminalCommandDecoration, ITerminalFindSnapshot, ITerminalProjectionRow } from '../../terminal/terminalProjection.js';
import { EmbeddedRegion } from './embeddedRegion.js';
import { spanWidth } from './screen.js';

function css(color: Color | undefined): string | undefined {
	return color && Color.Format.CSS.formatHexA(color, true);
}

/** Owns no area behavior: it only translates EmbeddedRegion's scalar terminal cells. */
export class EmbeddedRegionTerminalBackend extends Disposable implements ITerminalEditorBackend {
	private readonly region: EmbeddedRegion;
	readonly onDidChange: Event<void>;
	readonly onDidExit: Event<number | undefined>;

	constructor(readonly request: Readonly<IEditorAreaTerminalOpenRequest>, instantiationService: IInstantiationService) {
		super();
		const launch: IShellLaunchConfig = { executable: request.executable, args: request.args ? [...request.args] : undefined };
		this.region = this._register(instantiationService.createInstance(EmbeddedRegion, launch, request.cwd, 80, 24, { ...request.env }));
		this.onDidChange = this.region.onDidChange;
		this.onDidExit = this.region.onDidExit;
	}

	get title(): string { return this.region.processTitle || this.request.label; }
	get exited(): boolean { return this.region.exited; }
	get exitCode(): number | undefined { return this.region.exitCode; }
	get cursor(): Readonly<{ readonly column: number; readonly row: number }> {
		return { column: this.region.cursor.x, row: this.region.cursor.y };
	}
	get logicalText(): Readonly<{ readonly value: string; readonly cursorOffset: number }> { return this.region.viewportText(); }
	get scrollTop(): number { return this.region.scrollTop; }
	get alternateBufferActive(): boolean { return this.region.alternateBufferActive; }
	get commandDecorations(): readonly Readonly<ITerminalCommandDecoration>[] { return this.region.commandDecorations(); }
	get find(): Readonly<ITerminalFindSnapshot> { return this.region.findSnapshot(); }
	get bracketedPasteMode(): boolean { return this.region.bracketedPasteMode; }
	start(): Promise<void> { return this.region.start(); }
	resize(columns: number, rows: number): void { this.region.resize(columns, rows); }
	scroll(lines: number): void { this.region.scroll(lines); }
	scrollPage(pages: -1 | 1): void { this.region.scrollPage(pages); }
	findAction(action: 'open' | 'query' | 'next' | 'previous' | 'close', query?: string): void { this.region.findAction(action, query); }
	write(data: string): void { this.region.write(data); }
	paste(text: string): void { this.region.paste(text); }
	whenSettled(): Promise<void> { return this.region.whenSettled(); }
	shutdown(): Promise<void> { return this.region.shutdown(); }
	diagnostics(): object { return { pid: this.region.pid, processGroupId: this.region.processGroupId,
		exited: this.region.exited, exitCode: this.region.exitCode, backlog: this.region.backlog }; }

	projectRows(focused: boolean): readonly Readonly<ITerminalProjectionRow>[] {
		const wraps = this.region.rowWraps();
		return Object.freeze(this.region.lines(focused && !this.region.exited).map((line, index) => Object.freeze({
			id: `${this.request.id}:row:${index}`,
			wrapped: wraps[index],
			runs: Object.freeze(line.map(span => Object.freeze({ text: span.text, cells: spanWidth(span.text), foreground: css(span.fg), background: css(span.bg),
				bold: span.bold, italic: span.italic, underline: span.underline })))
		})));
	}
}
