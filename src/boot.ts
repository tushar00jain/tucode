/*---------------------------------------------------------------------------------------------
 *  The registry and service graph used by the terminal frontend.
 *
 *  tscode's `main.ts` plays the role upstream splits across `workbench.common.main.ts` and
 *  `browser/web.main.ts`: side-effect imports that populate the singleton registry, then a
 *  service assembly, then a `Workbench` mounted into a document. **This file is the first two
 *  parts.** `src/main.ts` supplies the third act by painting the terminal workbench.
 *
 *  The service order below is tscode's, comments included, because its ordering constraints
 *  are real. Frontend-specific services are registered below.
 *
 *  Upstream counterpart: src/main.ts
 *--------------------------------------------------------------------------------------------*/

//#region --- what a bundler and a webview used to provide

// First, and in this order: the product globals are read by `platform/product/common/product.ts`
// at load, and the browser globals by `base/browser/window.ts` at load.
import './vs/base/node/browserGlobals.js';
import './vs/platform/product/node/productJson.js';

//#endregion


//#region --- workbench services

import './vs/platform/actions/common/actions.contribution.js';
import './vs/platform/undoRedo/common/undoRedoService.js';
import './vs/platform/extensionResourceLoader/common/extensionResourceLoaderService.js';
import './vs/workbench/services/extensionManagement/browser/extensionsProfileScannerService.js';
// `IExtensionGalleryManifestService`, which `ExtensionResourceLoaderService` takes in order to
// answer whether a URI is a gallery resource — the question that decides whether reading a theme
// or a grammar goes through `IFileService` or over HTTP. tscode's own line; `product.json` has no
// `extensionsGallery`, so the manifest is null and every read is a file read.
import './vs/workbench/services/extensionManagement/browser/extensionGalleryManifestService.js';
import './vs/workbench/services/extensions/common/extensionManifestPropertiesService.js';
import './vs/workbench/services/userDataProfile/browser/userDataProfileStorageService.js';
import './vs/workbench/services/userDataSync/common/userDataSyncUtil.js';
import './vs/editor/common/services/languageFeaturesService.js';
import './vs/workbench/services/commands/common/commandService.js';
// `IKeybindingService`, the real one: the keyboard takeover's subclass over `WorkbenchKeybindingService`
// cut to its non-DOM half, which is what turns a keystroke into a command. The keys are declared in
// `tui/workbench/commands.ts` and in the panes, and every rule in `KeybindingsRegistry` — upstream's
// included — resolves through this. It is the *only* registration of the identifier: stock's own, at
// the end of `browser/keybindingService.ts`, is deleted, and `test/unit/bootClosure.test.ts` holds it
// to one.
import './vs/workbench/services/keybinding/tauri/keybindingService.js';
import './vs/workbench/services/label/common/labelService.js';
import './vs/workbench/services/language/common/languageService.js';
import './vs/workbench/services/model/common/modelService.js';
import './vs/workbench/services/notification/common/notificationService.js';
import './vs/workbench/services/textmodelResolver/common/textModelResolverService.js';
import './vs/workbench/services/textresourceProperties/common/textResourcePropertiesService.js';
import './vs/workbench/services/filesConfiguration/common/filesConfigurationService.js';
import './vs/workbench/services/decorations/browser/decorationsService.js';
import './vs/workbench/services/path/browser/pathService.js';
// Non-DOM terminal profile detection resolves configured executable variables before the PTY
// validates them, through the same host-environment resolver used by the Tauri terminal backend.
import './vs/workbench/services/configurationResolver/tauri/configurationResolverService.js';
import './vs/workbench/services/dialogs/common/dialogService.js';
import './vs/workbench/services/workingCopy/common/workingCopyService.js';
import './vs/workbench/services/workingCopy/common/workingCopyFileService.js';
// The write path, which `§12.3` needed for the search pane's replace and which nothing before it
// had a caller for. `BrowserTextFileService` is `ITextFileService` — the wall T04 measured — and
// registering it is what makes `ITextModelService.createModelReference` answer for a `file:` URI,
// which is the one thing `BulkTextEdits` needs. `BrowserElevatedFileService` answers `isSupported`
// with `false`, which is upstream's own answer where the file service has no elevated write.
import './vs/workbench/services/textfile/browser/browserTextFileService.js';
import './vs/workbench/services/files/browser/elevatedFileService.js';
// `IBulkEditService`, which is how every edit in this fork reaches a model and then the disk. Its
// notebook arm is cut — see `§12.3`.
import './vs/workbench/contrib/bulkEdit/browser/bulkEditService.js';
import './vs/workbench/services/editor/browser/editorResolverService.js';
import './editor/upstreamEditorServices.js';
import { PlatformEditorLayout } from './editor/platformEditorLayout.js';
import { platformFileDialogs } from './editor/platformFileDialogs.js';
import { IFileDialogService } from './vs/platform/dialogs/common/dialogs.js';
import './vs/workbench/services/views/browser/viewDescriptorService.js';
// Every `TextModel` builds a `TokenizationTextModelPart`, which takes the tree-sitter library
// service by constructor. It loads its wasm lazily behind
// `editor.experimental.preferTreeSitter.<lang>`, which is off, so registering it costs nothing —
// the same line, and the same reason, as in tscode.
import './vs/workbench/services/treeSitter/browser/treeSitter.contribution.js';
// The explorer's configuration schema and `IExplorerService`.
import './vs/workbench/contrib/files/browser/files.contribution.js';
// Explorer file cut/copy/paste remains upstream's own command and bulk-edit path. Import its
// registrations beside the Explorer service rather than recreating those actions in either frame.
import './vs/workbench/contrib/files/browser/fileActions.contribution.js';
import './vs/workbench/contrib/files/browser/views/explorerViewer.js';
// The real workbench list/tree commands. Non-HTML painters route raw keys through the same
// keybinding service and focused `IListService` widget instead of implementing navigation.
import './vs/workbench/browser/actions/listCommands.js';
// The `search.*` configuration schema, `ISearchHistoryService` and `ISearchViewModelWorkbenchService`.
import './vs/workbench/contrib/search/browser/search.contribution.js';
// `ITextMateTokenizationService`, which is what makes a file syntax-coloured: it reads the 48
// grammar extensions through the `grammars` extension point and registers a tokenizer per
// language with `TokenizationRegistry`. The service is instantiated below, because with no
// `ILifecycleService` nothing starts the workbench contribution this file registers to do it.
import './vs/workbench/services/textMate/browser/textMateTokenizationFeature.contribution.js';

import { InstantiationType, registerSingleton } from './vs/platform/instantiation/common/extensions.js';
import { IContextKeyService } from './vs/platform/contextkey/common/contextkey.js';
import { ContextKeyService } from './vs/platform/contextkey/browser/contextKeyService.js';
import { IMarkerService } from './vs/platform/markers/common/markers.js';
import { MarkerService } from './vs/platform/markers/common/markerService.js';
import { ITextResourceConfigurationService } from './vs/editor/common/services/textResourceConfiguration.js';
import { TextResourceConfigurationService } from './vs/editor/common/services/textResourceConfigurationService.js';
import { IThemeService } from './vs/platform/theme/common/themeService.js';
import { DefaultThemeService } from './vs/workbench/services/themes/tauri/defaultThemeService.js';
import { IOpenerService } from './vs/platform/opener/common/opener.js';
import { OpenerService } from './vs/editor/browser/services/openerService.js';
import { IListService, ListService } from './vs/platform/list/browser/listService.js';

// Publishes the scanned manifests and activates nothing, as it does in tscode. It is what
// makes the languages, grammars and themes extension points fire.
import { IExtensionService } from './vs/workbench/services/extensions/common/extensions.js';
import { CatalogueExtensionService } from './vs/workbench/services/extensions/tauri/catalogueExtensionService.js';
// tscode's own line, beside that one. It matters that it is here and not an import of
// `services/search/browser/searchService.js`, which registers a `RemoteSearchService` that has no
// provider.
import { ISearchService } from './vs/workbench/services/search/common/search.js';
import { TauriSearchService } from './vs/workbench/services/search/tauri/tauriSearchService.js';
// tscode's own answer for "no ML language detection", dormant here until `§12.3` gave it a reader:
// every `TextFileEditorModel` takes one, and a file's language comes from its extension either way.
import { ILanguageDetectionService } from './vs/workbench/services/languageDetection/common/languageDetectionWorkerService.js';
import { NullLanguageDetectionService } from './vs/workbench/services/languageDetection/tauri/nullLanguageDetectionService.js';

registerSingleton(IExtensionService, CatalogueExtensionService, InstantiationType.Eager);
registerSingleton(ISearchService, TauriSearchService, InstantiationType.Delayed);
registerSingleton(ILanguageDetectionService, NullLanguageDetectionService, InstantiationType.Delayed);
registerSingleton(IContextKeyService, ContextKeyService, InstantiationType.Delayed);
registerSingleton(IMarkerService, MarkerService, InstantiationType.Delayed);
registerSingleton(ITextResourceConfigurationService, TextResourceConfigurationService, InstantiationType.Delayed);
// Editor-area inputs use this opener: Markdown links are resolved by the editor-area resolver,
// while command/editor/external routing remains upstream's service.
registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed);
registerSingleton(IListService, ListService, InstantiationType.Delayed);
// `IWorkbenchThemeService` refines this same identifier, so one registration answers both — see
// `defaultThemeService.ts`.
registerSingleton(IThemeService, DefaultThemeService, InstantiationType.Delayed);

//#endregion


//#region --- workbench contributions

// `ISCMService`, which the git provider registers repositories with, and `ISCMViewService`, which
// decides which of them the view shows and in what order — tscode's own two-line contribution.
import './vs/workbench/contrib/scm/browser/scm.service.contribution.js';
// The `scm.*` configuration schema and the `scminput` language.
import './vs/workbench/contrib/scm/browser/scm.contribution.js';

// Quick access, which is a registry of its own beside `IQuickInputService` and is what `F1` and
// `Ctrl+P` reach. The first file registers the help (`?`) and commands (`>`) providers and the two
// actions behind them — `ShowAllCommandsAction` carries upstream's own `Ctrl+Shift+P` with `F1` as
// its secondary, and only the secondary reaches a terminal. The second registers
// `workbench.action.quickOpen` at upstream's own `Ctrl+P`. The default provider — the files — is
// `tui/workbench/quickAccess.ts`, because upstream registers it beside two symbol providers this
// fork has nothing to bind to.
import './vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import './vs/workbench/browser/actions/quickAccessActions.js';

// The quick diff service the git provider registers its baseline with. `QuickDiffService` is
// `common/`, but upstream registers it from a contribution file that also brings the quick-diff
// editor widgets, so it is registered here instead.
import { IQuickDiffService } from './vs/workbench/contrib/scm/common/quickDiff.js';
import { QuickDiffService } from './vs/workbench/contrib/scm/common/quickDiffService.js';

registerSingleton(IQuickDiffService, QuickDiffService, InstantiationType.Delayed);

// `keymap.contribution.ts` is deliberately **not** imported by the terminal entry. It expands
// `rowsFor('gui')` into rules
// carrying GUI chords and GUI `when` clauses, at a weight *above* the ones declared in
// `tui/workbench/commands.ts` and in the panes, over the same command ids — so a key resolves to
// a GUI copy that no terminal pane implements. That is what left `0` on
// `workbench.action.focusActiveEditorGroup` and doing nothing.
//
// The terminal cannot carry those GUI chords, so it registers only its own reachable bindings.

//#endregion

//#region --- bootstrap

import { toDisposable, Disposable } from './vs/base/common/lifecycle.js';
import { Promises } from './vs/base/common/async.js';
import { onUnexpectedError, setUnexpectedErrorHandler } from './vs/base/common/errors.js';
import { toErrorMessage } from './vs/base/common/errorMessage.js';
import { toLocalISOString } from './vs/base/common/date.js';
import { URI, UriComponents } from './vs/base/common/uri.js';
import { Schemas } from './vs/base/common/network.js';
import { basename, dirname } from './vs/base/common/resources.js';
import { ServiceCollection } from './vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from './vs/platform/instantiation/common/descriptors.js';
import { IInstantiationService } from './vs/platform/instantiation/common/instantiation.js';
import { InstantiationService } from './vs/platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from './vs/platform/instantiation/common/extensions.js';
import { IFileService } from './vs/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from './vs/platform/files/common/inMemoryFilesystemProvider.js';
import { ILogService } from './vs/platform/log/common/log.js';
import { BootstrapServices, registerBootstrapProduct } from './bootstrapServices.js';
import { IBrowserWorkbenchEnvironmentService } from './vs/workbench/services/environment/browser/environmentService.js';
import { TauriWorkbenchEnvironmentService } from './vs/workbench/services/environment/tauri/tauriEnvironmentService.js';
import { IUriIdentityService } from './vs/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from './vs/platform/uriIdentity/common/uriIdentityService.js';
import { InMemoryUserDataProfilesService } from './vs/platform/userDataProfile/common/userDataProfile.js';
import { ITelemetryService } from './vs/platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from './vs/platform/telemetry/common/telemetryUtils.js';
import { RemoteSocketFactoryService } from './vs/platform/remote/common/remoteSocketFactoryService.js';
import { IAnyWorkspaceIdentifier, IWorkspaceContextService } from './vs/platform/workspace/common/workspace.js';
import { getSingleFolderWorkspaceIdentifier } from './vs/platform/workspaces/common/workspaceIdentifier.js';
import { IWorkbenchConfigurationService } from './vs/workbench/services/configuration/common/configuration.js';
import { InMemoryStorageService, IStorageService } from './vs/platform/storage/common/storage.js';
import { IMainProcessService } from './vs/platform/ipc/common/mainProcessService.js';
import { TauriMainProcessService } from './vs/base/parts/ipc/tauri/ipc.tauri.js';
import { FILE_CHANNEL_NAME, TauriFileSystemProvider } from './vs/workbench/services/files/tauri/tauriFileSystemProvider.js';
import { checkoutRoot } from './vs/base/node/checkout.js';
import { setAppResourceRoot, setShellIntegrationWritableRoot } from './vs/platform/terminal/tauri/terminalEnvironment.js';
import { IClipboardService } from './vs/platform/clipboard/common/clipboardService.js';
import { IProgressService } from './vs/platform/progress/common/progress.js';
import { ICodeEditorService } from './vs/editor/browser/services/codeEditorService.js';
import { IHostService } from './vs/workbench/services/host/browser/host.js';
import { ILifecycleService } from './vs/workbench/services/lifecycle/common/lifecycle.js';
import { INotebookSearchService } from './vs/workbench/contrib/search/common/notebookSearch.js';
import { INotebookEditorModelResolverService } from './vs/workbench/contrib/notebook/common/notebookEditorModelResolverService.js';
import { INotebookService } from './vs/workbench/contrib/notebook/common/notebookService.js';
import { IWorkingCopyBackupService } from './vs/workbench/services/workingCopy/common/workingCopyBackup.js';
import { InMemoryWorkingCopyBackupService } from './vs/workbench/services/workingCopy/common/workingCopyBackupService.js';
import { IRequestService } from './vs/platform/request/common/request.js';
import { IContextViewService } from './vs/platform/contextview/browser/contextView.js';
import { IHoverService } from './vs/platform/hover/browser/hover.js';
import { IActivityService } from './vs/workbench/services/activity/common/activity.js';
import { ITitleService } from './vs/workbench/services/title/browser/titleService.js';
import { IWorkbenchLayoutService } from './vs/workbench/services/layout/browser/layoutService.js';
import { IQuickInputService } from './vs/platform/quickinput/common/quickInput.js';
import { IAccessibilityService } from './vs/platform/accessibility/common/accessibility.js';
import { AccessibilityService } from './vs/platform/accessibility/browser/accessibilityService.js';
import { NO_ACTIVITY, RESOURCE_CLIPBOARD, NO_CODE_EDITORS, NO_CONTEXT_VIEW, NO_HOST, NO_HOVER, NO_LIFECYCLE, NO_NOTEBOOK_MODELS, NO_NOTEBOOKS, NO_NOTEBOOK_SEARCH, NO_PROGRESS, NO_REQUESTS, NO_TITLE } from './tui/workbench/absentServices.js';
// The layer a picker is tracked on, and the picker's own model. `Overlays` is constructed before
// the container because `TerminalQuickInputService` takes it by constructor — it belongs to the
// frontend rather than to the service graph, and each frontend reaches it again on the way out.
import { Overlays } from './tui/workbench/overlay.js';
import { TerminalQuickInputService } from './tui/workbench/quickInput.js';
// The worker layer, which is `Worker` in a page and a thread here. Registering it is what lets
// tokenization run off the main thread, as it does upstream.
import { IWebWorkerService } from './vs/platform/webWorker/browser/webWorkerService.js';
import { NodeWebWorkerService } from './vs/base/node/nodeWebWorkerService.js';
// Which panels this fork has, as view containers and views. Imported for its side effect, as every
// `*.contribution.ts` above is: whichever frontend fills the side bar reads the registry it fills,
// and both read the same one — the arrangement is not a frontend question.
import './tui/workbench/contributions.js';

/**
 * The Rust side validates every path against its `WorkspaceRoots` registry, which starts
 * empty and therefore denies everything. Roots are also what narrows `assetProtocol.scope`,
 * so registering one is a single call that must not be split.
 *
 * It answers with the canonical root, and that is what the caller must go on addressing the
 * folder by: validation compares an incoming path against the roots as stored, so a folder
 * reached through a junction or a symlink would otherwise deny its own contents.
 */
async function registerWorkspaceRoot(mainProcessService: IMainProcessService, root: URI): Promise<URI> {
	return URI.revive(await mainProcessService.getChannel(FILE_CHANNEL_NAME).call<UriComponents>('registerWorkspaceRoot', root));
}

/**
 * The directory user data lives in, created and registered as a root by the backend — which
 * is the only side that can do either before the first read.
 */
async function userDataDir(mainProcessService: IMainProcessService): Promise<URI> {
	return URI.revive(await mainProcessService.getChannel(FILE_CHANNEL_NAME).call<UriComponents>('userDataDir'));
}

/** How many previous launches' log directories are kept. Upstream's number. */
const MAX_LOG_SESSIONS = 49;

/**
 * `LogsDataCleaner`'s body: every session directory beside `logsPath` except the newest
 * `MAX_LOG_SESSIONS` and the current one, which is excluded by name so a log being written is
 * never the one deleted. Two deliberate differences from
 * `workbench/contrib/logs/common/logsDataCleaner.ts`, which is not in the vendored closure
 * because nothing imports it:
 *
 * - It runs now rather than on a ten-second timer cancelled at shutdown. A window lives long
 *   enough for that timer; a driven run can be over before it fires.
 * - It sorts by name. Upstream's bare `.sort()` orders `IFileStat` objects by their string
 *   coercion, which is no ordering at all, so which directories it keeps is the order the file
 *   system happened to answer in.
 *
 * A failure is swallowed: there is no directory to read on a first run, and a log that cannot be
 * pruned is not a reason to fail a boot.
 */
async function pruneLogSessions(fileService: IFileService, logsPath: URI): Promise<void> {
	try {
		const stat = await fileService.resolve(dirname(logsPath));
		if (!stat.children) {
			return;
		}
		const currentLog = basename(logsPath);
		const allSessions = stat.children.filter(stat => stat.isDirectory && /^\d{8}T\d{6}$/.test(stat.name));
		const oldSessions = allSessions.sort((a, b) => a.name.localeCompare(b.name)).filter(d => d.name !== currentLog);
		const toDelete = oldSessions.slice(0, Math.max(0, oldSessions.length - MAX_LOG_SESSIONS));
		await Promises.settled(toDelete.map(stat => fileService.del(stat.resource, { recursive: true })));
	} catch {
		// as above
	}
}

/** What `registerFrontendServices` is given: the two boot facts a frontend's own services need. */
export interface IBootContext {
	/** Where per-user state lives, which is where a frontend caches anything it derives. */
	readonly userDataPath: URI;
	readonly logService: ILogService;
}

/**
 * The service graph, and the folder it is built over. **It mounts nothing** — it ends with an
 * `IInstantiationService` out of upstream's singleton registry, exactly where tscode's own
 * `initServices` ends, and the entry point that extends it is what mounts.
 */
export abstract class Boot extends Disposable {

	/** Held so the log can be flushed before the host it writes through is closed. */
	protected logService: ILogService | undefined;

	/** Held so the threads it started are ended when the frontend goes — see its own header. */
	protected readonly webWorkerService = this._register(new NodeWebWorkerService());

	/**
	 * The layer a picker is tracked on. `TerminalQuickInputService` takes it as a static argument,
	 * so it is built before the collection is filled — and it is what a frontend reaches on the way
	 * out to cancel a caller still waiting on an answer.
	 */
	protected readonly overlays = new Overlays();

	/** The folder this process opened, which is what a frontend titles itself after. */
	protected folder = URI.file(process.argv[2] ?? process.cwd());

	/**
	 * The identifiers whose *value* is the frontend's — a keyboard layout, a status bar, a context
	 * menu, a file dialog. They are set here rather than in the collection below because the
	 * collection is shared and these are the only entries that are not: a flag saying which frontend
	 * is running would answer the same question a worse way.
	 */
	protected abstract registerFrontendServices(serviceCollection: ServiceCollection, context: IBootContext): void;

	/**
	 * `ILogger.flush()` is `void` in upstream's interface and `FileLogger`'s is `async`, so this
	 * returns with a `readFile` and a `writeFile` still to come. What lands them is `stopHost`,
	 * which drains the transport before it closes the host the log is written through.
	 */
	flushLog(): void {
		this.logService?.flush();
	}

	protected async initServices(): Promise<{ serviceCollection: ServiceCollection }> {
		const serviceCollection = new ServiceCollection();

		// Backend. It comes first because every root the rest of boot reads from has to be
		// registered before the read: the app resource directory the extension scanner takes
		// its grammars and themes from, and the folder this process opens.
		const mainProcessService = new TauriMainProcessService();
		serviceCollection.set(IMainProcessService, mainProcessService);

		// Both directories boot reads from before anything is painted. The backend creates the
		// user data one and registers it, because a root is canonicalized as it is stored and
		// canonicalization needs the directory to be there.
		const userDataPath = await userDataDir(mainProcessService);
		const appResourceLocation = await registerWorkspaceRoot(mainProcessService, URI.file(checkoutRoot()!));
		setAppResourceRoot(appResourceLocation.fsPath);
		setShellIntegrationWritableRoot(userDataPath.fsPath);

		// Workspace
		const { workspace, restoreError } = await this.resolveWorkspace(mainProcessService);

		// Product
		const productService = registerBootstrapProduct(serviceCollection, appResourceLocation);

		// Environment. Logs go under the user data directory rather than beside it, because
		// that directory is the one root the backend registers on its own and a write outside
		// a registered root is denied.
		const logsPath = URI.joinPath(userDataPath, 'logs', toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, ''));
		const environmentService = new TauriWorkbenchEnvironmentService(userDataPath.with({ scheme: Schemas.vscodeUserData }), workspace.id, logsPath, {
			configurationDefaults: {
				// `workbench.settings.editor` decides which editor `openSettings` opens, and stock reads
				// it through `shouldOpenJsonByDefault()`. This port ships no settings editor, so `json` —
				// the setting's other stock value — is the default here, and `Ctrl+,` lands on
				// `settings.json` through upstream's own code path.
				//
				// The other two belong to the keyboard takeover. `typeNavigationMode` is `automatic` in
				// stock, which is list type-ahead consuming bare letters raw in a widget handler that runs
				// before the window-level resolver ever sees them; `trigger` leaves the letters to the
				// keymap. `enablePreview` off makes Enter on a list row open a pinned editor rather than a
				// preview one, so a row the keyboard stepped onto is not silently replaced by the next.
				//
				// `workbench.list.horizontalScrolling` is deliberately *not* here. It is off in stock,
				// which clamps a list's scroll width to its render width (`listView.ts`'s
				// `updateScrollWidth`), so the keymap's `Ctrl+Left`/`Ctrl+Right` reach
				// `list.scrollLeft`/`list.scrollRight` on a widget that cannot scroll sideways and do
				// nothing. Turning it on costs the ellipsis on every over-long row and a width measurement
				// per render, which upstream's own setting description warns about — stock behaviour was
				// judged worth more than the two keys.
				'workbench.settings.editor': 'json',
				'workbench.list.typeNavigationMode': 'trigger',
				'workbench.editor.enablePreview': false,
				// Which keystrokes a child process in an embedded region may *not* have. The list is
				// upstream's `DEFAULT_COMMANDS_TO_SKIP_SHELL` and these three are the corrections a
				// terminal frontend needs, expressed in upstream's own `-id` / `id` syntax rather
				// than in a table of ours:
				//
				// - `Tab` and `Shift+Tab` walk the editor strip here and `Ctrl+PageDown` walks it
				//   there (phase G: a terminal has no `Ctrl+PageDown` on the wire). Upstream's list
				//   holds both ids because the keys they hold there are ones no shell wants; the
				//   keys they hold *here* are ones every full-screen program wants, so they come out.
				// - `Ctrl+W` closes the editor, which is the one gesture that gets the keyboard back
				//   from a child that has stopped answering. Upstream's escape hatch is
				//   `workbench.action.terminal.toggleTerminal`, which needs a panel to toggle.
				//
				// A user who wants `Ctrl+W` in vim more than an escape hatch removes it in
				// `settings.json`, which is what makes this a default rather than a rule.
				'terminal.integrated.commandsToSkipShell': [
					'-workbench.action.nextEditor',
					'-workbench.action.previousEditor',
					'workbench.action.closeActiveEditor'
				]
			}
		}, productService);
		serviceCollection.set(IBrowserWorkbenchEnvironmentService, environmentService);

		const bootstrap = this._register(new BootstrapServices(serviceCollection, environmentService, productService));
		const { fileService, logService } = bootstrap;
		this.logService = logService;

		// `Workbench` is what listened for unhandled rejections and routed every unexpected
		// error to the log service; with no `Workbench` this is the same two lines against
		// Node's own event. Deliberately not disposed, so an error during teardown is still
		// reported — and reported to the log, not to the stdout the frontend paints on.
		process.on('unhandledRejection', reason => onUnexpectedError(reason));
		setUnexpectedErrorHandler(error => logService.error(toErrorMessage(error, true)));

		if (restoreError) {
			logService.error('Unable to open the folder this process was started on', restoreError);
		}

		// File system providers: the disk is Rust's.
		// User data is registered further down, where its provider's dependencies exist.
		const diskFileSystemProvider = this._register(new TauriFileSystemProvider(mainProcessService));
		this._register(fileService.registerProvider(Schemas.file, diskFileSystemProvider));
		fileService.registerProvider(Schemas.tmp, new InMemoryFileSystemProvider());

		// A log directory is created per launch and nothing removed one, so the directory grew
		// without bound — 1,125 sessions and 1.4 GB on the machine that found it. The removal is
		// upstream's `LogsDataCleaner`, a workbench contribution nothing starts here (§3.3), so its
		// body runs from the boot instead. It is here because it needs the `file` provider and
		// wants to be done before the run's own directory is written to.
		await pruneLogSessions(fileService, logsPath);

		// Telemetry is stubbed out rather than ported
		serviceCollection.set(ITelemetryService, NullTelemetryService);

		// The worker layer. Upstream's `WebWorkerService` constructs a `Worker`, which Node has no
		// global for; `NodeWebWorkerService` constructs a thread instead, behind the same
		// `IWebWorkerService` and the same `IWebWorker`. It is what keeps tokenization off the main
		// thread, which matters more in a terminal than in a page: the paint loop and the key
		// decoding are on it, so blocking it drops keystrokes.
		//
		// It is held rather than only registered, because the threads it starts have to be ended —
		// the one thing in this collection that is disposed on the way out, for the reason in its
		// own header.
		serviceCollection.set(IWebWorkerService, this.webWorkerService);

		// The services the vendored explorer and search models take and neither frontend has a
		// counterpart for. Each answers what its readers reach and throws on everything else —
		// see `tui/workbench/absentServices.ts`.
		serviceCollection.set(IHostService, NO_HOST);
		serviceCollection.set(ILifecycleService, NO_LIFECYCLE);
		serviceCollection.set(IClipboardService, RESOURCE_CLIPBOARD);
		serviceCollection.set(IProgressService, NO_PROGRESS);
		serviceCollection.set(IWorkbenchLayoutService, new PlatformEditorLayout(document.body) as unknown as IWorkbenchLayoutService);
		serviceCollection.set(INotebookSearchService, NO_NOTEBOOK_SEARCH);
		serviceCollection.set(IRequestService, NO_REQUESTS);
		serviceCollection.set(IContextViewService, NO_CONTEXT_VIEW);
		// Two of the three branches of the write path that need something neither frontend has: a
		// code editor to hold a model's transient properties, and a notebook to resolve a cell's
		// model from. See `§12.3`. The third — a save target to pick — is `IFileDialogService`,
		// which a window can answer and a terminal cannot, so it is the frontend's below.
		serviceCollection.set(ICodeEditorService, NO_CODE_EDITORS);
		serviceCollection.set(INotebookEditorModelResolverService, NO_NOTEBOOK_MODELS);
		serviceCollection.set(INotebookService, NO_NOTEBOOKS);
		// A backup is what a working copy writes so an unexpected exit does not lose it, and where
		// it goes is `IWorkbenchEnvironmentService.backupPath` — a path this frontend does not have.
		// The in-memory subclass is upstream's own, and the same trade `IStorageService` and
		// `IUserDataProfilesService` make below: remembered for as long as the process runs.
		serviceCollection.set(IWorkingCopyBackupService, new InMemoryWorkingCopyBackupService());
		serviceCollection.set(IHoverService, NO_HOVER);
		serviceCollection.set(IActivityService, NO_ACTIVITY);
		serviceCollection.set(ITitleService, NO_TITLE);

		// Upstream Quick Input widgets run through the terminal DOM shim. The overlay owns
		// cell paint and input transport; filtering, selection and lifetime remain upstream.
		serviceCollection.set(IQuickInputService, new SyncDescriptor(TerminalQuickInputService, [this.overlays]));

		// And the ones that are not: the keyboard layout, the status bar, the context menu and the
		// file dialog. See `registerFrontendServices`.
		this.registerFrontendServices(serviceCollection, { userDataPath, logService });

		// Accessibility. Upstream's own service, cut to the half a terminal can answer: the three
		// settings a user states — `editor.accessibilitySupport`, `workbench.reduceMotion`,
		// `workbench.reduceTransparency` — and the `accessibilityModeEnabled` context key they bind.
		// What went is what read the browser: two `matchMedia` queries and the container classes
		// they toggled. A screen reader here reads the emulator's output, which is why the setting
		// is the answer and a no-op would not be. See `§7.6` in the architecture doc.
		serviceCollection.set(IAccessibilityService, new SyncDescriptor(AccessibilityService));

		// URI Identity
		const uriIdentityService = new UriIdentityService(fileService);
		serviceCollection.set(IUriIdentityService, uriIdentityService);

		// User Data Profiles. `BrowserUserDataProfilesService` persists the profile list and its
		// workspace associations to `localStorage`; `InMemoryUserDataProfilesService` is
		// upstream's own subclass at the same seam, and the same trade `IStorageService` makes
		// below — one profile, remembered for as long as the process runs.
		const userDataProfilesService = new InMemoryUserDataProfilesService(environmentService, fileService, uriIdentityService, logService);
		const remoteSocketFactoryService = new RemoteSocketFactoryService();
		const { remoteAuthorityResolverService, configurationService } = await bootstrap.initializeWorkspace(
			workspace, diskFileSystemProvider, userDataProfilesService, uriIdentityService, remoteSocketFactoryService);

		const storageService = new InMemoryStorageService();

		await configurationService.initialize(workspace).catch(error => logService.error(error));

		serviceCollection.set(IWorkspaceContextService, configurationService);
		serviceCollection.set(IWorkbenchConfigurationService, configurationService);
		serviceCollection.set(IStorageService, storageService);
		this._register(toDisposable(() => storageService.dispose()));

		bootstrap.registerWorkspaceTrust(configurationService, storageService, uriIdentityService, remoteAuthorityResolverService);

		return { serviceCollection };
	}

	/**
	 * The singleton registry folded into the collection, exactly as `Workbench.initServices`
	 * does it — minus `IWorkbenchLayoutService`, which is the part of that method that is a
	 * layout.
	 */
	protected createInstantiationService(serviceCollection: ServiceCollection): IInstantiationService {
		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			serviceCollection.set(id, descriptor);
		}

		const instantiationService = new InstantiationService(serviceCollection, true);
		serviceCollection.set(IFileDialogService, platformFileDialogs(instantiationService));

		instantiationService.invokeFunction(accessor => {
			// TODO@Sandeep debt around cyclic dependencies
			const configurationService = accessor.get(IWorkbenchConfigurationService);
			if (configurationService && 'acquireInstantiationService' in configurationService) {
				(configurationService as { acquireInstantiationService: (instantiationService: unknown) => void }).acquireInstantiationService(instantiationService);
			}
		});

		return instantiationService;
	}

	/**
	 * The folder this process opens. tscode restores it from `localStorage` through
	 * `TauriWorkspaceProvider`; a terminal program is told on its command line instead, and
	 * defaults to the directory it was started in.
	 */
	private async resolveWorkspace(mainProcessService: IMainProcessService): Promise<{ workspace: IAnyWorkspaceIdentifier; restoreError?: unknown }> {
		const folder = this.folder;

		try {
			return { workspace: getSingleFolderWorkspaceIdentifier(await registerWorkspaceRoot(mainProcessService, folder)) };
		} catch (restoreError) {
			return { workspace: getSingleFolderWorkspaceIdentifier(folder), restoreError };
		}
	}
}

//#endregion
