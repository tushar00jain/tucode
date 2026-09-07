/*---------------------------------------------------------------------------------------------
 * Renderer-neutral xterm search host.
 *
 * SearchAddon intentionally targets xterm's public Terminal contract. @xterm/headless owns the
 * real buffer, markers, scrolling and parse events, but omits the browser renderer's selection
 * and decoration stores. This adapter supplies only those renderer-owned pieces and projects them
 * as immutable records. It does not modify the headless terminal and it does not emulate a DOM.
 *--------------------------------------------------------------------------------------------*/
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type {
	IBufferRange, IDecoration, IDecorationOptions, IEvent, IMarker, Terminal as BrowserTerminal
} from '@xterm/xterm';

export interface ITerminalSearchDecoration {
	readonly id: number;
	readonly line: number;
	readonly column: number;
	readonly width: number;
	readonly active: boolean;
}

type SearchAddonTerminalContract = Pick<BrowserTerminal,
	'buffer' | 'cols' | 'rows' | 'onLineFeed' | 'onCursorMove' | 'onResize' | 'onWriteParsed' |
	'registerMarker' | 'registerDecoration' | 'getSelectionPosition' | 'clearSelection' | 'select' | 'scrollLines'>;

class SearchDecoration implements IDecoration {
	private disposed = false;
	private readonly disposeListeners = new Set<() => void>();
	readonly onRender: IEvent<HTMLElement> = () => ({ dispose() {} });
	readonly onDispose: IEvent<void> = listener => {
		if (this.disposed) { listener(); return { dispose() {} }; }
		this.disposeListeners.add(listener);
		return { dispose: () => this.disposeListeners.delete(listener) };
	};
	element: HTMLElement | undefined;
	readonly options: Pick<IDecorationOptions, 'overviewRulerOptions'>;

	constructor(readonly marker: IMarker, options: IDecorationOptions, private readonly release: () => void) {
		this.options = { overviewRulerOptions: options.overviewRulerOptions };
	}

	get isDisposed(): boolean { return this.disposed; }
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.release();
		for (const listener of [...this.disposeListeners]) { listener(); }
		this.disposeListeners.clear();
	}
}

/**
 * The stable ownership seam between xterm's shared search semantics and a non-DOM renderer.
 * Keeping this class typed against a Pick of the public Terminal API means an upstream contract
 * change fails compilation instead of silently becoming a local search implementation.
 */
export class HeadlessSearchTerminalAdapter implements SearchAddonTerminalContract {
	private selection: IBufferRange | undefined;
	private nextDecorationId = 1;
	private readonly decorationRecords = new Map<number, Readonly<ITerminalSearchDecoration>>();

	constructor(private readonly terminal: HeadlessTerminal) {}

	get buffer(): BrowserTerminal['buffer'] { return this.terminal.buffer; }
	get cols(): number { return this.terminal.cols; }
	get rows(): number { return this.terminal.rows; }
	get onLineFeed(): BrowserTerminal['onLineFeed'] { return this.terminal.onLineFeed; }
	get onCursorMove(): BrowserTerminal['onCursorMove'] { return this.terminal.onCursorMove; }
	get onResize(): BrowserTerminal['onResize'] { return this.terminal.onResize; }
	get onWriteParsed(): BrowserTerminal['onWriteParsed'] { return this.terminal.onWriteParsed; }

	registerMarker(cursorYOffset = 0): IMarker {
		return this.terminal.registerMarker(cursorYOffset) as IMarker;
	}

	registerDecoration(options: IDecorationOptions): IDecoration | undefined {
		if (options.marker.isDisposed || options.marker.line < 0) { return undefined; }
		const id = this.nextDecorationId++;
		this.decorationRecords.set(id, Object.freeze({
			id,
			line: options.marker.line,
			column: options.x ?? 0,
			width: options.width ?? 1,
			active: options.layer === 'top'
		}));
		return new SearchDecoration(options.marker, options, () => this.decorationRecords.delete(id));
	}

	getSelectionPosition(): IBufferRange | undefined {
		return this.selection && {
			start: { ...this.selection.start },
			end: { ...this.selection.end }
		};
	}

	clearSelection(): void { this.selection = undefined; }

	select(column: number, row: number, length: number): void {
		const end = column + Math.max(0, length);
		this.selection = {
			start: { x: column, y: row },
			end: { x: end % this.cols, y: row + Math.floor(end / this.cols) }
		};
	}

	scrollLines(amount: number): void { this.terminal.scrollLines(amount); }

	/** Actual renderer records created and disposed by SearchAddon. */
	decorations(): readonly Readonly<ITerminalSearchDecoration>[] {
		return Object.freeze([...this.decorationRecords.values()].map(record => Object.freeze({ ...record })));
	}

	/** Deliberate, audited cast at the public addon activation boundary. */
	forSearchAddon(): BrowserTerminal { return this as unknown as BrowserTerminal; }
}
