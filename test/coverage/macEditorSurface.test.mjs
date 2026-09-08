import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const web = readFileSync(resolve(root, 'src/macWebMain.ts'), 'utf8');
const tabs = readFileSync(resolve(root, 'src/editor/nativeEditorTabs.ts'), 'utf8');
const macParts = readFileSync(resolve(root, 'src/editor/macEditorParts.ts'), 'utf8');
const styles = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const appKit = readFileSync(resolve(root, 'mac/Sources/TucodeMac/main.swift'), 'utf8');
const nativeQuickInput = readFileSync(resolve(root, 'mac/Sources/TucodeMac/NativeQuickInput.swift'), 'utf8');
const keybindingService = readFileSync(resolve(root,
	'src/vs/workbench/services/keybinding/tauri/keybindingService.ts'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/tui/views/explorerPane.ts'), 'utf8');

test('Mac has one development launcher with an optional folder argument', () => {
	const launcher = resolve(root, 'mac/launch.sh');
	const script = readFileSync(launcher, 'utf8');
	assert.equal(existsSync(resolve(root, 'mac/run.sh')), false);
	assert.ok(script.includes('cd -- "${1:-$REPOSITORY_ROOT}"'), 'resolve paths against the calling directory before packaging');
	assert.ok(script.includes('--args --repo-root "$TARGET_ROOT"'), 'pass the chosen folder to the native app');
	const extra = spawnSync('/bin/sh', [launcher, 'one', 'two'], { encoding: 'utf8' });
	assert.equal(extra.status, 2);
	assert.match(extra.stderr, /Usage:/);
	const invalid = spawnSync('/bin/sh', [launcher, resolve(root, 'mac/launch.sh')], { encoding: 'utf8' });
	assert.notEqual(invalid.status, 0, 'a file is not a workspace folder');
	assert.equal(invalid.stdout, '', 'invalid input must fail before any build or launch');
});

test('native persistent search invokes the normal upstream Quick Open action', () => {
	const actions = readFileSync(resolve(root, 'src/vs/workbench/browser/actions/quickAccessActions.ts'), 'utf8');
	assert.match(actions, /'workbench.action.quickOpen'/);
	assert.match(appKit, /sendNativeInput\(type: "command", payload: \["id": "workbench.action.quickOpen"\]\)/);
	assert.doesNotMatch(appKit, /buildCommandCenter|tucode\.commandCenter|quickInputPanel\.isHidden/);
	assert.match(nativeQuickInput, /class NativeQuickInputField: NSSearchField/);
	assert.match(web, /accessor.get\(ICommandService\).executeCommand\(message.payload.id\)/);
	assert.match(web, /import '\.\/vs\/workbench\/contrib\/search\/browser\/searchQuickAccess.contribution.js'/);
});

test('Mac editor surface uses upstream file, resource and diff frontend panes', () => {
	for (const pane of ['TextFileEditor', 'TextResourceEditor', 'TextDiffEditor']) {
		assert.match(web, new RegExp(`EditorPaneDescriptor.create\\(${pane}, ${pane}.ID`));
	}
	assert.equal(existsSync(resolve(root, 'src/editor/macCodeEditorPane.ts')), false);
});

test('Quick Open uses a separate native popover sized to its field', () => {
	assert.match(nativeQuickInput, /private let popover = NSPopover\(\)/);
	assert.match(nativeQuickInput, /NSSize\(width: bounds.width,/);
	assert.match(nativeQuickInput, /send\("activate", id: rows\[index\].id\)/);
	assert.match(nativeQuickInput, /send\("navigate", direction: "next"\)/);
	assert.doesNotMatch(nativeQuickInput, /NSTextSuggestionsDelegate|NSVisualEffectView|drawSelection|cornerRadius|borderColor|\.sorted\(|\.filter\(/);
	assert.doesNotMatch(appKit, /quickInputTable|quickInputPanel|quickInputBackground|quickInputResultStatus|handleKeyEvent/);
});

test('persistent Quick Open uses AppKit toolbar placement and sizing', () => {
	assert.match(appKit, /NSSearchToolbarItem\(itemIdentifier: quickInputToolbarIdentifier\)/);
	assert.match(appKit, /quickInputToolbarItem\.searchField = quickInputField/);
	assert.match(appKit, /preferredSearchWidth\.priority = \.defaultHigh/,
		'preferred width must yield to AppKit toolbar sizing');
	assert.doesNotMatch(appKit, /content\.addSubview\(quickInputField\)|quickInputField\.(topAnchor|centerXAnchor|leadingAnchor|trailingAnchor)/);
	assert.doesNotMatch(nativeQuickInput, /(?<![\w.])(?:self\.)?heightAnchor\.constraint/,
		"AppKit sizes the search field; the results popover may have its own height constraint");
});

test('Mac WK editor carries no local selection or renderer workaround', () => {
	assert.doesNotMatch(web, /disableMonospaceOptimizations/);
	assert.doesNotMatch(styles, /user-select/);
	assert.doesNotMatch(web, /extraEditorClassName/);
});

test('Mac imports upstream workbench font and file-icon styles', () => {
	assert.match(web, /import '\.\/vs\/workbench\/browser\/media\/style\.css'/);
	assert.doesNotMatch(styles, /font-family|predefined-file-icon/,
		'upstream font and glyph rules should not be duplicated in our shell');
});

test('native file icons share VS Code language metadata and bundled Seti native paint', () => {
	assert.match(appKit, /self\.changesFilter\.currentEditor\(\) \?\? self\.quickInputField\.currentEditor\(\)/);
	assert.match(web, /new NativeEditorTabs\(this\.groups, publishFiles,/);
	assert.match(web, /createInstance\(NativeExplorer, publishFiles\)/);
	assert.match(web, /languageId: row\.resource[\s\S]*languages\.guessLanguageIdByFilepathOrFirstLine/);
	assert.match(web, /const themeId = themes\.getFileIconTheme\(\)\.settingsId/);
	assert.match(web, /fileIconTheme: themeId/);
	assert.match(web, /themes\.onDidFileIconThemeChange\(\(\) => \{ this\.tabs\.refresh\(\); this\.navigator\.changesUpdated\(\); \}\)/);
	const icons = readFileSync(resolve(root, 'mac/Sources/TucodeMac/NativeSetiIcons.swift'), 'utf8');
	assert.match(icons, /theme-seti\/icons/);
	assert.match(icons, /CTFontDrawGlyphs/);
	assert.doesNotMatch(icons, /CTFontCreatePathForGlyph|context\.scaleBy/);
	assert.doesNotMatch(icons, /WKWebView|JavaScriptCore/);
});

test('Mac Native file theme is packaged only for Mac and uses the stock theme contribution', () => {
	const manifest = JSON.parse(readFileSync(resolve(root, 'mac/Resources/extensions/theme-mac-native/package.json'), 'utf8'));
	assert.equal(manifest.contributes.iconThemes[0].id, 'mac-native');
	assert.equal(manifest.contributes.productIconThemes, undefined);
	assert.deepEqual(JSON.parse(readFileSync(resolve(root, 'mac/Resources/extensions/theme-mac-native/icon-theme.json'), 'utf8')), { iconDefinitions: {} });
	assert.match(web, /'workbench\.iconTheme': 'mac-native'/);
	assert.match(readFileSync(resolve(root, 'mac/package.sh'), 'utf8'), /SCRIPT_DIR\/Resources\/extensions/);
	assert.equal(existsSync(resolve(root, 'resources/extensions/theme-mac-native')), false);
	assert.match(readFileSync(resolve(root, 'src/vs/workbench/services/themes/common/workbenchThemeService.ts'), 'utf8'), /FILE_ICON_THEME = 'vs-seti'/);
});

test('Mac serves bundled theme fonts through the existing same-origin asset handler', () => {
	assert.match(web, /FileAccess\.setBrowserUriMapper/);
	assert.match(web, /uri\.path\.startsWith\(bundledResourcePrefix\)/);
	assert.match(web, /authority: location\.host/);
	assert.match(appKit, /relative\.hasPrefix\("app-resource\/"\)/);
	assert.match(appKit, /case "woff": mimeType = "font\/woff"/);
	assert.match(appKit, /file\.path\(percentEncoded: false\)\.hasPrefix\(rootPath\)/);
});

test('Mac refreshes default overrides after extensions register and before editor creation', () => {
	const extensionsReady = web.indexOf('await editorFeatures.extensionsReady');
	const defaultsRefresh = web.indexOf('reloadConfiguration(ConfigurationTarget.DEFAULT)');
	const adapter = web.indexOf('new MacEditorOnlyAdapter');
	assert.ok(defaultsRefresh > extensionsReady && defaultsRefresh < adapter,
		'cached defaults from older builds must not survive editor-only startup');
});

test('Mac reuses Explorer data for native file breadcrumb menus without replacing symbol pickers', () => {
	const menu = readFileSync(resolve(root, 'mac/Sources/TucodeMac/ContextMenu.swift'), 'utf8');
	assert.match(menu, /RunLoop\.main\.perform\(inModes: \[\.default\]\)/,
		'a replacement popup must wait for the current menu tracking loop to finish');
	assert.match(menu, /CFRunLoopWakeUp\(CFRunLoopGetMain\(\)\)/,
		'an arriving menu must display without waiting for another mouse event');
	assert.doesNotMatch(menu, /DispatchQueue\.main\.async/,
		'menu tracking must not hold the queue that delivers uncached folder replies');
	const native = readFileSync(resolve(root, 'src/editor/nativeBreadcrumbs.ts'), 'utf8');
	const control = readFileSync(resolve(root, 'src/vs/workbench/browser/parts/editor/breadcrumbsControl.ts'), 'utf8');
	assert.match(web, /set\(IBreadcrumbsService, new SyncDescriptor\(NativeBreadcrumbsService\)\)/);
	assert.match(control, /element instanceof FileElement && this\.breadcrumbsService\.pickFile/);
	assert.match(control, /createInstance\(BreadcrumbsOutlinePicker/);
	assert.match(native, /fetchChildren\(this\.explorer\.sortOrderConfiguration\.sortOrder\)/);
	assert.doesNotMatch(native, /registerView|readDirectory|new ExplorerItem|\.select\(/);
});

test('Mac uses upstream input resolution and editor-pane lifetime directly', () => {
	assert.match(web, /new SyncDescriptor\(FileEditorInput\)/);
	assert.doesNotMatch(web, /MacTextProjection|MacResolvedTextChild|EditorAreaController/);
});

test('Mac selects editor composition without constructing the empty-group welcome UI', () => {
	assert.match(web, /set\(IEditorGroupsService, new SyncDescriptor\(MacEditorParts\)\)/);
	assert.match(macParts, /getGroupViewOptions\(\)[\s\S]*showWatermark: false/);
	assert.doesNotMatch(web, /'workbench\.tips\.enabled'/,
		'disabling shortcuts leaves the watermark mounted');
});

test('Mac editor waits for bundled languages and starts native TextMate tokenization', () => {
	const language = web.indexOf('accessor.get(ILanguageService)');
	const textMate = web.indexOf('accessor.get(ITextMateTokenizationService)');
	const catalogue = web.indexOf('whenInstalledExtensionsRegistered()');
	const adapter = web.indexOf('new MacEditorOnlyAdapter');
	assert.ok(language >= 0, 'language extension-point handler is not instantiated');
	assert.ok(textMate > language, 'TextMate tokenization is not instantiated after languages');
	assert.ok(catalogue > textMate, 'extension catalogue readiness is not captured after its handlers');
	assert.ok(adapter > catalogue, 'the editor adapter is created before extension registration is sequenced');
	assert.match(web, /await editorFeatures\.extensionsReady/);
});

test('Mac editor applies one readable dark Workbench theme to its background and tokens', () => {
	assert.match(web, /classList\.add\('monaco-workbench', 'mac'\)/,
		'generated Workbench theme variables have no matching DOM scope');
	assert.match(web, /initialColorTheme:\s*\{\s*themeType:\s*ColorScheme\.DARK/);
	assert.match(web, /'workbench\.colorTheme':\s*ThemeSettingDefaults\.COLOR_THEME_DARK/);
});

test('Mac defaults to minimap blocks through overridable configuration', () => {
	assert.match(web, /configurationDefaults:\s*\{[^}]*'editor\.minimap\.renderCharacters':\s*false/);
});

test('Mac WK editor retains the complete stock VS Code keybinding resolver', () => {
	assert.match(keybindingService, /if \(!this\.terminalKeyboard \|\| !this\.configurationService\.getValue<boolean>\(takeoverSettingKey\)\)/,
		'the terminal-only takeover filter is still applied to the WK editor');
	assert.match(web, /addDisposableListener\(parent, 'keydown'/);
	assert.match(web, /code: payload\.code/,
		'native-area shortcuts lose their physical key before reaching the VS Code resolver');
	const keyRouting = appKit.slice(appKit.indexOf('private func handleVSCodeKeyEquivalent('), appKit.indexOf('private func forwardKeyRelease('));
	assert.match(keyRouting, /if editorHasFocus, let responder = window\.firstResponder \{[^}]*responder\.keyDown\(with: event\)\s+return true\s*\}/,
		'editor shortcuts must deliver the original event to WebKit and return before native bridge dispatch');
	assert.equal(keyRouting.match(/\.keyDown\(with: event\)/g)?.length, 1,
		'editor shortcuts must have a single direct delivery');
	assert.match(keyRouting, /if \(editorHasFocus \|\| nativeFieldHasFocus\) && modifiers\.intersection\(\[\.command, \.control\]\)\.isEmpty && !code\.hasPrefix\("F"\) \{ return false \}/,
		'Option-only input must remain available to native text composition');
	const keyRelease = appKit.slice(appKit.indexOf('private func forwardKeyRelease('), appKit.indexOf('private func handleNativeFieldEdit('));
	assert.match(keyRelease, /guard webEditorReady, !editorHasFocus,/,
		'WebKit key releases must not also be sent through the native bridge');
	assert.doesNotMatch(keyRouting, /DispatchQueue|RunLoop|sendEvent\(/,
		'key routing must not schedule or replay keyboard events');
	assert.match(appKit, /focusedView\?\.isDescendant\(of: editorAreaView\.webView\) == true/,
		'the native shortcut bridge cannot identify the browser editor focus boundary');
});

test('native tabs serialize upstream group state and invoke its controller without HTML', () => {
	assert.match(tabs, /group\.onDidModelChange/);
	assert.match(tabs, /editor\.getName\(\)/);
	assert.match(tabs, /group\.closeEditor\(input\) : group\.openEditor\(input\)/);
	assert.doesNotMatch(tabs, /MutationObserver|querySelector|MouseEvent|HTMLElement|dispatchEvent/);
	assert.doesNotMatch(macParts, /externalTitlePaint/);
});

test('selected AppKit Explorer rows retain an adaptive filename foreground', () => {
	const outline = readFileSync(resolve(root, 'mac/Sources/TucodeMac/NativeOutlineText.swift'), 'utf8');
	assert.match(outline, /class NavigatorOutlineCell: NSTableCellView/);
	assert.match(outline, /override var backgroundStyle:[\s\S]*didSet \{ keepProjectedTextVisible\(\) \}/);
	assert.match(outline, /foregroundColor: NSColor\.labelColor/);
	assert.match(outline, /textField\?\.attributedStringValue = NativeOutlineText\.attributed/);
	assert.match(appKit, /as\? NavigatorOutlineCell/);
});

test('native Explorer owns selection without an offscreen browser tree', () => {
	const native = readFileSync(resolve(root, 'src/editor/nativeExplorer.ts'), 'utf8');
	assert.doesNotMatch(web, /MacNavigatorBridge|browserDomRenderRecords|createInstance\(ExplorerView,/);
	assert.doesNotMatch(native, /document\.|querySelector|MouseEvent|HTMLElement|dispatchEvent|fileService\.resolve/);
	assert.match(native, /this\.explorer\.registerView\(this\)/);
	assert.match(native, /instantiationService\.createInstance\(FilesFilter\)/);
	assert.match(native, /instantiationService\.createInstance\(FileSorter\)/);
	assert.match(native, /new CompressibleObjectTreeModel/);
	assert.match(native, /fetchChildren\(this\.explorer\.sortOrderConfiguration\.sortOrder\)/);
	assert.match(appKit, /class NativeOutlineView: NSOutlineView/);
	assert.match(appKit, /func outlineViewSelectionDidChange/);
	assert.match(appKit, /sendNavigatorEvent\(type: "outline-toggle"/);
	assert.doesNotMatch(appKit, /outline-pointer|outline-key|outlineDOMFocused/);
	assert.doesNotMatch(appKit, /navigatorOutline\.doubleAction|func activateClickedOutlineFile/);
	assert.doesNotMatch(appKit, /clickCount/,
		'rapid clicks must reach the same controller action instead of being discarded in Swift');
});

test('native compact-folder ancestry comes from the upstream compact tree', () => {
	const native = readFileSync(resolve(root, 'src/editor/nativeExplorer.ts'), 'utf8');
	assert.match(native, /const parent = this\.tree\.getParentNodeLocation\(item\)/);
	assert.match(native, /parentId: parent\?\.getId\(\)/);
	assert.match(native, /getCompressedTreeNode\(item\)/);
	assert.match(native, /this\.compression\.isIncompressible\(item\)/);
});

test('terminal Explorer retains its existing browser widget path', () => {
	assert.match(explorer, /WorkbenchCompressibleAsyncDataTree/);
	assert.match(explorer, /extends TreePane</);
	const treePane = readFileSync(resolve(root, 'src/tui/workbench/treePane.ts'), 'utf8');
	assert.match(treePane, /this\.tree\.onDidSpliceRenderedNodes/);
	assert.doesNotMatch(explorer, /ExplorerProjectionController|TreeProjectionGateway/);
});

test('Mac native Search registers the existing model and filesystem search bridge', () => {
	assert.match(web, /import '\.\/vs\/workbench\/contrib\/search\/browser\/search\.contribution\.js'/);
	assert.match(web, /registerSingleton\(ISearchService, TauriSearchService,/);
	assert.doesNotMatch(web, /services\/search\/browser\/searchService\.js/);
	assert.match(web, /set\(INotebookSearchService, NO_NOTEBOOK_SEARCH\)/);
	assert.match(web, /set\(INotebookEditorModelResolverService, NO_NOTEBOOK_MODELS\)/);
});
