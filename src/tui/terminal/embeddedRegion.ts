/*---------------------------------------------------------------------------------------------
 *  The embedded region: a child process in a pty, sized to a rectangle of the frame.
 *
 *  tucode goes on drawing the activity bar, the side bar, the tabs and the status bar; the child
 *  owns the rectangle in the middle and nothing else. Which is upstream's arrangement exactly —
 *  `TerminalInstance` owns a process and an xterm, and the workbench owns everything around it.
 *
 *  **Nothing here emulates a terminal, and nothing here talks to an OS.** Three pieces already
 *  exist and this file is the wiring between them:
 *
 *  - `TauriTerminalProcess` — the vendored `ITerminalChildProcess`, over the `pty` channel that
 *    `tscode-pty` answers. Spawn, IO, resize, kill, flow control and process monitoring are all
 *    below it.
 *  - `@xterm/headless` — xterm.js's core without a renderer, which is the same emulator
 *    `XtermTerminal` wraps upstream. A browser lets it paint its own canvas; a terminal has to read
 *    the cells back, which is the one thing that has no upstream form.
 *  - `TerminalConfigurationService` and `ansiColorIdentifiers` — upstream's own answers to "which
 *    keystrokes may the child not have" and "what colour is `terminal.ansiRed`".
 *
 *  **`PtyService` and `TauriTerminalBackend` are not on the path, and that is measured**: the
 *  process alone reaches 120 files with no DOM in them, and `tauriTerminalBackend.ts` reaches 488
 *  with 31,452 DOM-bound lines — the same wall `EditorPart` is. What that costs is
 *  `PersistentTerminalProcess`: a region does not survive a restart, which the port had already
 *  given up on ("terminals do not survive a webview reload").
 *
 *  Upstream counterpart: src/vs/workbench/contrib/terminal/browser/terminalInstance.ts, src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts
 *--------------------------------------------------------------------------------------------*/

import xtermHeadless from '@xterm/headless';
import type { Terminal as XtermTerminal } from '@xterm/headless';
import { SearchAddon } from '@xterm/addon-search';

import { RunOnceScheduler } from '../../vs/base/common/async.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, toDisposable } from '../../vs/base/common/lifecycle.js';
import { IProcessEnvironment } from '../../vs/base/common/platform.js';
import { generateUuid } from '../../vs/base/common/uuid.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../vs/platform/ipc/common/mainProcessService.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IProductService } from '../../vs/platform/product/common/productService.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { TerminalCapability } from '../../vs/platform/terminal/common/capabilities/capabilities.js';
import { FlowControlConstants, IShellLaunchConfig, ITerminalProcessOptions, TerminalSettingId } from '../../vs/platform/terminal/common/terminal.js';
import { ShellIntegrationAddon } from '../../vs/platform/terminal/common/xterm/shellIntegrationAddon.js';
import { PTY_CHANNEL_NAME, TauriTerminalProcess } from '../../vs/platform/terminal/tauri/tauriTerminalProcess.js';
import { FILE_CHANNEL_NAME } from '../../vs/workbench/services/files/tauri/tauriFileSystemProvider.js';
import { ansiColorIdentifiers, registerColors, TERMINAL_BACKGROUND_COLOR, TERMINAL_FOREGROUND_COLOR } from '../../vs/workbench/contrib/terminal/common/terminalColorRegistry.js';
import { IRegionTheme, IViewportText, regionLines, viewportText } from './cells.js';
import { ILine } from './screen.js';
import { ITerminalCommandDecoration, ITerminalFindSnapshot, projectTerminalCommandDecorations } from '../../terminal/terminalProjection.js';
import { TerminalProcessInputGate } from '../../terminal/terminalProcessInput.js';
import { HeadlessSearchTerminalAdapter } from '../../terminal/headlessSearchTerminal.js';

// The `terminal.ansi*` colours, registered where `terminal.contribution.ts` registers them.
// `ansiColorIdentifiers` is an empty array until this runs, so a palette index would resolve to
// nothing and every colour the child names by index would come out default.
registerColors();

/**
 * Flow control's client half, copied whole from `terminalProcessManager.ts` because the file it
 * lives in is the 484-file wall. The pty pauses at `HighWatermarkChars` unacknowledged characters
 * and resumes at `LowWatermarkChars`; a client that acks per write instead of per 5,000 characters
 * would be a second protocol, and a mismatch here deadlocks the child rather than failing loudly.
 */
class AckDataBufferer {
	private _unsentCharCount: number = 0;

	constructor(
		private readonly _callback: (charCount: number) => void
	) {
	}

	ack(charCount: number) {
		this._unsentCharCount += charCount;
		while (this._unsentCharCount > FlowControlConstants.CharCountAckSize) {
			this._unsentCharCount -= FlowControlConstants.CharCountAckSize;
			this._callback(FlowControlConstants.CharCountAckSize);
		}
	}
}

export class EmbeddedRegion extends Disposable {

	private readonly terminal: XtermTerminal;
	private readonly searchTerminal: HeadlessSearchTerminalAdapter;
	private readonly searchAddon: SearchAddon;
	private findVisible = false;
	private findQuery = '';
	private findResultIndex = -1;
	private findResultCount = 0;
	private readonly shellIntegration: ShellIntegrationAddon;
	private readonly shellIntegrationEnabled: boolean;
	private readonly shellIntegrationDecorations: 'both' | 'gutter' | 'overviewRuler' | 'never';
	private readonly shellIntegrationNonce = generateUuid();
	/** The child, which exists from `start()` on — its size is a creation argument. */
	private process: TauriTerminalProcess | undefined;
	private inputGate: TerminalProcessInputGate | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the child has painted something new, coalesced to one repaint per turn. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidExit = this._register(new Emitter<number | undefined>());
	readonly onDidExit: Event<number | undefined> = this._onDidExit.event;

	/** The child's exit code once it has gone, which is what stops the region taking keys. */
	private _exitCode: number | undefined;
	private _exited = false;
	private _failedDuringLaunch = false;
	private _pid: number | undefined;
	private _processGroupId: number | undefined;
	private starting = false;
	private pendingParses = 0;
	private pendingInputs = 0;
	private readonly _onDidSettle = this._register(new Emitter<void>());

	get exited(): boolean {
		return this._exited;
	}

	/**
	 * Whether the child never ran at all, which is upstream's `ProcessState.KilledDuringLaunch` and
	 * the one thing `_onProcessExit` treats differently: a launch that failed has a *message*, and in
	 * this fork the rectangle is the only place it can be read.
	 */
	get failedDuringLaunch(): boolean {
		return this._failedDuringLaunch;
	}

	get exitCode(): number | undefined {
		return this._exitCode;
	}

	/** Exact process id reported by the PTY backend; retained after exit for teardown accounting. */
	get pid(): number | undefined {
		return this._pid;
	}

	get processGroupId(): number | undefined { return this._processGroupId; }

	/** Causal work held by this region: launch, input awaiting its first answer, or xterm parsing. */
	get idle(): boolean {
		return !this.starting && this.pendingParses === 0 && this.pendingInputs === 0;
	}

	/** Bounded-queue evidence for diagnostics after a causal ACK, never an E2E action surface. */
	get backlog(): { readonly starting: boolean; readonly parses: number; readonly inputs: number } {
		return { starting: this.starting, parses: this.pendingParses, inputs: this.pendingInputs };
	}

	async whenSettled(): Promise<void> {
		while (!this.idle) {
			await Event.toPromise(this._onDidSettle.event);
		}
	}

	/** Requests owned-process shutdown and resolves from the backend's real exit event. */
	async shutdown(): Promise<void> {
		if (this._exited || !this.process) { return; }
		const exited = Event.toPromise(this._onDidExit.event);
		await this.process.shutdown(true);
		if (!this._exited) { await exited; }
	}

	private settled(): void {
		if (this.idle) {
			this._onDidSettle.fire();
		}
	}

	/** What the process reports as its title, which is what the tab is named after it starts. */
	get processTitle(): string {
		return this.process?.currentTitle ?? '';
	}

	get cursor(): { readonly x: number; readonly y: number } {
		return { x: this.terminal.buffer.active.cursorX, y: this.terminal.buffer.active.cursorY };
	}

	/** Current xterm viewport row, projected without exposing the mutable buffer. */
	get scrollTop(): number {
		return this.terminal.buffer.active.viewportY;
	}

	get alternateBufferActive(): boolean { return this.terminal.buffer.active.type === 'alternate'; }

	constructor(
		private readonly launch: IShellLaunchConfig,
		private readonly cwd: string,
		private cols: number,
		private rows: number,
		private readonly env: IProcessEnvironment,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IThemeService private readonly themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super();

		const terminal = this.terminal = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
		this.searchTerminal = new HeadlessSearchTerminalAdapter(terminal);
		this.searchAddon = this._register(new SearchAddon({ highlightLimit: 20000 }));
		this.searchAddon.activate(this.searchTerminal.forSearchAddon());
		this._register(this.searchAddon.onDidChangeResults(result => {
			this.findResultIndex = result.resultIndex;
			this.findResultCount = result.resultCount;
		}));
		this.shellIntegrationEnabled = configurationService.getValue<boolean>(TerminalSettingId.ShellIntegrationEnabled) !== false;
		this.shellIntegrationDecorations = configurationService.getValue(TerminalSettingId.ShellIntegrationDecorationsEnabled) ?? 'both';
		this.shellIntegration = this._register(new ShellIntegrationAddon(this.shellIntegrationNonce, true, undefined, undefined, logService));
		terminal.loadAddon(this.shellIntegration);
		this._register(toDisposable(() => terminal.dispose()));
	}

	/**
	 * Spawns the child, at whatever size the region has been laid out to by now.
	 *
	 * The pty is created here rather than in the constructor because its size is a *creation*
	 * argument — `TerminalProcess` takes `cols`/`rows` before it spawns — and the rectangle is not
	 * measured until the frame has been laid out once. A shell started at one row and resized
	 * afterwards has already written its banner into a one-row screen, and no resize puts that back.
	 */
	async start(): Promise<void> {
		this.starting = true;
		// The environment twice, because upstream passes it twice: `_env` is what the child runs with,
		// and `_executableEnv` is what `_validateExecutable` looks the executable up in — its `PATH` is
		// the whole of how a bare `$EDITOR` name resolves. Upstream fills the second with the shell
		// environment `IShellEnvironmentService` answers; here both are the backend's environment,
		// which is the one the pty will spawn into, so looking a command up in a different `PATH` than
		// the child will have is a state this cannot reach.
		const processOptions: ITerminalProcessOptions = {
			shellIntegration: { enabled: this.shellIntegrationEnabled, suggestEnabled: false, nonce: this.shellIntegrationNonce },
			windowsUseConptyDll: false,
			environmentVariableCollections: undefined,
			workspaceFolder: undefined,
			isScreenReaderOptimized: false
		};
		const process = this.process = this._register(new TauriTerminalProcess(
			this.launch, this.cwd, this.cols, this.rows, this.env, this.env, processOptions,
			this.mainProcessService.getChannel(PTY_CHANNEL_NAME), this.mainProcessService.getChannel(FILE_CHANNEL_NAME),
			this.fileService, this.logService, this.productService));
		const ack = new AckDataBufferer(charCount => process.acknowledgeDataEvent(charCount));
		this.inputGate = new TerminalProcessInputGate(data => process.input(data));

		// A repaint per write would be one per chunk the pty produced; a repaint per turn of the event
		// loop is what `TerminalDataBufferer` coalesces to on the other side of the channel.
		const repaint = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 0));

		this._register(process.onProcessData(data => {
			this.pendingParses++;
			this.terminal.write(data, () => {
				this.pendingParses--;
				// In a controlled journey the first parsed output after input is its causal ACK. A
				// real interactive shell also echoes typed input, so this never guesses at silence.
				this.pendingInputs = 0;
				repaint.schedule();
				this.settled();
			});
			ack.ack(data.length);
		}));
		this._register(process.onProcessReady(event => {
			this._pid = event.pid; this._processGroupId = event.processGroupId; this.inputGate?.markReady();
		}));
		this._register(process.onProcessExit(code => this.didExit(code)));

		// The child is killed on the way out, and its own teardown is not the only thing that does it:
		// `tscode-host` calls `shutdown_all` when its stdin closes, which is what `stopHost()` does at
		// the end of every run. A pty that outlives the frontend is the defect §16.7 names, so it
		// is closed from both ends rather than from the tidier one.
		this._register(toDisposable(() => {
			if (!this._exited) {
				process.shutdown(true);
			}
		}));

		try {
			const failure = await process.start();
			if (failure && 'message' in failure) {
				// Awaited, as every other write to the emulator is: `didExit` repaints, and a repaint that
				// runs before xterm has parsed the message reads an empty buffer — which is what turned
				// "the executable does not exist" into a blank rectangle and a status line saying the
				// process exited 0.
				await new Promise<void>(resolve => this.terminal.write(failure.message, resolve));
				this._failedDuringLaunch = true;
				this.didExit(failure.code);
			}
		} finally {
			// A rejected backend launch must release the causal settle waiter as well as a normal ACK.
			this.starting = false;
			this._onDidChange.fire();
			this.settled();
		}
	}

	private didExit(code: number | undefined): void {
		this.inputGate?.close();
		this._exitCode = code;
		this._exited = true;
		this.pendingInputs = 0;
		this._onDidExit.fire(code);
		this._onDidChange.fire();
		this.settled();
	}

	/** Sizes the pty and the emulator together. The child redraws itself; nothing here reflows. */
	resize(cols: number, rows: number): void {
		if (cols === this.cols && rows === this.rows) {
			return;
		}

		this.cols = cols;
		this.rows = rows;
		this.terminal.resize(cols, rows);
		this.process?.resize(cols, rows);
	}

	scroll(lines: number): void { this.terminal.scrollLines(lines); this._onDidChange.fire(); }

	/** Pages xterm's one authoritative scrollback by its public rows-minus-one contract. */
	scrollPage(pages: -1 | 1): void { this.terminal.scrollPages(pages); this._onDidChange.fire(); }

	findAction(action: 'open' | 'query' | 'next' | 'previous' | 'close', query?: string): void {
		switch (action) {
			case 'open':
				this.findVisible = true;
				break;
			case 'query':
				this.findVisible = true;
				this.findQuery = query ?? '';
				this.searchAddon.findPrevious(this.findQuery, this.searchOptions());
				if (!this.findQuery) { this.findResultIndex = -1; this.findResultCount = 0; }
				break;
			case 'next':
				if (this.findVisible) { this.searchAddon.findNext(this.findQuery, this.searchOptions()); }
				break;
			case 'previous':
				if (this.findVisible) { this.searchAddon.findPrevious(this.findQuery, this.searchOptions()); }
				break;
			case 'close':
				this.findVisible = false;
				this.findResultIndex = -1;
				this.findResultCount = 0;
				this.searchAddon.clearDecorations();
				break;
		}
		this._onDidChange.fire();
	}

	private searchOptions() {
		// SearchAddon owns matching, result order and stepping. These values only opt into its
		// decoration lifecycle; the native renderer resolves actual workbench theme colours.
		return { incremental: true, decorations: {
			matchBackground: '#000000', matchBorder: 'transparent', matchOverviewRuler: 'transparent',
			activeMatchBackground: '#000000', activeMatchBorder: 'transparent', activeMatchColorOverviewRuler: 'transparent'
		} };
	}

	findSnapshot(): Readonly<ITerminalFindSnapshot> {
		if (!this.findVisible) {
			return Object.freeze({ visible: false, query: this.findQuery, resultIndex: -1, resultCount: 0, decorations: Object.freeze([]) });
		}
		const viewportY = this.terminal.buffer.active.viewportY;
		const decorations = this.searchTerminal.decorations().flatMap(decoration => {
			const row = decoration.line - viewportY;
			return row < 0 || row >= this.rows ? [] : [Object.freeze({
				id: decoration.id, row, column: decoration.column, width: decoration.width, active: decoration.active
			})];
		});
		return Object.freeze({ visible: true, query: this.findQuery, resultIndex: this.findResultIndex,
			resultCount: this.findResultCount, decorations: Object.freeze(decorations) });
	}

	/** The bytes the user's terminal sent, straight through to the child's stdin. */
	write(data: string): void {
		if (!this._exited) {
			this.pendingInputs++;
			this.inputGate?.write(data);
		}
	}

	/**
	 * Pasted text, bracketed for the child the way the user's own terminal bracketed it for us — so
	 * a shell that asked for bracketed paste is told a paste is a paste, and does not run what is in
	 * it. These are `TerminalInstance.sendText(text, false, true)`'s own two lines; the emulator
	 * holds the mode because it is the one thing here that parses what the child writes.
	 */
	paste(text: string): void {
		if (this.terminal.modes.bracketedPasteMode) {
			text = `\x1b[200~${text}\x1b[201~`;
		}

		// Normalize line endings to 'enter' press.
		this.write(text.replace(/\r?\n/g, '\r'));
	}

	/** Whether the child asked for bracketed paste, which is what decides whether it is warned about. */
	get bracketedPasteMode(): boolean {
		return this.terminal.modes.bracketedPasteMode;
	}

	/**
	 * The region's rows, as spans. `cells.ts` does the reading; this supplies the palette.
	 *
	 * `cursor` draws the cell the child's cursor is on inverted, which is the only cursor a region
	 * can have — `screen.ts` hides the terminal's own for the whole frame.
	 */
	lines(cursor: boolean): ILine[] {
		return regionLines(this.terminal.buffer.active, this.cols, this.rows, this.regionTheme(), cursor);
	}

	/** Soft-wrap ownership for the same immutable viewport rows projected to every frontend. */
	rowWraps(): readonly boolean[] {
		const buffer = this.terminal.buffer.active;
		return Object.freeze(Array.from({ length: this.rows }, (_, row) => !!buffer.getLine(buffer.viewportY + row)?.isWrapped));
	}

	/** Logical text and its UTF-16 cursor offset over the same active viewport the region paints. */
	viewportText(): IViewportText {
		return viewportText(this.terminal.buffer.active, this.rows);
	}

	/** Completed commands owned by upstream shell integration, projected into the visible gutter. */
	commandDecorations(): readonly Readonly<ITerminalCommandDecoration>[] {
		if (!this.shellIntegrationEnabled || !['both', 'gutter'].includes(this.shellIntegrationDecorations)) { return Object.freeze([]); }
		const commands = this.shellIntegration.capabilities.get(TerminalCapability.CommandDetection)?.commands ?? [];
		return projectTerminalCommandDecorations(commands.flatMap(command => command.marker ? [{
			marker: command.marker, command: command.command, exitCode: command.exitCode
		}] : []), this.terminal.buffer.active.viewportY, this.rows);
	}

	/** The colours a cell that names none is drawn in, and the sixteen it may name by index. */
	private regionTheme(): IRegionTheme {
		const theme = this.themeService.getColorTheme();

		return {
			foreground: theme.getColor(TERMINAL_FOREGROUND_COLOR),
			background: theme.getColor(TERMINAL_BACKGROUND_COLOR),
			ansi: ansiColorIdentifiers.map(identifier => theme.getColor(identifier))
		};
	}
}
