/*---------------------------------------------------------------------------------------------
 * Shared semantic owner behind the terminal-editor projection boundary.
 *--------------------------------------------------------------------------------------------*/
import { Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { PendingWork } from '../vs/workbench/browser/tauri/pendingWork.js';
import {
	ITerminalCommandDecoration, ITerminalFindSnapshot, ITerminalProjectionRow, TerminalEditorInputEvent, TerminalEditorProjectionGateway, terminalEditorSnapshot
} from './terminalProjection.js';

export interface ITerminalEditorBackend extends Disposable {
	readonly onDidChange: Event<void>; readonly onDidExit: Event<number | undefined>;
	readonly title: string; readonly exited: boolean; readonly exitCode: number | undefined;
	readonly cursor: Readonly<{ readonly column: number; readonly row: number }>;
	readonly logicalText: Readonly<{ readonly value: string; readonly cursorOffset: number }>;
	readonly scrollTop: number;
	readonly commandDecorations: readonly Readonly<ITerminalCommandDecoration>[];
	readonly find: Readonly<ITerminalFindSnapshot>;
	readonly bracketedPasteMode: boolean;
	readonly alternateBufferActive: boolean;
	start(): Promise<void>; resize(columns: number, rows: number): void; write(data: string): void; paste(text: string): void;
	scroll(lines: number): void;
	scrollPage(pages: -1 | 1): void;
	findAction(action: 'open' | 'query' | 'next' | 'previous' | 'close', query?: string): void;
	pointer?(column: number, row: number, button: number, pressed: boolean): void;
	projectRows(focused: boolean): readonly Readonly<ITerminalProjectionRow>[];
	whenSettled(): Promise<void>;
	shutdown?(): Promise<void>;
	diagnostics?(): object;
}

export class TerminalEditorController extends Disposable {
	readonly projection: TerminalEditorProjectionGateway;
	private readonly pending = this._register(new PendingWork('terminal'));
	private generation = 1; private columns: number; private rows: number; private focused = false; private alive = true;
	constructor(readonly terminalId: string, private readonly backend: ITerminalEditorBackend, columns = 80, rows = 24,
		private readonly preparePaste: (text: string, bracketed: boolean) => Promise<string | undefined> = async text => text) {
		super(); this.columns = columns; this.rows = rows; this._register(backend);
		this.projection = this._register(new TerminalEditorProjectionGateway(this.snapshot(), event => {
			const work = this.handle(event);
			return work && this.pending.track(work, `${event.kind}:${event.terminalId}`);
		}));
		this._register(backend.onDidChange(() => this.publish())); this._register(backend.onDidExit(() => this.publish()));
	}
	async open(): Promise<void> { await this.backend.start(); if (this.alive) { this.publish(); } }
	async whenSettled(): Promise<void> { await this.pending.whenSettled(); await this.backend.whenSettled(); }
	diagnostics(): object { return this.backend.diagnostics?.() ?? {}; }
	async shutdown(): Promise<void> { await this.backend.shutdown?.(); }
	private publish(): void { if (this.alive) { this.projection.publish(this.snapshot()); } }
	private snapshot() {
		const logical = this.backend.logicalText;
		return terminalEditorSnapshot({ kind: 'terminal', generation: this.generation++, terminalId: this.terminalId,
			title: this.backend.title, columns: this.columns, rows: this.rows, focused: this.focused,
			exited: this.backend.exited, exitCode: this.backend.exitCode, alternateBufferActive: this.backend.alternateBufferActive,
			cursor: this.backend.cursor,
			content: this.backend.projectRows(this.focused), logicalText: logical.value,
			commandDecorations: this.backend.commandDecorations,
			find: this.backend.find,
			cursorOffset: logical.cursorOffset, selection: { location: logical.cursorOffset, length: 0 },
			scrollTop: this.backend.scrollTop,
			status: this.backend.exited ? `process exited (${this.backend.exitCode ?? 0})` : undefined });
	}
	private handle(event: TerminalEditorInputEvent): void | Promise<void> {
		switch (event.kind) {
			case 'key': this.backend.write(event.sequence); return;
			case 'text': this.backend.write(event.text); return;
			case 'paste': return this.paste(event.text);
			case 'viewport':
				if (this.columns === event.columns && this.rows === event.rows) { return; }
				this.columns = event.columns; this.rows = event.rows; this.backend.resize(event.columns, event.rows); break;
			case 'scroll': this.backend.scroll(event.lines); return;
			case 'scroll-page': this.backend.scrollPage(event.pages); return;
			case 'pointer': this.backend.pointer?.(event.column, event.row, event.button, event.pressed); return;
			case 'focus': if (this.focused === event.focused) { return; } this.focused = event.focused; break;
			case 'find': this.backend.findAction(event.action, event.query); return;
		}
		this.publish();
	}

	private async paste(value: string): Promise<void> {
		const text = await this.preparePaste(value, this.backend.bracketedPasteMode);
		if (this.alive && text !== undefined) { this.backend.paste(text); }
	}
	override dispose(): void { if (!this.alive) { return; } this.alive = false; super.dispose(); }
}
