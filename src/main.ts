/*---------------------------------------------------------------------------------------------
 *  The tucode entry point — the terminal frontend's third act.
 *
 *  `boot.ts` is the first two: the side-effect imports that populate the singleton registry, and
 *  the service assembly, in tscode's own order for tscode's own reasons. It ends with an
 *  `IInstantiationService` and nothing mounted. **This file is what mounts**, and what it mounts is
 *  `Screen`, `Input` and `Workbench` over a pseudoconsole.
 *
 *  **Everything terminal-only is imported here and nowhere else**, and that is the selection: a
 *  module whose scope installs something — the icon substitutes, the keyboard's deliverability
 *  answer — installs it because *this* file imported it, and the macOS entry point that does not
 *  import it gets the other answer. There is no flag anywhere saying which frontend is running.
 *
 *  Upstream counterpart: src/main.ts
 *--------------------------------------------------------------------------------------------*/

import { Boot, IBootContext } from './boot.js';
import { DeferredPromise } from './vs/base/common/async.js';
import { onUnexpectedError } from './vs/base/common/errors.js';
import { toErrorMessage } from './vs/base/common/errorMessage.js';
import { DisposableStore } from './vs/base/common/lifecycle.js';
import { ServiceCollection } from './vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from './vs/platform/instantiation/common/descriptors.js';
import { IContextMenuService } from './vs/platform/contextview/browser/contextView.js';
import { IKeyboardLayoutService } from './vs/platform/keyboardLayout/common/keyboardLayout.js';
import { IThemeService } from './vs/platform/theme/common/themeService.js';
import { DefaultThemeService } from './vs/workbench/services/themes/tauri/defaultThemeService.js';
import { IStatusbarService } from './vs/workbench/services/statusbar/browser/statusbar.js';
import { stopHost } from './vs/base/parts/ipc/node/ipc.host.js';
import { TerminalContextMenuService } from './tui/workbench/contextMenu.js';
import { registerQuickAccess } from './tui/workbench/quickAccess.js';
import { TerminalStatusbarPart } from './tui/workbench/statusbarPart.js';
import { QuickInputDialogs } from './workbench/dialogHandler.js';
// The branch name and its ahead/behind counts, out of `provider.statusBarCommands` — upstream's own
// contribution, instantiated below because nothing here starts the contribution registry.
import { SCMActiveRepositoryController } from './vs/workbench/contrib/scm/browser/activity.js';
// The icon glyphs a cell cannot hold, and what stands in for them. Importing it is the choice in
// exactly the sense above: its module scope registers `tscode.iconFont` and installs the
// substitution into `dom/style.ts`, and no other frontend imports it.
import { loadGlyphSubstitutes } from './tui/workbench/iconGlyphs.js';
// The keyboard's terminal-only half. **Importing it is the choice**: its module scope installs the
// "which of a command's keys can actually be sent" answer that every surface printing a key reads
// through `namedKeybinding`, and a frontend that does not import it keeps upstream's own primary.
import { TerminalKeyboardLayoutService } from './tui/workbench/terminalKeyboard.js';
import { Screen } from './tui/terminal/screen.js';
import { Input } from './tui/terminal/input.js';
import { Pane } from './tui/workbench/pane.js';
import { Workbench } from './tui/workbench/workbench.js';
import { addDisposableListener, EventType } from './vs/base/browser/dom.js';
import { ExplorerPane } from './tui/views/explorerPane.js';
import { SearchPane } from './tui/views/searchPane.js';
// The git provider. Importing it registers the `git.*` configuration and the SCM menus; the class
// is instantiated below because, with no `ILifecycleService`, nothing starts the workbench
// contribution registry it registers itself with.
import { TauriGitContribution } from './vs/workbench/contrib/scm/tauri/git.contribution.js';
import { SCMPane } from './tui/views/scmPane.js';
// The source control graph — the second region of the same tab, gated on the history provider count
// `SCMService` maintains, exactly as upstream's Graph view is.
import { SCMHistoryPane } from './tui/views/scmHistoryPane.js';
// The Sapling smartlog. Importing the pane registers `ISaplingSelectionService`, which is a
// `registerSingleton` in `contrib/sapling/tauri/saplingSelection.ts` as it is in tscode.
import { SaplingPane } from './tui/views/saplingPane.js';
// The commit-info drawer below it, which reads the selection the smartlog publishes.
import { SaplingCommitInfoPane } from './tui/views/saplingCommitInfoPane.js';
// Reading: a file and a diff, over the vendored text model, the vendored wrap and fold models and
// the vendored diff computer. `registerEditorCommands` registers `vscode.open` and `vscode.diff`,
// which is what the SCM pane's rows, `git.openChange`, `git.openFile` and `git.openHEADFile` have
// been dispatching to all along.
import { EditorArea } from './tui/editor/editorArea.js';
import { registerEditorCommands } from './tui/editor/editorCommands.js';
// Editing, and the capability under it: a child process in a pty sized to the editor area's
// rectangle, with tucode still drawing everything around it. See `§9` in the architecture doc.
import { registerTerminalCommands } from './tui/editor/terminalCommands.js';
import { ITextMateTokenizationService } from './vs/workbench/services/textMate/browser/textMateTokenizationFeature.js';

/**
 * The size a run with no tty paints at. A pipe has no dimensions to ask for, and a frame with
 * none is not assertable; these are the geometry the pane tests read back.
 */
const FALLBACK_SIZE = { cols: Number(process.env['TUCODE_COLS'] ?? 100), rows: Number(process.env['TUCODE_ROWS'] ?? 30) };

class HeadlessMain extends Boot {

	/**
	 * The four identifiers a terminal answers differently from a window.
	 *
	 * The keyboard is the one with a reason that is not a widget: there is no layout to read — a pty
	 * delivers the character the user's layout already produced — so the mapper is upstream's
	 * `FallbackKeyboardMapper`, which dispatches on `KeyCode`. See `tui/workbench/keyboard.ts`.
	 *
	 * The other three are interaction surfaces that need somewhere to be drawn, and each keeps
	 * upstream's own model on the floating layer: `StatusbarViewModel` orders the entries and
	 * `ContextMenuMenuDelegate` turns a `MenuId` into actions. A file dialog is the one a terminal
	 * genuinely cannot answer — there is no panel to raise — so it throws where its readers reach it.
	 * See `§6.4` in the architecture doc.
	 */
	protected override registerFrontendServices(serviceCollection: ServiceCollection, _context: IBootContext): void {
		serviceCollection.set(IKeyboardLayoutService, new TerminalKeyboardLayoutService());
		serviceCollection.set(IStatusbarService, new SyncDescriptor(TerminalStatusbarPart));
		serviceCollection.set(IContextMenuService, new SyncDescriptor(TerminalContextMenuService, [this.overlays]));
	}

	/**
	 * The frontend. `Screen` and `Input` come first because they own stdout and stdin, and
	 * nothing else in this process may write to either from here on.
	 *
	 * An interactive run returns when the user quits. A run whose stdout is not a tty cannot host
	 * a full-screen UI, so it paints at a fixed size, replays whatever stdin has, and returns —
	 * which is what makes the pane assertable by a driver that pipes bytes in and reads the
	 * frames back out.
	 *
	 * Unlike the services, the frontend *is* disposed on the way out, and it has to be: a raw-mode
	 * stdin with a listener on it holds the event loop open, and leaves the terminal in raw mode
	 * for whatever runs next.
	 */
	async open(): Promise<void> {
		const { serviceCollection } = await this.initServices();
		const instantiationService = this.createInstantiationService(serviceCollection);

		// The theme's JSON, before anything paints: every pane asks the theme for its colours while
		// it renders, and a token's colour is the loaded theme's `tokenColorMap` rather than the
		// colour registry's default. `initialize` is awaited rather than started because a theme
		// arriving later would need every pane to repaint on an event none of them listens for.
		await instantiationService.invokeFunction(accessor => (accessor.get(IThemeService) as DefaultThemeService).initialize());

		// And the letters this frontend draws the theme's icons as, out of the theme it just loaded.
		// It is here rather than in the theme service because the theme service is shared and this is
		// the terminal's answer alone — a window registers `seti.woff` and draws the glyph.
		await instantiationService.invokeFunction(loadGlyphSubstitutes);

		const frontend = new DisposableStore();
		const screen = frontend.add(new Screen(process.stdout, FALLBACK_SIZE));
		const input = frontend.add(new Input(process.stdin, screen.interactive));
		const quit = new DeferredPromise<void>();
		const editors = frontend.add(instantiationService.createInstance(EditorArea));
		// EditorParts finishes startup by focusing its initial group. Complete that upstream
		// initialization before wiring interactive focus into the terminal workbench.
		await editors.groups.whenReady;
		let workbench!: Workbench;
		// Register editor-area rules before constructing any consumer that can ask the keybinding
		// service for its resolver. The callbacks run only after the workbench has been assigned.
		frontend.add(registerEditorCommands(editors, () => workbench.focusEditorArea()));
		frontend.add(registerTerminalCommands(editors, () => workbench.focusEditorArea()));
		const statusbar = instantiationService.invokeFunction(accessor => accessor.get(IStatusbarService)) as TerminalStatusbarPart;
		workbench = frontend.add(instantiationService.createInstance(Workbench, screen, input, editors, this.overlays, statusbar, () => quit.complete()));
		frontend.add(editors.groups.mainPart.onDidFocus(() => workbench.focusEditorArea()));
		// Composite focus deliberately coalesces a blur/reentry in one turn. Terminal input can
		// leave Explorer and reopen the same pane in one batch, so forward its real DOM focus too.
		frontend.add(addDisposableListener(editors.groups.mainPart.getContainer()!, EventType.FOCUS,
			() => workbench.focusEditorArea(), true));

		// Stdin closing ends the run, as the alternate screen closing did in a window.
		frontend.add(input.onDidEnd(() => quit.complete()));

		screen.begin();
		try {
			// The contribution joins the frontend store rather than the services, because it is the
			// one thing here that keeps polling: its watcher reschedules a status read every 500 ms,
			// and a read issued after the backend has closed rejects into the log — which cannot be
			// written either, so the failure logs the failure. Disposing it with the panes, while the
			// backend is still up, is what ends the run.
			const git = frontend.add(instantiationService.createInstance(TauriGitContribution));

			// The status bar's entries, and the confirmation surface. Both are workbench
			// contributions upstream starts from the registry and nothing here does, so both are
			// asked for by name: `SCMActiveRepositoryController` puts the branch and its
			// ahead/behind counts on the bar, and `QuickInputDialogs` answers `DialogsModel` with the
			// box a terminal has — which is what lets `git.clean` ask before it throws work away.
			frontend.add(instantiationService.createInstance(SCMActiveRepositoryController));
			frontend.add(instantiationService.createInstance(QuickInputDialogs));

			// The tokenizer, for the same reason: `textMateTokenizationFeature.contribution.ts`
			// registers a workbench contribution whose only act is to ask for this service, and
			// nothing here starts the contribution registry. Asking for it is what reads the grammar
			// extensions and fills `TokenizationRegistry` — until then every token is default-coloured.
			instantiationService.invokeFunction(accessor => accessor.get(ITextMateTokenizationService));

			// Every pane is constructed before the first one is added, and the order matters:
			// constructing a pane registers its keybinding rules, and `WorkbenchKeybindingService`
			// builds its resolver once — at the first paint, which asks it for the key labels on the
			// status line. A rule registered after that is not in the resolver and cannot fire.
			//
			// These are the side bar's panes, in no particular order: which view container each one
			// belongs to, and where that container and its views sit, is read off the registries
			// `views.ts` declared them in.
			const panes: Pane[] = [
				instantiationService.createInstance(ExplorerPane),
				instantiationService.createInstance(SearchPane),
				instantiationService.createInstance(SCMPane, git),
				instantiationService.createInstance(SCMHistoryPane),
				instantiationService.createInstance(SaplingPane),
				instantiationService.createInstance(SaplingCommitInfoPane)
			];

			// The default quick access provider, and the two upstream keys put on the status line.
			// Last, so `F1` and `Ctrl+P` follow the workbench's own keys on the row rather than
			// displacing them.
			frontend.add(registerQuickAccess());

			await workbench.add(...panes);

			input.start();
			await (screen.interactive ? quit.p : input.replay());

			// A picker or a confirmation still open is a caller waiting on an answer no further
			// keystroke can give, and `whenSettled` below would wait for it for ever — the shape
			// §16.7 calls a defect rather than something to sit out. The input ending is the
			// user walking away from the dialog, so it is escaped.
			this.overlays.cancelAll();

			// A keystroke can start a folder read, so the run is over when the input is *and* the
			// work it began has painted. Without this a driven run reads the screen mid-answer.
			await workbench.whenSettled();
		} finally {
			screen.end();
			frontend.dispose();
			this.webWorkerService.dispose();
		}
	}
}

// `open()` returns when the frontend is done, so boot ends where the alternate screen does.
// `stopHost` closes the
// backend's stdin, which is what stops its watchers, searches and shells, and it is the whole
// of teardown: the services are not disposed, because `fileService.registerProvider`'s
// disposable unregisters the provider the log is still being written through, and because a
// disposal that runs after the host has gone only produces calls that cannot be answered. The
// process exiting is the disposal, as a window closing was in tscode.
//
// A boot that fails reports on stderr as well as to the log: the log is written through the
// host, so a failure early enough has nothing to write with — the same reason tscode's boot
// keeps its mount and its error handler as one sequence. It also exits non-zero, so `npm start`
// fails rather than looking like a run that printed nothing.
const main = new HeadlessMain();
main.open()
	.catch(error => {
		process.exitCode = 1;
		process.stderr.write(`tucode: boot failed: ${toErrorMessage(error, true)}\n`);
		onUnexpectedError(error);
	})
	.finally(() => {
		main.flushLog();

		return stopHost();
	});
