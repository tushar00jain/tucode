/*---------------------------------------------------------------------------------------------
 *  The Mac WKWebView entry point.
 *
 *  This is intentionally not a Workbench entry point. It creates the VS Code service graph and
 *  mounts one CodeEditorWidget. AppKit owns tabs and all surrounding application chrome.
 *--------------------------------------------------------------------------------------------*/

import { invoke as invokeNativeNavigator } from './editor/nativeTransport.js';
import { NativeOutlineUpdates } from './editor/nativeOutlineUpdates.js';

import './vs/workbench/browser/media/style.css';
import './styles.css';

//#region --- editor core

import './vs/editor/editor.all.js';

import './vs/workbench/browser/actions/textInputActions.js';
import './vs/workbench/browser/parts/titlebar/menubar.contribution.js';
import './vs/workbench/browser/actions/quickAccessActions.js';
import './vs/workbench/browser/actions/openFileAction.js';
import './vs/workbench/browser/actions/openFolderAction.js';
import './vs/workbench/browser/actions/openFileFolderAction.js';
import './editor/macWindowConfiguration.js';
import './editor/macWindowActions.js';
import './vs/workbench/browser/actions/widgetNavigationCommands.js';

//#endregion


//#region --- workbench services

import './vs/platform/actions/common/actions.contribution.js';
import './vs/platform/undoRedo/common/undoRedoService.js';
import './vs/platform/hover/browser/hoverService.js';
import './vs/platform/userInteraction/browser/userInteractionServiceImpl.js';
import './vs/platform/extensionResourceLoader/common/extensionResourceLoaderService.js';
import './vs/editor/common/services/languageFeaturesService.js';
import './vs/editor/common/services/semanticTokensStylingService.js';
import './vs/workbench/services/keybinding/common/keybindingEditing.js';
// The keyboard takeover's resolver subclass, which imports and re-registers stock's service.
import './vs/workbench/services/keybinding/tauri/keybindingService.js';
import './vs/workbench/services/keybinding/browser/keyboardLayoutService.js';
import './vs/workbench/services/decorations/browser/decorationsService.js';
import './vs/workbench/services/dialogs/common/dialogService.js';
import './vs/workbench/services/editor/browser/codeEditorService.js';
import './vs/workbench/services/editor/browser/editorResolverService.js';
import './vs/workbench/services/textmodelResolver/common/textModelResolverService.js';
import './vs/workbench/services/textresourceProperties/common/textResourcePropertiesService.js';
import './vs/workbench/services/textfile/common/textEditorService.js';
import './vs/workbench/services/textfile/browser/browserTextFileService.js';
import './vs/workbench/services/untitled/common/untitledTextEditorService.js';
import './vs/workbench/services/language/common/languageService.js';
import './vs/workbench/services/model/common/modelService.js';
import { ISearchService } from './vs/workbench/services/search/common/search.js';
import { TauriSearchService } from './vs/workbench/services/search/tauri/tauriSearchService.js';
import './vs/workbench/services/commands/common/commandService.js';
import './vs/workbench/services/history/browser/historyService.js';
import './vs/workbench/services/workspaces/browser/workspacesService.js';
import './vs/workbench/services/label/common/labelService.js';
import './vs/workbench/services/views/browser/viewDescriptorService.js';
import './vs/workbench/services/notification/common/notificationService.js';
import './vs/workbench/services/workingCopy/common/workingCopyService.js';
import './vs/workbench/services/workingCopy/common/workingCopyFileService.js';
import './vs/workbench/services/workingCopy/common/workingCopyEditorService.js';
import './vs/workbench/services/workingCopy/browser/workingCopyBackupService.js';
import './vs/workbench/services/workingCopy/browser/workingCopyHistoryService.js';
import './vs/workbench/services/filesConfiguration/common/filesConfigurationService.js';
import './vs/workbench/services/files/browser/elevatedFileService.js';
import './vs/workbench/services/lifecycle/browser/lifecycleService.js';
import './vs/workbench/services/clipboard/browser/clipboardService.js';
import './vs/workbench/services/path/browser/pathService.js';
import './vs/workbench/services/extensionManagement/browser/extensionsProfileScannerService.js';
import './vs/workbench/services/extensionManagement/browser/extensionGalleryManifestService.js';
import './vs/workbench/services/extensionManagement/common/extensionGalleryService.js';
import './vs/workbench/services/extensions/common/extensionManifestPropertiesService.js';
import './vs/workbench/services/log/common/defaultLogLevels.js';
import './vs/workbench/contrib/bulkEdit/browser/bulkEditService.js';
import './vs/workbench/contrib/files/browser/files.contribution.js';
import './vs/workbench/contrib/files/browser/fileActions.contribution.js';
import './vs/workbench/contrib/files/browser/copyFileLocation.js';
import './vs/workbench/contrib/scm/browser/scm.service.contribution.js';
import './vs/workbench/contrib/scm/browser/scm.contribution.js';
import './vs/workbench/contrib/search/browser/search.contribution.js';
import { INotebookSearchService } from './vs/workbench/contrib/search/common/notebookSearch.js';
import { INotebookEditorModelResolverService } from './vs/workbench/contrib/notebook/common/notebookEditorModelResolverService.js';
import { NO_NOTEBOOK_SEARCH, NO_NOTEBOOK_MODELS } from './workbench/absentServices.js';

// Themes and tokenization stay upstream: the theme service reads bundled theme JSON and the
// TextMate worker tokenizes the model mounted in the editor widget.
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
import { MacContextMenuService } from './editor/macContextMenuService.js';
import { registerMacWorkspaceFolders, resolveMacWorkspace } from './editor/macWorkspace.js';
import { IQuickDiffService } from './vs/workbench/contrib/scm/common/quickDiff.js';
import { QuickDiffService } from './vs/workbench/contrib/scm/common/quickDiffService.js';

registerSingleton(IQuickDiffService, QuickDiffService, InstantiationType.Delayed);
import { IListService, ListService } from './vs/platform/list/browser/listService.js';
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
import { ITimerService, TimerService } from './vs/workbench/services/timer/browser/timerService.js';
import { IDiagnosticsService, NullDiagnosticsService } from './vs/platform/diagnostics/common/diagnostics.js';
import { ILanguagePackService } from './vs/platform/languagePacks/common/languagePacks.js';
import { WebLanguagePacksService } from './vs/platform/languagePacks/browser/languagePacks.js';
import { IAllowedExtensionsService } from './vs/platform/extensionManagement/common/extensionManagement.js';
import { AllowedExtensionsService } from './vs/platform/extensionManagement/common/allowedExtensionsService.js';
import { ILanguageDetectionService } from './vs/workbench/services/languageDetection/common/languageDetectionWorkerService.js';
import { NullLanguageDetectionService } from './vs/workbench/services/languageDetection/tauri/nullLanguageDetectionService.js';

registerSingleton(IContextViewService, ContextViewService, InstantiationType.Delayed);
registerSingleton(ISearchService, TauriSearchService, InstantiationType.Delayed);
registerSingleton(IListService, ListService, InstantiationType.Delayed);
registerSingleton(IMarkerService, MarkerService, InstantiationType.Delayed);
registerSingleton(IContextKeyService, ContextKeyService, InstantiationType.Delayed);
registerSingleton(ITextResourceConfigurationService, TextResourceConfigurationService, InstantiationType.Delayed);
registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed);
registerSingleton(IWebWorkerService, BundlerWebWorkerService, InstantiationType.Delayed);
registerSingleton(IAccessibilityService, AccessibilityService, InstantiationType.Delayed);
registerSingleton(ITimerService, TimerService, InstantiationType.Delayed);
registerSingleton(IDiagnosticsService, NullDiagnosticsService, InstantiationType.Delayed);
registerSingleton(ILanguagePackService, WebLanguagePacksService, InstantiationType.Delayed);
// Every text editor model takes this by constructor, so it has to be registered even though
// this port does not ship ML language detection.
registerSingleton(ILanguageDetectionService, NullLanguageDetectionService, InstantiationType.Delayed);
// Upstream registers this from `workbench.common.main.ts`; the gallery service takes it by
// constructor, and with no gallery configured it answers from the allow-list setting alone.
registerSingleton(IAllowedExtensionsService, AllowedExtensionsService, InstantiationType.Delayed);


//#endregion


//#region --- tauri-backed services

import { IExtensionService } from './vs/workbench/services/extensions/common/extensions.js';
import { CatalogueExtensionService } from './vs/workbench/services/extensions/tauri/catalogueExtensionService.js';

// Publishes scanned manifests and activates nothing. This gives tokenization access to the
// built-in language contributions without introducing an extension host.
registerSingleton(IExtensionService, CatalogueExtensionService, InstantiationType.Eager);

// `TauriExtensionsScannerService` takes the app resource directory, which is only known at
// runtime, so it is registered from `initServices` rather than here.

//#endregion


//#region --- editor contributions

import './vs/workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import './vs/workbench/contrib/list/browser/list.contribution.js';
import './vs/workbench/browser/actions/listCommands.js';
import './vs/workbench/contrib/sash/browser/sash.contribution.js';
import './vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import './vs/workbench/contrib/search/browser/searchQuickAccess.contribution.js';
import './vs/workbench/contrib/snippets/browser/snippets.service.contribution.js';
import './vs/workbench/contrib/inlineCompletions/browser/renameSymbolTrackerService.js';
import './vs/workbench/contrib/accessibility/browser/accessibility.contribution.js';
import './vs/workbench/contrib/themes/browser/themes.contribution.js';
import './vs/workbench/contrib/markdown/tauri/markdownPreview.contribution.js';
import { EditorMarkdownCodeBlockRenderer } from './vs/editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { IMarkdownRendererService } from './vs/platform/markdown/browser/markdownRenderer.js';

//#endregion


//#region --- bootstrap

import { addDisposableListener, detectFullscreen, domContentLoaded, getWindow } from './vs/base/browser/dom.js';
import { StandardKeyboardEvent } from './vs/base/browser/keyboardEvent.js';
import { setFullscreen } from './vs/base/browser/browser.js';
import { mainWindow } from './vs/base/browser/window.js';
import { Disposable, combinedDisposable, toDisposable } from './vs/base/common/lifecycle.js';
import { onUnexpectedError } from './vs/base/common/errors.js';
import { ICommandService } from './vs/platform/commands/common/commands.js';
import { mark } from './vs/base/common/performance.js';
import { toLocalISOString } from './vs/base/common/date.js';
import { URI, UriComponents } from './vs/base/common/uri.js';
import { FileAccess, Schemas } from './vs/base/common/network.js';
import { IndexedDB } from './vs/base/browser/indexedDB.js';
import { ServiceCollection } from './vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from './vs/platform/instantiation/common/descriptors.js';
import { InstantiationService } from './vs/platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from './vs/platform/instantiation/common/extensions.js';
import type { IInstantiationService } from './vs/platform/instantiation/common/instantiation.js';
import { IFileService } from './vs/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from './vs/platform/files/common/inMemoryFilesystemProvider.js';
import { IndexedDBFileSystemProvider } from './vs/platform/files/browser/indexedDBFileSystemProvider.js';
import { ILogService } from './vs/platform/log/common/log.js';
import { BootstrapServices, registerBootstrapProduct } from './bootstrapServices.js';
import { IBrowserWorkbenchEnvironmentService } from './vs/workbench/services/environment/browser/environmentService.js';
import { TauriWorkbenchEnvironmentService } from './vs/workbench/services/environment/tauri/tauriEnvironmentService.js';
import { IUriIdentityService } from './vs/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from './vs/platform/uriIdentity/common/uriIdentityService.js';
import { BrowserUserDataProfilesService } from './vs/platform/userDataProfile/browser/userDataProfile.js';
import { ITelemetryService } from './vs/platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from './vs/platform/telemetry/common/telemetryUtils.js';
import { IRequestService } from './vs/platform/request/common/request.js';
import { BrowserRequestService } from './vs/workbench/services/request/browser/requestService.js';
import { RemoteConnectionType } from './vs/platform/remote/common/remoteAuthorityResolver.js';
import { RemoteSocketFactoryService } from './vs/platform/remote/common/remoteSocketFactoryService.js';
import { BrowserSocketFactory } from './vs/platform/remote/browser/browserSocketFactory.js';
import { IAnyWorkspaceIdentifier, IWorkspaceContextService } from './vs/platform/workspace/common/workspace.js';
import { getSingleFolderWorkspaceIdentifier } from './vs/platform/workspaces/common/workspaceIdentifier.js';
import { IWorkbenchConfigurationService } from './vs/workbench/services/configuration/common/configuration.js';
import { ConfigurationTarget } from './vs/platform/configuration/common/configuration.js';
import { IStorageService } from './vs/platform/storage/common/storage.js';
import { BrowserStorageService } from './vs/workbench/services/storage/browser/storageService.js';
import { IMainProcessService } from './vs/platform/ipc/common/mainProcessService.js';
import { TauriMainProcessService } from './vs/base/parts/ipc/tauri/ipc.tauri.js';
import { FILE_CHANNEL_NAME, TauriFileSystemProvider } from './vs/workbench/services/files/tauri/tauriFileSystemProvider.js';
import { IQuickInputService } from './vs/platform/quickinput/common/quickInput.js';
import { IFileDialogService } from './vs/platform/dialogs/common/dialogs.js';
import { IProgressService, Progress } from './vs/platform/progress/common/progress.js';
import { IKeyboardEvent, IKeybindingService } from './vs/platform/keybinding/common/keybinding.js';
import { ActiveEditorGroupEmptyContext, OpenFolderWorkspaceSupportContext } from './vs/workbench/common/contextkeys.js';
import { IHistoryService } from './vs/workbench/services/history/common/history.js';
import { IEditorService } from './vs/workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from './vs/workbench/services/editor/common/editorGroupsService.js';
import { EVENT_KEY_CODE_MAP, IMMUTABLE_CODE_TO_KEY_CODE, KeyCode, SCAN_CODE_STR_TO_EVENT_KEY_CODE, ScanCodeUtils } from './vs/base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from './vs/platform/keybinding/common/keybindingsRegistry.js';
import { IStatusbarService } from './vs/workbench/services/statusbar/browser/statusbar.js';
import './vs/workbench/browser/parts/statusbar/statusbarPart.js';
import type { StatusbarService } from './vs/workbench/browser/parts/statusbar/statusbarPart.js';
import { VimContribution } from './vs/workbench/contrib/vim/tauri/vim.contribution.js';
import { guiRuleWhen, keysFor, rowsFor } from './vs/workbench/browser/tauri/keymap.js';
import { NativeQuickInputService } from './editor/nativeQuickInput.js';
import { MacFileDialogService } from './editor/macFileDialogs.js';
import { createMacHostService, setMacWindowFocus } from './editor/macHostService.js';
import { IsMacNativeContext, IsWebContext } from './vs/platform/contextkey/common/contextkeys.js';
import { QuickInputDialogs } from './workbench/dialogHandler.js';
import { registerOpenEditorAPICommands } from './vs/workbench/browser/parts/editor/editorCommands.js';
import { IThemeService } from './vs/platform/theme/common/themeService.js';
import { ColorScheme } from './vs/platform/theme/common/theme.js';
import { ILanguageService } from './vs/editor/common/languages/language.js';
import { ITextMateTokenizationService } from './vs/workbench/services/textMate/browser/textMateTokenizationFeature.js';
import { COLOR_THEME_DARK_INITIAL_COLORS, IWorkbenchThemeService, ThemeSettingDefaults } from './vs/workbench/services/themes/common/workbenchThemeService.js';
import { IWorkbenchLayoutService } from './vs/workbench/services/layout/browser/layoutService.js';
import { IHostService } from './vs/workbench/services/host/browser/host.js';
import { NativeExplorer } from './editor/nativeExplorer.js';
import { NativeSCM } from './editor/nativeScm.js';
import { NativeSearch } from './editor/nativeSearch.js';
import { NativeMainMenu } from './editor/nativeMainMenu.js';
import { TauriGitContribution } from './vs/workbench/contrib/scm/tauri/git.contribution.js';
import { NativeBreadcrumbsService } from './editor/nativeBreadcrumbs.js';
import { IBreadcrumbsService } from './vs/workbench/browser/parts/editor/breadcrumbs.js';
import { ExplorerViewletViewsContribution } from './vs/workbench/contrib/files/browser/explorerViewlet.js';

for (const row of rowsFor('gui').filter(row => row.id === 'tscode.file.edit')) {
	const [primary, ...secondary] = keysFor(row, 'gui');
	KeybindingsRegistry.registerKeybindingRule({
		id: row.id, weight: KeybindingWeight.WorkbenchContrib + 1,
		primary, secondary, when: guiRuleWhen(row)
	});
}

/**
 * What the app boots with: the workspace identifier this window opens, the provider behind it,
 * and a folder that could not be reopened, to be logged once there is a log service to log it
 * to.
 */
interface IBootWorkspace {
	readonly workspace: IAnyWorkspaceIdentifier;
	readonly restoreError?: unknown;
}

interface IMacConfiguration {
	readonly repositoryRoot: string;
	readonly workspaceFile?: string;
	readonly resourceRoot: string;
	readonly visualCompareTabs?: string;
}

const injectedMacConfiguration = (globalThis as typeof globalThis & {
	__TUCODE_MAC_CONFIG__?: IMacConfiguration;
}).__TUCODE_MAC_CONFIG__;

if (!injectedMacConfiguration?.repositoryRoot || !injectedMacConfiguration.resourceRoot) {
	throw new Error('the Tucode Mac bootstrap configuration is missing');
}
const macConfiguration: IMacConfiguration = injectedMacConfiguration;

// CSS fonts and images are fetched by WebKit, not IFileService. Serve only bundled
// app resources from the editor origin; other local resources use Wry's Rust asset handler.
const bundledResourcePrefix = URI.file(macConfiguration.resourceRoot).path.replace(/\/+$/, '') + '/';
FileAccess.setBrowserUriMapper(uri => uri.scheme === Schemas.file && !uri.authority && uri.path.startsWith(bundledResourcePrefix)
	? URI.from({ scheme: location.protocol.slice(0, -1), authority: location.host,
		path: '/app-resource/' + uri.path.slice(bundledResourcePrefix.length), query: uri.query, fragment: uri.fragment })
	: uri.scheme === Schemas.file && !uri.authority
		? uri.with({ scheme: 'asset', authority: 'localhost' })
		: undefined);

import './editor/upstreamEditorServices.js';
import { PlatformEditorLayout } from './editor/platformEditorLayout.js';
import { EditorParts } from './vs/workbench/browser/parts/editor/editorParts.js';
import { MacEditorParts } from './editor/macEditorParts.js';
import { TextFileEditor } from './vs/workbench/contrib/files/browser/editors/textFileEditor.js';
import { TextResourceEditor } from './vs/workbench/browser/parts/editor/textResourceEditor.js';
import { TextDiffEditor } from './vs/workbench/browser/parts/editor/textDiffEditor.js';
import { DiffEditorInput } from './vs/workbench/common/editor/diffEditorInput.js';
import { UntitledTextEditorInput } from './vs/workbench/services/untitled/common/untitledTextEditorInput.js';
import { Registry } from './vs/platform/registry/common/platform.js';
import { NativeEditorTabs } from './editor/nativeEditorTabs.js';
import './vs/workbench/browser/parts/editor/editorCloseContextMenu.contribution.js';
import { EditorExtensions } from './vs/workbench/common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from './vs/workbench/browser/editor.js';
import { FileEditorInput } from './vs/workbench/contrib/files/browser/editors/fileEditorInput.js';
import { TextResourceEditorInput } from './vs/workbench/common/editor/textResourceEditorInput.js';
import { IFilesConfigurationService } from './vs/workbench/services/filesConfiguration/common/filesConfigurationService.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(TextFileEditor, TextFileEditor.ID, 'Text File Editor'),
	[new SyncDescriptor(FileEditorInput)]
);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(TextResourceEditor, TextResourceEditor.ID, 'Text Editor'),
	[new SyncDescriptor(TextResourceEditorInput), new SyncDescriptor(UntitledTextEditorInput)]
);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(TextDiffEditor, TextDiffEditor.ID, 'Text Diff Editor'),
	[new SyncDescriptor(DiffEditorInput)]
);

function publish(type: string, payload?: unknown): void {
	const handler = (window as Window & { webkit?: { messageHandlers?: {
		tucodeProjection?: { postMessage(message: unknown): void };
	} } }).webkit?.messageHandlers?.tucodeProjection;
	if (!handler) {
		throw new Error('the Tucode native projection bridge is unavailable');
	}
	handler.postMessage({ version: 1, requestId: 0, type, payload });
}

/** Mechanical browser-event reconstruction at the AppKit/JavaScript boundary. */
function keyboardEventFromNative(payload: any, type = 'keydown'): (IKeyboardEvent & { readonly browserEvent: KeyboardEvent }) | undefined {
	if (typeof payload?.key !== 'string' || typeof payload?.code !== 'string') { return undefined; }
	const eventKeyCode = SCAN_CODE_STR_TO_EVENT_KEY_CODE[payload.code] ||
		Number(Object.entries(EVENT_KEY_CODE_MAP).find(([, code]) =>
			code === IMMUTABLE_CODE_TO_KEY_CODE[ScanCodeUtils.toEnum(payload.code)])?.[0]);
	const keyCode = EVENT_KEY_CODE_MAP[eventKeyCode];
	if (keyCode === undefined || keyCode === KeyCode.Unknown) { return undefined; }
	const browserEvent = new KeyboardEvent(type, {
		bubbles: true, cancelable: true, key: payload.key, code: payload.code,
		ctrlKey: !!payload.ctrlKey, shiftKey: !!payload.shiftKey,
		altKey: !!payload.altKey, metaKey: !!payload.metaKey,
		keyCode: eventKeyCode
	} as KeyboardEventInit & { keyCode: number });
	return Object.freeze({
		_standardKeyboardEventBrand: true,
		browserEvent,
		ctrlKey: browserEvent.ctrlKey, shiftKey: browserEvent.shiftKey,
		altKey: browserEvent.altKey, metaKey: browserEvent.metaKey,
		altGraphKey: false, keyCode, code: payload.code
	});
}


/**
 * The WK page hosts VS Code services and editor parts. AppKit owns native chrome; its adapters
 * publish derived state and dispatch actions into the same service collection.
 */
class MacEditorOnlyAdapter extends Disposable {
	private readonly groups: EditorParts;
	private readonly statusbar: StatusbarService;
	private readonly editorService: IEditorService;
	private readonly tabs: NativeEditorTabs;
	private readonly quickInput: NativeQuickInputService;
	private readonly keybindingService: IKeybindingService;
	private readonly navigator: NativeExplorer;
	private readonly mainMenu: NativeMainMenu;
	private projectionListener: { dispose(): void } | undefined;
	constructor(private readonly instantiationService: IInstantiationService, private readonly parent: HTMLElement) {
		super();
		this.quickInput = instantiationService.invokeFunction(accessor => accessor.get(IQuickInputService)) as NativeQuickInputService;
		this._register(instantiationService.createInstance(QuickInputDialogs));
		this.keybindingService = instantiationService.invokeFunction(accessor => accessor.get(IKeybindingService));
		this._register(addDisposableListener(parent, 'keydown', event => {
			if (this.keybindingService.dispatchEvent(new StandardKeyboardEvent(event), event.target as HTMLElement)) {
				event.preventDefault(); event.stopPropagation();
			}
		}));
		this._register(addDisposableListener(parent, 'keyup', event => {
			if (this.quickInput.handleKeyUp(new StandardKeyboardEvent(event))) {
				event.preventDefault(); event.stopPropagation();
			}
		}));
		this.groups = this._register(instantiationService.invokeFunction(accessor => accessor.get(IEditorGroupsService)) as EditorParts);
		this.editorService = instantiationService.invokeFunction(accessor => accessor.get(IEditorService));
		this.groups.mainPart.enforcePartOptions({ showTabs: 'none' });
		const editorPart = parent.appendChild(document.createElement('div'));
		editorPart.classList.add('part', 'editor');
		this.groups.mainPart.create(editorPart, { restorePreviousState: false });
		this.statusbar = instantiationService.invokeFunction(accessor => accessor.get(IStatusbarService)) as StatusbarService;
		const statusbarPart = parent.appendChild(document.createElement('footer'));
		statusbarPart.classList.add('part', 'statusbar');
		statusbarPart.style.position = 'relative';
		statusbarPart.setAttribute('role', 'status');
		statusbarPart.tabIndex = 0;
		this.statusbar.mainPart.create(statusbarPart);
		this._register(instantiationService.createInstance(VimContribution));
		instantiationService.invokeFunction(accessor => accessor.get(IHistoryService));
		const emptyGroup = instantiationService.invokeFunction(accessor => ActiveEditorGroupEmptyContext.bindTo(accessor.get(IContextKeyService)));
		const updateEmptyGroup = () => emptyGroup.set(this.groups.activeGroup?.isEmpty ?? true);
		this._register(this.editorService.onDidActiveEditorChange(updateEmptyGroup));
		this._register(this.groups.onDidChangeActiveGroup(updateEmptyGroup));
		updateEmptyGroup();
		void this.groups.whenReady.then(updateEmptyGroup);
		const languages = instantiationService.invokeFunction(accessor => accessor.get(ILanguageService));
		const themes = instantiationService.invokeFunction(accessor => accessor.get(IWorkbenchThemeService));
		// Native file paint uses the same language identification for tabs and all navigator surfaces.
		const outlineUpdates = new NativeOutlineUpdates();
		const publishFiles = (type: string, payload: any): void | Promise<void> => {
			const themeId = themes.getFileIconTheme().settingsId;
			const filePaint = (row: any) => row.kind === 'search-match' ? row : {
				...row, fileIconTheme: themeId,
				languageId: row.resource && !row.isDirectory ? languages.guessLanguageIdByFilepathOrFirstLine(URI.parse(row.resource)) : undefined
			};
			if (type === 'navigatorSnapshot') {
				const { outlineRows, ...chrome } = payload;
				const outline = outlineUpdates.capture(`${payload.activeContainerId}/${payload.focusedSectionId}/${themeId}`, outlineRows);
				outline.rows = outline.rows.map(filePaint);
				// Send text so WebKit does not expand thousands of row dictionaries on
				// AppKit's thread. Swift decodes and prepares child differences off-main.
				return invokeNativeNavigator<void>('mac_apply_navigator', { snapshot: JSON.stringify({ ...chrome, outline }) });
			}
			if (type === 'editorTabsPaint') { payload = { ...payload, tabs: payload.tabs.map(filePaint) }; }
			publish(type, payload);
		};
		this.tabs = this._register(new NativeEditorTabs(this.groups, publishFiles,
			instantiationService.invokeFunction(accessor => accessor.get(IContextMenuService)) as MacContextMenuService));
		registerOpenEditorAPICommands();
		this.navigator = this._register(instantiationService.createInstance(NativeExplorer, publishFiles));
		this._register(themes.onDidFileIconThemeChange(() => { this.tabs.refresh(); this.navigator.changesUpdated(); }));
		this.navigator.attachChanges(this._register(instantiationService.createInstance(NativeSCM, () => this.navigator.changesUpdated())));
		this.navigator.attachSearch(this._register(instantiationService.createInstance(NativeSearch, () => this.navigator.changesUpdated())));
		this._register(instantiationService.createInstance(TauriGitContribution));
		this.mainMenu = this._register(instantiationService.createInstance(NativeMainMenu, publish));
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(parent); this._register({ dispose: () => observer.disconnect() });
	}
	async start(): Promise<void> {
		this.tabs.start();
		this._register(this.quickInput.onShow(() => this.attachQuickInput()));
		this.layout(); await this.navigator.start(); await this.openVisualComparisonEditors();
		publish('ready', { runtime: 'WKWebView', surface: 'editor-only', vscodePlatform: 'mac' });
	}

	dispatch(message: { type?: string; payload?: any }): boolean {
		switch (message.type) {
			case 'windowFocus':
				if (typeof message.payload?.focused !== 'boolean') { return false; }
				setMacWindowFocus(message.payload.focused);
				return true;
			case 'command':
				if (typeof message.payload?.id !== 'string') { return false; }
				void this.instantiationService.invokeFunction(accessor =>
					accessor.get(ICommandService).executeCommand(message.payload.id))
					.catch(error => publish('error', { message: error instanceof Error ? error.message : String(error) }));
				return true;
			case 'mainMenuEvent': return this.mainMenu.dispatch(message.payload);
			case 'key': return this.dispatchKey(message.payload);
			case 'keyUp': {
				const event = keyboardEventFromNative(message.payload, 'keyup');
				return !!event && this.quickInput.handleKeyUp(event);
			}
			case 'quickInputEvent': return this.dispatchQuickInput(message.payload);
			case 'navigatorEvent': return this.navigator.dispatch(message.payload);
			case 'editorEvent': return this.tabs.dispatch(message.payload);
			case 'contextMenuEvent': return (this.instantiationService.invokeFunction(accessor => accessor.get(IContextMenuService)) as MacContextMenuService).dispatch(message.payload);
			default: return false;
		}
	}

	private layout(): void {
		const { width, height } = this.parent.getBoundingClientRect();
		const statusHeight = this.statusbar.mainPart.minimumHeight;
		const editorHeight = Math.max(0, height - statusHeight);
		this.groups.mainPart.layout(Math.max(0, width), editorHeight, 0, 0);
		this.statusbar.mainPart.layout(Math.max(0, width), statusHeight, editorHeight, 0);
		this.statusbar.mainPart.getContainer()!.style.height = `${statusHeight}px`;
	}

	private dispatchKey(payload: any): boolean {
		const event = keyboardEventFromNative(payload);
		return !!event && this.keybindingService.dispatchEvent(event,
			payload?.target === 'navigator' ? document.body : (document.activeElement as HTMLElement ?? this.parent));
	}

	private dispatchQuickInput(payload: any): boolean {
		const projection = this.quickInput.currentProjection;
		if (!projection || !payload?.eventType || !Number.isInteger(payload?.sessionId)
			|| payload.sessionId !== projection.snapshot.sessionId) { return false; }
		const event: any = { sessionId: payload.sessionId, type: payload.eventType };
		if (typeof payload.value === 'string') { event.value = payload.value; }
		if (Array.isArray(payload.selection) && payload.selection.length === 2 && payload.selection.every(Number.isInteger)) { event.selection = payload.selection; }
		if (typeof payload.id === 'string') { event.id = payload.id; }
		if (typeof payload.focused === 'boolean') { event.focused = payload.focused; }
		if (payload.direction === 'previous' || payload.direction === 'next') { event.direction = payload.direction; }
		return projection.dispatch(Object.freeze(event));
	}

	private attachQuickInput(): void {
		this.projectionListener?.dispose();
		const projection = this.quickInput.currentProjection;
		if (!projection) { return; }
		publish('quickInputSnapshot', projection.snapshot);
		this.projectionListener = combinedDisposable(
			projection.onDidSnapshot(snapshot => publish('quickInputSnapshot', snapshot)),
			projection.onDidChangeInput(change => publish('quickInputUpdate', change))
		);
	}

	private async openVisualComparisonEditors(): Promise<void> {
		const scenario = macConfiguration.visualCompareTabs;
		if (!scenario || scenario === 'empty') { return; }
		if (scenario === 'frontend-probe') {
			await (await import('../test/browser/macFrontendProbe.js')).runMacFrontendProbe(this.instantiationService);
			return;
		}
		const files = scenario === 'overflow' || scenario === 'overflow-dirty'
			? ['Sources/TucodeMac/Projection.swift', 'Sources/TucodeMac/EditorAreaView.swift', 'Package.swift', 'README.md',
				'capture-visual-comparison.sh', 'launch.sh', 'package.sh', 'capture-mac-ui.sh', 'sign-test-artifacts.mjs', 'test-foreground.sh']
			: ['README', scenario === 'long' ? 'capture-visual-comparison.sh' : 'Package.swift', 'App/Info.plist'];
		for (const relative of files) {
			await this.editorService.openEditor({ resource: URI.file(`${macConfiguration.repositoryRoot}/mac/${relative}`) });
		}
		if (scenario === 'overflow-dirty' && this.groups.activeGroup.activeEditor) {
			this._register(this.instantiationService.invokeFunction(accessor =>
				accessor.get(IFilesConfigurationService).disableAutoSave(this.groups.activeGroup.activeEditor!)));
		}
		if (scenario === 'long') {
			const input = this.editorService.editors.find(editor => editor.getName() === 'capture-visual-comparison.sh');
			if (input) { await this.editorService.openEditor(input); }
		}
	}

	override dispose(): void {
		this.projectionListener?.dispose();
		super.dispose();
	}
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

class MacWebMain extends Disposable {

	constructor(private readonly parent: HTMLElement) {
		super();

		// WorkbenchThemeService scopes its generated color variables to this class. The Mac page
		// does not create a Workbench DOM shell, so its editor-only root supplies that scope itself.
		this.parent.classList.add('monaco-workbench', 'mac');
		setFullscreen(!!detectFullscreen(mainWindow), mainWindow);
	}

	async open(): Promise<void> {

		// Init services and wait for DOM to be ready in parallel
		const [services] = await Promise.all([this.initServices(), domContentLoaded(getWindow(this.parent))]);

		for (const [id, descriptor] of getSingletonServiceDescriptors()) {
			services.serviceCollection.set(id, descriptor);
		}
		services.serviceCollection.set(IWorkbenchLayoutService,
			new PlatformEditorLayout(this.parent) as unknown as IWorkbenchLayoutService);
		services.serviceCollection.set(INotebookSearchService, NO_NOTEBOOK_SEARCH);
		services.serviceCollection.set(INotebookEditorModelResolverService, NO_NOTEBOOK_MODELS);
		services.serviceCollection.set(IEditorGroupsService, new SyncDescriptor(MacEditorParts));
		services.serviceCollection.set(IFileDialogService, new SyncDescriptor(MacFileDialogService));
		services.serviceCollection.set(IContextMenuService, new SyncDescriptor(MacContextMenuService, [publish]));
		services.serviceCollection.set(IBreadcrumbsService, new SyncDescriptor(NativeBreadcrumbsService));
		services.serviceCollection.set(IProgressService, {
			_serviceBrand: undefined,
			withProgress: (_options, task) => task(Progress.None)
		});
		const instantiationService = this._register(new InstantiationService(services.serviceCollection, true));
		services.serviceCollection.set(IHostService, createMacHostService(
			instantiationService.invokeFunction(accessor => accessor.get(IWorkbenchConfigurationService))));
		// This editor-only shell has no WorkbenchContextKeysHandler. Advertise the native
		// folder-opening capability to both the upstream menu and Command Palette.
		instantiationService.invokeFunction(accessor => {
			const context = accessor.get(IContextKeyService);
			OpenFolderWorkspaceSupportContext.bindTo(context).set(true);
			IsMacNativeContext.bindTo(context);
			IsWebContext.bindTo(context);
		});
		this._register(instantiationService.createInstance(ExplorerViewletViewsContribution));
		await instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService).getCompleteWorkspace());
		instantiationService.invokeFunction(accessor => {
			const configurationService = accessor.get(IWorkbenchConfigurationService);
			if ('acquireInstantiationService' in configurationService) {
				(configurationService as unknown as { acquireInstantiationService(service: IInstantiationService): void })
					.acquireInstantiationService(instantiationService);
			}
		});
		// Install every extension-point handler before the asynchronous catalogue can publish its
		// bundled language, grammar and theme contributions. There is no Workbench lifecycle on this
		// editor-only page to instantiate TextMate for us, so do that explicitly and do not resolve a
		// file model until the catalogue is complete.
		const editorFeatures = instantiationService.invokeFunction(accessor => {
			accessor.get(IMarkdownRendererService).setDefaultCodeBlockRenderer(instantiationService.createInstance(EditorMarkdownCodeBlockRenderer));
			const themeService = accessor.get(IThemeService) as IThemeService & { initialize(): Promise<void> };
			accessor.get(ILanguageService);
			accessor.get(ITextMateTokenizationService);
			const extensionsReady = accessor.get(IExtensionService).whenInstalledExtensionsRegistered();
			return { themeService, extensionsReady };
		});
		await editorFeatures.extensionsReady;
		// The editor-only page has no Workbench contribution lifecycle. Perform the same
		// defaults refresh as ConfigurationDefaultOverridesContribution after extensions register.
		await instantiationService.invokeFunction(accessor =>
			accessor.get(IWorkbenchConfigurationService).reloadConfiguration(ConfigurationTarget.DEFAULT));
		await editorFeatures.themeService.initialize();

		this.parent.replaceChildren();
		const adapter = this._register(new MacEditorOnlyAdapter(instantiationService, this.parent));
		Object.defineProperty(globalThis, '__tucodeNativeInput', {
			configurable: true,
			value: (message: { type?: string; payload?: unknown }) => {
				try {
					return adapter.dispatch(message);
				} catch (error) {
					publish('error', { message: error instanceof Error
						? `${error.message}\n${error.stack ?? ''}` : String(error) });
					return false;
				}
			}
		});
		await adapter.start();
	}

	private async initServices(): Promise<{ serviceCollection: ServiceCollection; logService: ILogService }> {
		const serviceCollection = new ServiceCollection();

		// Backend. It comes first because every root the rest of boot reads from has to be
		// registered before the read: the app resource directory the extension scanner takes
		// its grammars and themes from, and the folder the window restores.
		const mainProcessService = new TauriMainProcessService();
		serviceCollection.set(IMainProcessService, mainProcessService);
		serviceCollection.set(IQuickInputService, new SyncDescriptor(NativeQuickInputService));

		// Both directories boot reads from before the editor service graph exists. The backend creates the
		// user data one and registers it, because a root is canonicalized as it is stored and
		// canonicalization needs the directory to be there.
		const userDataHome = await userDataDir(mainProcessService);
		const appResourceLocation = await registerWorkspaceRoot(mainProcessService, URI.file(macConfiguration.resourceRoot));
		// Workspace
		const { workspace, restoreError } = await this.resolveWorkspace(mainProcessService);

		// Product
		const productService = registerBootstrapProduct(serviceCollection, appResourceLocation);

		// Environment
		const logsPath = URI.file(toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '')).with({ scheme: 'vscode-log' });
		const environmentService = new TauriWorkbenchEnvironmentService(userDataHome, workspace.id, logsPath, {
			// The browser default is a light theme. This is a native dark window, so keep the initial
			// palette and the configured default on the same side until user settings say otherwise.
			initialColorTheme: { themeType: ColorScheme.DARK, colors: COLOR_THEME_DARK_INITIAL_COLORS },
			configurationDefaults: {
				'workbench.colorTheme': ThemeSettingDefaults.COLOR_THEME_DARK,
				'workbench.iconTheme': 'mac-native',
				'workbench.editor.enablePreview': false,
				'editor.minimap.renderCharacters': false
			}
		}, productService);
		serviceCollection.set(IBrowserWorkbenchEnvironmentService, environmentService);

		const bootstrap = this._register(new BootstrapServices(serviceCollection, environmentService, productService, true));
		const { fileService, loggerService, logService } = bootstrap;

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
		await registerMacWorkspaceFolders(workspace, fileService, uriIdentityService, logService,
			root => registerWorkspaceRoot(mainProcessService, root));

		// User Data Profiles
		const userDataProfilesService = new BrowserUserDataProfilesService(environmentService, fileService, uriIdentityService, logService);
		const remoteSocketFactoryService = new RemoteSocketFactoryService();
		remoteSocketFactoryService.register(RemoteConnectionType.WebSocket, new BrowserSocketFactory(undefined));
		const { userDataProfileService, remoteAgentService, remoteAuthorityResolverService, configurationService } = await bootstrap.initializeWorkspace(
			workspace, diskFileSystemProvider, userDataProfilesService, uriIdentityService, remoteSocketFactoryService);

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

		bootstrap.registerWorkspaceTrust(configurationService, storageService, uriIdentityService, remoteAuthorityResolverService);

		return { serviceCollection, logService };
	}

	/**
	 * Turns what the workspace provider restored into this window's workspace identifier,
	 * registering the folder as a Rust root on the way — an unregistered root denies every
	 * read beneath it. A folder that can no longer be opened is forgotten and the window
	 * boots empty.
	 */
	private async resolveWorkspace(mainProcessService: IMainProcessService): Promise<IBootWorkspace> {
		try {
			return { workspace: await resolveMacWorkspace(macConfiguration.repositoryRoot, macConfiguration.workspaceFile,
				root => registerWorkspaceRoot(mainProcessService, root)) };
		} catch (restoreError) {
			if (macConfiguration.workspaceFile) { throw restoreError; }
			return { workspace: getSingleFolderWorkspaceIdentifier(URI.file(macConfiguration.repositoryRoot)), restoreError };
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

// Mount the editor-only surface. A boot that throws reports through the same native bridge.
mark('code/didLoadMacEditorMain');

new MacWebMain(mainWindow.document.body).open().catch(error => {
	onUnexpectedError(error);
	publish('error', { message: error instanceof Error
		? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error) });
});

//#endregion
