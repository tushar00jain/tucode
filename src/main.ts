/*---------------------------------------------------------------------------------------------
 *  The tscode entry point.
 *
 *  Plays the role upstream splits across `workbench.common.main.ts` (side-effect imports that
 *  populate the singleton and contribution registries) and `browser/web.main.ts` (assembling
 *  the bootstrap services and starting the `Workbench`). The subsystems this port drops —
 *  extension host, debugger, tasks, chat, remote — are simply absent from the import list;
 *  everything kept is upstream's module, unmodified.
 *--------------------------------------------------------------------------------------------*/

import './styles.css';

//#region --- editor/workbench core

import './vs/editor/editor.all.js';

import './vs/workbench/browser/workbench.contribution.js';
import './vs/workbench/browser/workbench.zenMode.contribution.js';

//#endregion


//#region --- workbench actions

import './vs/workbench/browser/actions/textInputActions.js';
import './vs/workbench/browser/actions/developerActions.js';
import './vs/workbench/browser/actions/helpActions.js';
import './vs/workbench/browser/actions/layoutActions.js';
import './vs/workbench/browser/actions/listCommands.js';
import './vs/workbench/browser/actions/navigationActions.js';
import './vs/workbench/browser/actions/windowActions.js';
import './vs/workbench/browser/actions/quickAccessActions.js';
import './vs/workbench/browser/actions/widgetNavigationCommands.js';
import './vs/workbench/browser/actions/workspaceActions.js';
import './vs/workbench/browser/actions/workspaceCommands.js';

//#endregion


//#region --- workbench parts

import './vs/workbench/browser/parts/editor/editor.contribution.js';
import './vs/workbench/browser/parts/editor/editorParts.js';
import './vs/workbench/browser/parts/editor/diffEditor.workbench.contribution.js';
import './vs/workbench/browser/parts/paneCompositePartService.js';
import './vs/workbench/browser/parts/banner/bannerPart.js';
import './vs/workbench/browser/parts/statusbar/statusbarPart.js';
import './vs/workbench/browser/parts/titlebar/menubar.contribution.js';
import './vs/workbench/browser/parts/dialogs/dialog.web.contribution.js';

// Upstream imports this stylesheet from `treeView.ts` alone, which the cut into
// extension-contributed tree views takes with it — see `docs/ARCHITECTURE.md`.
import './vs/workbench/browser/parts/views/media/views.css';

//#endregion


//#region --- workbench services

import './vs/platform/actions/common/actions.contribution.js';
import './vs/platform/undoRedo/common/undoRedoService.js';
import './vs/platform/hover/browser/hoverService.js';
import './vs/platform/userInteraction/browser/userInteractionServiceImpl.js';
import './vs/platform/extensionResourceLoader/common/extensionResourceLoaderService.js';
import './vs/editor/common/services/languageFeaturesService.js';
import './vs/editor/common/services/semanticTokensStylingService.js';
import './vs/editor/common/services/treeViewsDndService.js';
import './vs/workbench/services/workspaces/common/editSessionIdentityService.js';
import './vs/workbench/services/workspaces/common/canonicalUriService.js';
import './vs/workbench/services/workspaces/browser/workspacesService.js';
import './vs/workbench/services/workspaces/browser/workspaceEditingService.js';
import './vs/workbench/services/keybinding/common/keybindingEditing.js';
// The keyboard takeover's resolver subclass, which imports and re-registers stock's service.
import './vs/workbench/services/keybinding/tauri/keybindingService.js';
import './vs/workbench/services/keybinding/browser/keyboardLayoutService.js';
import './vs/workbench/services/decorations/browser/decorationsService.js';
import './vs/workbench/services/dialogs/common/dialogService.js';
import './vs/workbench/services/dialogs/tauri/tauriFileDialogService.js';
import './vs/workbench/services/progress/browser/progressService.js';
import './vs/workbench/services/editor/browser/codeEditorService.js';
import './vs/workbench/services/editor/browser/editorService.js';
import './vs/workbench/services/editor/browser/editorResolverService.js';
import './vs/workbench/services/editor/browser/editorPaneService.js';
import './vs/workbench/services/editor/common/customEditorLabelService.js';
import './vs/workbench/services/preferences/browser/preferencesService.js';
import './vs/workbench/services/configuration/common/jsonEditingService.js';
// The shell environment, and the variable resolver that reads `${env:…}` out of it. Stock's
// browser build resolves that family against an empty environment; its desktop build reads the
// same `IShellEnvironmentService` this does.
import './vs/workbench/services/environment/tauri/shellEnvironmentService.js';
import './vs/workbench/services/configurationResolver/tauri/configurationResolverService.js';
import './vs/workbench/services/textmodelResolver/common/textModelResolverService.js';
import './vs/workbench/services/textresourceProperties/common/textResourcePropertiesService.js';
import './vs/workbench/services/textfile/common/textEditorService.js';
import './vs/workbench/services/textfile/browser/browserTextFileService.js';
import './vs/workbench/services/untitled/common/untitledTextEditorService.js';
import './vs/workbench/services/history/browser/historyService.js';
import './vs/workbench/services/activity/browser/activityService.js';
import './vs/workbench/services/language/common/languageService.js';
import './vs/workbench/services/model/common/modelService.js';
import './vs/workbench/services/commands/common/commandService.js';
import './vs/workbench/services/label/common/labelService.js';
import './vs/workbench/services/notification/common/notificationService.js';
import './vs/workbench/services/userDataSync/common/userDataSyncUtil.js';
import './vs/workbench/services/userDataProfile/browser/userDataProfileStorageService.js';
import './vs/workbench/services/workingCopy/common/workingCopyService.js';
import './vs/workbench/services/workingCopy/common/workingCopyFileService.js';
import './vs/workbench/services/workingCopy/common/workingCopyEditorService.js';
import './vs/workbench/services/workingCopy/browser/workingCopyBackupService.js';
import './vs/workbench/services/workingCopy/browser/workingCopyHistoryService.js';
import './vs/workbench/services/filesConfiguration/common/filesConfigurationService.js';
import './vs/workbench/services/files/browser/elevatedFileService.js';
import './vs/workbench/services/views/browser/viewDescriptorService.js';
import './vs/workbench/services/views/browser/viewsService.js';
import './vs/workbench/services/quickinput/browser/quickInputService.js';
import './vs/workbench/services/host/browser/browserHostService.js';
import './vs/workbench/services/lifecycle/browser/lifecycleService.js';
import './vs/workbench/services/clipboard/browser/clipboardService.js';
import './vs/workbench/services/localization/browser/localeService.js';
import './vs/workbench/services/path/browser/pathService.js';
// `TerminalLinkManager` takes this by constructor, so the terminal's link contribution needs it
// registered. Upstream's browser workbench registers the same service; with no remote authority
// its `canTunnel` answers false, so it is inert here.
import './vs/workbench/services/tunnel/browser/tunnelService.js';
import './vs/workbench/services/update/browser/updateService.js';
import './vs/workbench/services/url/browser/urlService.js';
import './vs/workbench/services/encryption/browser/encryptionService.js';
import './vs/workbench/services/secrets/browser/secretStorageService.js';
import './vs/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import './vs/workbench/services/extensionManagement/browser/extensionsProfileScannerService.js';
import './vs/workbench/services/extensionManagement/browser/extensionGalleryManifestService.js';
import './vs/workbench/services/extensionManagement/common/extensionGalleryService.js';
import './vs/workbench/services/extensions/common/extensionManifestPropertiesService.js';
import './vs/workbench/services/aiRelatedInformation/common/aiRelatedInformationService.js';
import './vs/workbench/services/dataChannel/browser/dataChannelService.js';
import './vs/workbench/services/outline/browser/outlineService.js';
import './vs/workbench/services/log/common/defaultLogLevels.js';

// Themes and tokenization: the whole pathway stays upstream's — the colour registry, the theme
// service reading bundled theme JSON, and TextMate tokenization in a worker. The terminal needs
// it as much as the editor does: its ANSI palette, foreground and background are registry
// colours, like the workbench chrome around them.
import './vs/workbench/services/themes/browser/workbenchThemeService.js';
import './vs/workbench/services/themes/browser/browserHostColorSchemeService.js';
import './vs/workbench/services/textMate/browser/textMateTokenizationFeature.contribution.js';
// Every `TextModel` builds a `TokenizationTextModelPart`, which takes both tree-sitter
// services by constructor. The library service loads its wasm lazily behind
// `editor.experimental.preferTreeSitter.<lang>`, which is off, so registering it costs
// nothing and tokenization stays TextMate's.
import './vs/workbench/services/treeSitter/browser/treeSitter.contribution.js';

import { InstantiationType, registerSingleton } from './vs/platform/instantiation/common/extensions.js';
import { ContextViewService } from './vs/platform/contextview/browser/contextViewService.js';
import { IContextMenuService, IContextViewService } from './vs/platform/contextview/browser/contextView.js';
import { ContextMenuService } from './vs/platform/contextview/browser/contextMenuService.js';
import { IListService, ListService } from './vs/platform/list/browser/listService.js';
import { MarkerDecorationsService } from './vs/editor/common/services/markerDecorationsService.js';
import { IMarkerDecorationsService } from './vs/editor/common/services/markerDecorations.js';
import { IMarkerService } from './vs/platform/markers/common/markers.js';
import { MarkerService } from './vs/platform/markers/common/markerService.js';
import { ContextKeyService } from './vs/platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from './vs/platform/contextkey/common/contextkey.js';
import { ITextResourceConfigurationService } from './vs/editor/common/services/textResourceConfiguration.js';
import { TextResourceConfigurationService } from './vs/editor/common/services/textResourceConfigurationService.js';
import { OpenerService } from './vs/editor/browser/services/openerService.js';
import { IOpenerService } from './vs/platform/opener/common/opener.js';
import { IWebWorkerService } from './vs/platform/webWorker/browser/webWorkerService.js';
import { BundlerWebWorkerService } from './vs/platform/webWorker/tauri/bundlerWebWorkerService.js';
import { IAccessibilityService } from './vs/platform/accessibility/common/accessibility.js';
import { AccessibilityService } from './vs/platform/accessibility/browser/accessibilityService.js';
import { AccessibilitySignalService, IAccessibilitySignalService } from './vs/platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ITitleService } from './vs/workbench/services/title/browser/titleService.js';
import { BrowserTitleService } from './vs/workbench/browser/parts/titlebar/titlebarPart.js';
import { ITimerService, TimerService } from './vs/workbench/services/timer/browser/timerService.js';
import { IDiagnosticsService, NullDiagnosticsService } from './vs/platform/diagnostics/common/diagnostics.js';
import { ILanguagePackService } from './vs/platform/languagePacks/common/languagePacks.js';
import { WebLanguagePacksService } from './vs/platform/languagePacks/browser/languagePacks.js';
import { IAllowedExtensionsService } from './vs/platform/extensionManagement/common/extensionManagement.js';
import { AllowedExtensionsService } from './vs/platform/extensionManagement/common/allowedExtensionsService.js';
import { ILanguageDetectionService } from './vs/workbench/services/languageDetection/common/languageDetectionWorkerService.js';
import { NullLanguageDetectionService } from './vs/workbench/services/languageDetection/tauri/nullLanguageDetectionService.js';
import { INotebookService } from './vs/workbench/contrib/notebook/common/notebookService.js';
import { NotebookService } from './vs/workbench/contrib/notebook/browser/services/notebookServiceImpl.js';
import { INotebookEditorService } from './vs/workbench/contrib/notebook/browser/services/notebookEditorService.js';
import { NotebookEditorWidgetService } from './vs/workbench/contrib/notebook/browser/services/notebookEditorServiceImpl.js';
import { INotebookEditorModelResolverService } from './vs/workbench/contrib/notebook/common/notebookEditorModelResolverService.js';
import { NotebookModelResolverServiceImpl } from './vs/workbench/contrib/notebook/common/notebookEditorModelResolverServiceImpl.js';
import { INotebookLoggingService } from './vs/workbench/contrib/notebook/common/notebookLoggingService.js';
import { NotebookLoggingService } from './vs/workbench/contrib/notebook/browser/services/notebookLoggingServiceImpl.js';

registerSingleton(IContextViewService, ContextViewService, InstantiationType.Delayed);
registerSingleton(IContextMenuService, ContextMenuService, InstantiationType.Delayed);
registerSingleton(IListService, ListService, InstantiationType.Delayed);
registerSingleton(IMarkerDecorationsService, MarkerDecorationsService, InstantiationType.Delayed);
registerSingleton(IMarkerService, MarkerService, InstantiationType.Delayed);
registerSingleton(IContextKeyService, ContextKeyService, InstantiationType.Delayed);
registerSingleton(ITextResourceConfigurationService, TextResourceConfigurationService, InstantiationType.Delayed);
registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed);
registerSingleton(IWebWorkerService, BundlerWebWorkerService, InstantiationType.Delayed);
registerSingleton(IAccessibilityService, AccessibilityService, InstantiationType.Delayed);
// Upstream registers this from `contrib/accessibilitySignals`, whose contributions reach into
// the debugger; the registration itself is all this app needs, and the terminal's accessibility
// contribution plays the signals.
registerSingleton(IAccessibilitySignalService, AccessibilitySignalService, InstantiationType.Delayed);
registerSingleton(ITitleService, BrowserTitleService, InstantiationType.Eager);
registerSingleton(ITimerService, TimerService, InstantiationType.Delayed);
registerSingleton(IDiagnosticsService, NullDiagnosticsService, InstantiationType.Delayed);
registerSingleton(ILanguagePackService, WebLanguagePacksService, InstantiationType.Delayed);
// Every text editor model takes this by constructor, so it has to be registered even though
// this port does not ship ML language detection.
registerSingleton(ILanguageDetectionService, NullLanguageDetectionService, InstantiationType.Delayed);
// Upstream registers this from `workbench.common.main.ts`; the gallery service takes it by
// constructor, and with no gallery configured it answers from the allow-list setting alone.
registerSingleton(IAllowedExtensionsService, AllowedExtensionsService, InstantiationType.Delayed);

// The search view, its result model and its replace service all take these by constructor,
// because notebook search is part of search. Upstream registers them from
// `notebook.contribution.ts`, which also brings the notebook editor this port does not ship.
registerSingleton(INotebookService, NotebookService, InstantiationType.Delayed);
registerSingleton(INotebookEditorService, NotebookEditorWidgetService, InstantiationType.Delayed);
registerSingleton(INotebookEditorModelResolverService, NotebookModelResolverServiceImpl, InstantiationType.Delayed);
// The model resolver and every notebook model it builds log through this one.
registerSingleton(INotebookLoggingService, NotebookLoggingService, InstantiationType.Delayed);

//#endregion


//#region --- tauri-backed services

import { IExtensionService } from './vs/workbench/services/extensions/common/extensions.js';
import { CatalogueExtensionService } from './vs/workbench/services/extensions/tauri/catalogueExtensionService.js';
import { ISearchService } from './vs/workbench/services/search/common/search.js';
import { TauriSearchService } from './vs/workbench/services/search/tauri/tauriSearchService.js';

// Publishes the scanned manifests and activates nothing. The terminal calls `activateByEvent`
// six times from `terminalService.ts`; the catalogue answers those without an extension host.
registerSingleton(IExtensionService, CatalogueExtensionService, InstantiationType.Eager);

registerSingleton(ISearchService, TauriSearchService, InstantiationType.Delayed);

// `TauriExtensionsScannerService` takes the app resource directory, which is only known at
// runtime, so it is registered from `initServices` rather than here.

//#endregion


//#region --- the terminal backend

import { registerWorkbenchContribution2, WorkbenchPhase } from './vs/workbench/common/contributions.js';
import { ITerminalProfileResolverService } from './vs/workbench/contrib/terminal/common/terminal.js';
import { TauriTerminalBackendContribution } from './vs/workbench/contrib/terminal/tauri/tauriTerminalBackend.js';
import { TauriTerminalProfileResolverService } from './vs/workbench/contrib/terminal/tauri/terminalProfileResolverService.js';

registerSingleton(ITerminalProfileResolverService, TauriTerminalProfileResolverService, InstantiationType.Delayed);

// Upstream registers the backend from `electron-browser/terminal.contribution.ts`, at startup
// so it is available before anything asks for a terminal.
registerWorkbenchContribution2(TauriTerminalBackendContribution.ID, TauriTerminalBackendContribution, WorkbenchPhase.BlockStartup);

//#endregion


//#region --- workbench contributions

// Editor and workbench chrome the views build on
import './vs/workbench/contrib/bulkEdit/browser/bulkEditService.js';
import './vs/workbench/contrib/bulkEdit/browser/preview/bulkEdit.contribution.js';
import './vs/workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import './vs/workbench/contrib/codeEditor/browser/outline/documentSymbolsOutline.js';
import './vs/workbench/contrib/list/browser/list.contribution.js';
import './vs/workbench/contrib/sash/browser/sash.contribution.js';
import './vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import './vs/workbench/contrib/snippets/browser/snippets.service.contribution.js';
// `InlineCompletionsController` is an eventual editor contribution, so every code editor the
// workbench builds reaches `RenameSymbolTrackerService` through it. Upstream registers it from
// `inlineCompletions.contribution.ts`, whose other halves are chat's.
import './vs/workbench/contrib/inlineCompletions/browser/renameSymbolTrackerService.js';
import './vs/workbench/contrib/accessibility/browser/accessibility.contribution.js';
// The settings and keybindings commands. Upstream's contribution also registers the settings
// editor, the keybindings editor and everything gated on them; those are cut, so what is left
// is the family that opens the JSON files — which is where this port's settings live.
import './vs/workbench/contrib/preferences/browser/preferences.contribution.js';
// `?` — the keys quick pick. The keybindings editor being cut is why this exists: it takes over
// `workbench.action.openGlobalKeybindings`, an id nothing else in this tree registers.
import './vs/workbench/contrib/keybindings/tauri/keys.contribution.js';
import './vs/workbench/contrib/themes/browser/themes.contribution.js';
import './vs/workbench/contrib/timeline/browser/timeline.contribution.js';
import './vs/workbench/contrib/timeline/browser/timeline.service.contribution.js';
import './vs/workbench/contrib/localHistory/browser/localHistory.contribution.js';
import './vs/workbench/contrib/workspace/browser/workspace.contribution.js';
import './vs/workbench/contrib/workspaces/browser/workspaces.contribution.js';
// Every window needs this one, which is why upstream lists it in `workbench.common.main.ts`
// too: it registers the file editor factory, and `TextEditorService` — which `EditorService`
// takes by constructor, and the workbench's own startup reaches — asserts on it being there.
import './vs/workbench/contrib/files/browser/files.contribution.js';

// Explorer
import './vs/workbench/contrib/files/browser/explorerViewlet.js';
import './vs/workbench/contrib/files/browser/fileActions.contribution.js';

// Search
import './vs/workbench/contrib/search/browser/search.contribution.js';
import './vs/workbench/contrib/search/browser/searchView.js';
import './vs/workbench/contrib/searchEditor/browser/searchEditor.contribution.js';

// SCM
import './vs/workbench/contrib/scm/browser/scm.contribution.js';
import './vs/workbench/contrib/scm/browser/quickDiff.contribution.js';
import './vs/workbench/contrib/scm/browser/scm.service.contribution.js';
// The git provider itself. Upstream's is the git extension talking to an extension host;
// this port has neither, so the provider is a workbench contribution over the `scm` channel.
import './vs/workbench/contrib/scm/tauri/git.contribution.js';
// Sapling's smartlog, in its own activity-bar container. The graph is drawn by Sapling's own
// `render.ts`, over the `sl` channel.
import './vs/workbench/contrib/sapling/tauri/sapling.contribution.js';
import './vs/workbench/contrib/multiDiffEditor/browser/multiDiffEditor.contribution.js';

// Markdown preview. Upstream's is `extensions/markdown-language-features` painting markdown-it
// into a webview; this port has no extension host, so the preview is an editor pane rendering
// through `IMarkdownRendererService`.
import './vs/workbench/contrib/markdown/tauri/markdownPreview.contribution.js';

// The terminal, its feature contributions, and the panel view that hosts them.
import './vs/workbench/contrib/terminal/terminal.all.js';

// The keyboard model: the rows, and the small commands upstream does not already have.
import './vs/workbench/browser/tauri/keymap.contribution.js';

// The modal editor — a viewer until `V`, then vim. The engine is vendored under `src/vendor/`;
// only the adapter under it is ours.
import './vs/workbench/contrib/vim/tauri/vim.contribution.js';

//#endregion


//#region --- bootstrap

import { resourceDir } from '@tauri-apps/api/path';
import { detectFullscreen, domContentLoaded, getWindow } from './vs/base/browser/dom.js';
import { setFullscreen } from './vs/base/browser/browser.js';
import { mainWindow } from './vs/base/browser/window.js';
import { Disposable, toDisposable } from './vs/base/common/lifecycle.js';
import { onUnexpectedError } from './vs/base/common/errors.js';
import { mark } from './vs/base/common/performance.js';
import { toLocalISOString } from './vs/base/common/date.js';
import { URI, UriComponents } from './vs/base/common/uri.js';
import { Schemas } from './vs/base/common/network.js';
import { IndexedDB } from './vs/base/browser/indexedDB.js';
import { ServiceCollection } from './vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from './vs/platform/instantiation/common/descriptors.js';
import { IExtensionsScannerService } from './vs/platform/extensionManagement/common/extensionsScannerService.js';
import { TauriExtensionsScannerService } from './vs/platform/extensionManagement/tauri/extensionsScannerService.js';
import { IFileService } from './vs/platform/files/common/files.js';
import { FileService } from './vs/platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from './vs/platform/files/common/inMemoryFilesystemProvider.js';
import { IndexedDBFileSystemProvider } from './vs/platform/files/browser/indexedDBFileSystemProvider.js';
import { FileUserDataProvider } from './vs/platform/userData/common/fileUserDataProvider.js';
import { ConsoleLogger, getLogLevel, ILogger, ILoggerService, ILogService } from './vs/platform/log/common/log.js';
import { LogService } from './vs/platform/log/common/logService.js';
import { BufferLogger } from './vs/platform/log/common/bufferLog.js';
import { FileLoggerService } from './vs/platform/log/common/fileLog.js';
import { windowLogGroup, windowLogId } from './vs/workbench/services/log/common/logConstants.js';
import product from './vs/platform/product/common/product.js';
import { IProductService } from './vs/platform/product/common/productService.js';
import { setAppResourceRoot } from './vs/platform/terminal/tauri/terminalEnvironment.js';
import { IBrowserWorkbenchEnvironmentService } from './vs/workbench/services/environment/browser/environmentService.js';
import { TauriWorkbenchEnvironmentService } from './vs/workbench/services/environment/tauri/tauriEnvironmentService.js';
import { IUriIdentityService } from './vs/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from './vs/platform/uriIdentity/common/uriIdentityService.js';
import { IUserDataProfilesService } from './vs/platform/userDataProfile/common/userDataProfile.js';
import { BrowserUserDataProfilesService } from './vs/platform/userDataProfile/browser/userDataProfile.js';
import { IUserDataInitializationService, UserDataInitializationService } from './vs/workbench/services/userData/browser/userDataInit.js';
import { IUserDataProfileService } from './vs/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from './vs/workbench/services/userDataProfile/common/userDataProfileService.js';
import { IPolicyService, NullPolicyService } from './vs/platform/policy/common/policy.js';
import { ITelemetryService } from './vs/platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from './vs/platform/telemetry/common/telemetryUtils.js';
import { IRequestService } from './vs/platform/request/common/request.js';
import { BrowserRequestService } from './vs/workbench/services/request/browser/requestService.js';
import { ISignService } from './vs/platform/sign/common/sign.js';
import { SignService } from './vs/platform/sign/browser/signService.js';
import { IRemoteAuthorityResolverService, RemoteConnectionType } from './vs/platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from './vs/platform/remote/browser/remoteAuthorityResolverService.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from './vs/platform/remote/common/remoteSocketFactoryService.js';
import { BrowserSocketFactory } from './vs/platform/remote/browser/browserSocketFactory.js';
import { IRemoteAgentService } from './vs/workbench/services/remote/common/remoteAgentService.js';
import { RemoteAgentService } from './vs/workbench/services/remote/browser/remoteAgentService.js';
import { IAnyWorkspaceIdentifier, IWorkspaceContextService, UNKNOWN_EMPTY_WINDOW_WORKSPACE } from './vs/platform/workspace/common/workspace.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from './vs/platform/workspaces/common/workspaceIdentifier.js';
import { isFolderToOpen } from './vs/platform/window/common/window.js';
import { IWorkspaceProvider } from './vs/workbench/browser/web.api.js';
import { TauriWorkspaceProvider } from './vs/workbench/browser/tauri/tauriWorkspaceProvider.js';
import { IWorkbenchConfigurationService } from './vs/workbench/services/configuration/common/configuration.js';
import { WorkspaceService } from './vs/workbench/services/configuration/browser/configurationService.js';
import { ConfigurationCache } from './vs/workbench/services/configuration/common/configurationCache.js';
import { IStorageService } from './vs/platform/storage/common/storage.js';
import { BrowserStorageService } from './vs/workbench/services/storage/browser/storageService.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from './vs/platform/workspace/common/workspaceTrust.js';
import { WorkspaceTrustEnablementService, WorkspaceTrustManagementService } from './vs/workbench/services/workspaces/common/workspaceTrust.js';
import { IMainProcessService } from './vs/platform/ipc/common/mainProcessService.js';
import { TauriMainProcessService } from './vs/base/parts/ipc/tauri/ipc.tauri.js';
import { FILE_CHANNEL_NAME, TauriFileSystemProvider } from './vs/workbench/services/files/tauri/tauriFileSystemProvider.js';
import { Workbench } from './vs/workbench/browser/workbench.js';
import { BrowserWindow } from './vs/workbench/browser/window.js';
import { installSettledSignal } from './vs/workbench/browser/tauri/settled.js';

/**
 * What the app boots with: the workspace identifier this window opens, the provider behind it,
 * and a folder that could not be reopened, to be logged once there is a log service to log it
 * to.
 */
interface IBootWorkspace {
	readonly workspace: IAnyWorkspaceIdentifier;
	readonly workspaceProvider?: IWorkspaceProvider;
	readonly restoreError?: unknown;
}

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
 *
 * It comes back under `vscode-userdata:`, the scheme `userRoamingDataHome` is addressed by;
 * `FileUserDataProvider` is what maps it back onto `file:` for the reads and writes.
 */
async function userDataDir(mainProcessService: IMainProcessService): Promise<URI> {
	const home = URI.revive(await mainProcessService.getChannel(FILE_CHANNEL_NAME).call<UriComponents>('userDataDir'));

	return home.with({ scheme: Schemas.vscodeUserData });
}

class WorkbenchMain extends Disposable {

	constructor(private readonly parent: HTMLElement) {
		super();

		setFullscreen(!!detectFullscreen(mainWindow), mainWindow);
	}

	async open(): Promise<void> {

		// Init services and wait for DOM to be ready in parallel
		const [services] = await Promise.all([this.initServices(), domContentLoaded(getWindow(this.parent))]);

		const workbench = new Workbench(this.parent, undefined, services.serviceCollection, services.logService);
		this._register(workbench.onDidShutdown(() => this.dispose()));

		const instantiationService = workbench.startup();

		this._register(instantiationService.createInstance(BrowserWindow));
	}

	private async initServices(): Promise<{ serviceCollection: ServiceCollection; logService: ILogService }> {
		const serviceCollection = new ServiceCollection();

		// Backend. It comes first because every root the rest of boot reads from has to be
		// registered before the read: the app resource directory the extension scanner takes
		// its grammars and themes from, and the folder the window restores.
		const mainProcessService = new TauriMainProcessService();
		serviceCollection.set(IMainProcessService, mainProcessService);

		// Both directories boot reads from before the workbench exists. The backend creates the
		// user data one and registers it, because a root is canonicalized as it is stored and
		// canonicalization needs the directory to be there.
		const userDataHome = await userDataDir(mainProcessService);
		const appResourceLocation = await registerWorkspaceRoot(mainProcessService, URI.file(await resourceDir()));
		serviceCollection.set(IExtensionsScannerService, new SyncDescriptor(TauriExtensionsScannerService, [appResourceLocation]));
		// The app resource directory holds the shell integration scripts as well as the colour
		// themes, and the vendored `terminalEnvironment.ts` resolves them by path.
		setAppResourceRoot(appResourceLocation.fsPath);

		// Workspace
		const { workspace, workspaceProvider, restoreError } = await this.resolveWorkspace(mainProcessService);

		// Product
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		serviceCollection.set(IProductService, productService);

		// Environment
		const logsPath = URI.file(toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '')).with({ scheme: 'vscode-log' });
		// `workbench.settings.editor` decides which editor `openSettings` opens, and stock reads it
		// through `shouldOpenJsonByDefault()`. This port ships no settings editor, so `json` — the
		// setting's other stock value — is the default here, and Ctrl+, lands on `settings.json`
		// through upstream's own code path. A user can still set it back, and get nothing.
		//
		// The other two belong to the keyboard takeover. `typeNavigationMode` is `automatic` in
		// stock, which is list type-ahead consuming bare letters raw in a widget handler that runs
		// before the window-level resolver ever sees them; `trigger` leaves the letters to the
		// keymap. `enablePreview` off makes Enter on a list row open a pinned editor rather than a
		// preview one, so a row the keyboard stepped onto is not silently replaced by the next.
		//
		// `workbench.list.horizontalScrolling` is deliberately *not* here. It is off in stock, which
		// clamps a list's scroll width to its render width (`listView.ts`'s `updateScrollWidth`), so
		// the keymap's `Ctrl+Left`/`Ctrl+Right` reach `list.scrollLeft`/`list.scrollRight` on a
		// widget that cannot scroll sideways and do nothing. Turning it on costs the ellipsis on
		// every over-long row and a width measurement per render, which upstream's own setting
		// description warns about — the user's ruling is that stock behaviour is worth more than the
		// two keys. A user who sets it themselves gets the keys, since the rows are registered
		// either way. `TODO.md` carries it.
		const environmentService = new TauriWorkbenchEnvironmentService(userDataHome, workspace.id, logsPath, {
			workspaceProvider,
			configurationDefaults: {
				'workbench.settings.editor': 'json',
				'workbench.list.typeNavigationMode': 'trigger',
				'workbench.editor.enablePreview': false
			}
		}, productService);
		serviceCollection.set(IBrowserWorkbenchEnvironmentService, environmentService);

		// Files
		const fileLogger = new BufferLogger();
		const fileService = this._register(new FileService(fileLogger));
		serviceCollection.set(IFileService, fileService);

		// Logger
		const loggerService = new FileLoggerService(getLogLevel(environmentService), logsPath, fileService);
		serviceCollection.set(ILoggerService, loggerService);

		// Log
		const otherLoggers: ILogger[] = [new ConsoleLogger(loggerService.getLogLevel())];
		const logger = loggerService.createLogger(environmentService.logFile, { id: windowLogId, name: windowLogGroup.name, group: windowLogGroup });
		const logService = new LogService(logger, otherLoggers);
		serviceCollection.set(ILogService, logService);

		// Set the logger of the fileLogger after the log service is ready.
		// This is to avoid cyclic dependency
		fileLogger.logger = logService;

		if (restoreError) {
			logService.error('Unable to reopen the folder from the previous session', restoreError);
		}

		// File system providers: the disk is Rust's, logs stay in the renderer's IndexedDB.
		// User data is registered further down, where its provider's dependencies exist.
		const diskFileSystemProvider = this._register(new TauriFileSystemProvider(mainProcessService));
		this._register(fileService.registerProvider(Schemas.file, diskFileSystemProvider));
		await this.registerIndexedDBFileSystemProviders(fileService, logService, logsPath);

		// Telemetry is stubbed out rather than ported
		serviceCollection.set(ITelemetryService, NullTelemetryService);

		// URI Identity
		const uriIdentityService = new UriIdentityService(fileService);
		serviceCollection.set(IUriIdentityService, uriIdentityService);

		// User Data Profiles
		const userDataProfilesService = new BrowserUserDataProfilesService(environmentService, fileService, uriIdentityService, logService);
		serviceCollection.set(IUserDataProfilesService, userDataProfilesService);

		// Use FileUserDataProvider for user data to
		// enable atomic read / write operations.
		this._register(fileService.registerProvider(Schemas.vscodeUserData, this._register(new FileUserDataProvider(Schemas.file, diskFileSystemProvider, Schemas.vscodeUserData, userDataProfilesService, uriIdentityService, logService))));

		const currentProfile = userDataProfilesService.getProfileForWorkspace(workspace) ?? userDataProfilesService.defaultProfile;
		await userDataProfilesService.setProfileForWorkspace(workspace, currentProfile);
		const userDataProfileService = new UserDataProfileService(currentProfile);
		serviceCollection.set(IUserDataProfileService, userDataProfileService);

		// No settings sync and no profile to seed from, so there is nothing to initialize —
		// the empty initializer list upstream also builds when neither is configured.
		serviceCollection.set(IUserDataInitializationService, new UserDataInitializationService());

		// Policies are a management feature we do not ship
		const policyService = new NullPolicyService();
		serviceCollection.set(IPolicyService, policyService);

		// Remote. No authority is ever resolved, but `WorkspaceService`, workspace trust and
		// `BaseTerminalProfileResolverService` take these as constructor arguments, so the
		// upstream stack is assembled and stays inert.
		const remoteAuthorityResolverService = new RemoteAuthorityResolverService(false, undefined, undefined, undefined, productService, logService);
		serviceCollection.set(IRemoteAuthorityResolverService, remoteAuthorityResolverService);
		const signService = new SignService(productService);
		serviceCollection.set(ISignService, signService);
		const remoteSocketFactoryService = new RemoteSocketFactoryService();
		remoteSocketFactoryService.register(RemoteConnectionType.WebSocket, new BrowserSocketFactory(undefined));
		serviceCollection.set(IRemoteSocketFactoryService, remoteSocketFactoryService);
		const remoteAgentService = this._register(new RemoteAgentService(remoteSocketFactoryService, userDataProfileService, environmentService, productService, remoteAuthorityResolverService, signService, logService));
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		// Configuration and Storage
		const configurationCache = new ConfigurationCache([Schemas.file, Schemas.vscodeUserData, Schemas.tmp], environmentService, fileService);
		const configurationService = new WorkspaceService({ configurationCache }, environmentService, userDataProfileService, userDataProfilesService, fileService, remoteAgentService, uriIdentityService, logService, policyService);
		const storageService = new BrowserStorageService(workspace, userDataProfileService, logService);

		await Promise.all([
			configurationService.initialize(workspace).catch(error => logService.error(error)),
			storageService.initialize().catch(error => logService.error(error))
		]);

		serviceCollection.set(IWorkspaceContextService, configurationService);
		serviceCollection.set(IWorkbenchConfigurationService, configurationService);
		serviceCollection.set(IStorageService, storageService);
		this._register(toDisposable(() => storageService.close()));

		// Request. Upstream's browser service, which the extension gallery takes by constructor.
		serviceCollection.set(IRequestService, new BrowserRequestService(remoteAgentService, configurationService, loggerService));

		// Workspace Trust
		const workspaceTrustEnablementService = new WorkspaceTrustEnablementService(configurationService, environmentService);
		serviceCollection.set(IWorkspaceTrustEnablementService, workspaceTrustEnablementService);

		const workspaceTrustManagementService = new WorkspaceTrustManagementService(configurationService, remoteAuthorityResolverService, storageService, uriIdentityService, environmentService, configurationService, workspaceTrustEnablementService, fileService);
		serviceCollection.set(IWorkspaceTrustManagementService, workspaceTrustManagementService);

		configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted());
		this._register(workspaceTrustManagementService.onDidChangeTrust(() => configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted())));

		return { serviceCollection, logService };
	}

	/**
	 * Turns what the workspace provider restored into this window's workspace identifier,
	 * registering the folder as a Rust root on the way — an unregistered root denies every
	 * read beneath it. A folder that can no longer be opened is forgotten and the window
	 * boots empty.
	 */
	private async resolveWorkspace(mainProcessService: IMainProcessService): Promise<IBootWorkspace> {

		// The provider both restores the folder this window last had open and is what the host
		// service opens the next one through.
		const workspaceProvider = TauriWorkspaceProvider.create();

		const restored = workspaceProvider.workspace;
		if (!restored) {
			return { workspace: UNKNOWN_EMPTY_WINDOW_WORKSPACE, workspaceProvider };
		}

		try {
			if (isFolderToOpen(restored)) {
				return { workspace: getSingleFolderWorkspaceIdentifier(await registerWorkspaceRoot(mainProcessService, restored.folderUri)), workspaceProvider };
			}

			return { workspace: getWorkspaceIdentifier(await registerWorkspaceRoot(mainProcessService, restored.workspaceUri)), workspaceProvider };
		} catch (restoreError) {
			workspaceProvider.forget();

			return { workspace: UNKNOWN_EMPTY_WINDOW_WORKSPACE, workspaceProvider, restoreError };
		}
	}

	private async registerIndexedDBFileSystemProviders(fileService: IFileService, logService: ILogService, logsPath: URI): Promise<void> {
		const logsStore = 'vscode-logs-store';
		const handlesStore = 'vscode-filehandles-store';

		let indexedDB: IndexedDB | undefined;
		try {
			indexedDB = await IndexedDB.create('vscode-web-db', 3, [logsStore, handlesStore]);
			this._register(toDisposable(() => indexedDB?.close()));
		} catch (error) {
			logService.error('Error while creating IndexedDB', error);
		}

		if (indexedDB) {
			fileService.registerProvider(logsPath.scheme, this._register(new IndexedDBFileSystemProvider(logsPath.scheme, indexedDB, logsStore, false)));
		} else {
			logService.info('Using in-memory log provider');
			fileService.registerProvider(logsPath.scheme, new InMemoryFileSystemProvider());
		}

		fileService.registerProvider(Schemas.tmp, new InMemoryFileSystemProvider());
	}
}

// Mounts the workbench into the window body. The load mark, the mount and the error handler are
// one sequence: a boot that throws before the workbench exists has nothing else to report it.
mark('code/didLoadWorkbenchMain');

// Before the workbench, because it wraps the methods the views' first fetches go through and a
// wrapper installed after them would not see the work they had already started.
installSettledSignal();

new WorkbenchMain(mainWindow.document.body).open().catch(error => onUnexpectedError(error));

//#endregion
