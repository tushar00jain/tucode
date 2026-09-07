// The vim engine, driven over a real `TextModel`, with every result read back out of the model.
//
//   node --import ./bin/bundler-imports.mjs test/e2e/lib/vimDriver.mjs
//
// `vim.test.mjs` beside it spawns this and asserts it exits 0; run it directly to read the checks.
//
// **It cannot be a `test/unit` test**, for the reason §13.4 gives: the closure reaches
// `languageConfigurationRegistry.ts`, whose parameter decorator type stripping cannot read. So it
// runs against `out/`, which is what `test/e2e` is, and it is spawned rather than imported because
// it needs `bin/bundler-imports.mjs` in the process that loads it.
//
// It asserts on the *text*, not on a call that did not throw: an edit that reports success proves
// nothing until the model is read back.
import { pathToFileURL } from 'node:url';
const OUT = `${pathToFileURL(process.cwd()).href}/out/src`;
await import(`${OUT}/vs/base/node/browserGlobals.js`);
await import(`${OUT}/vs/platform/product/node/productJson.js`);
//
// Upstream counterpart: none — as above; the engine it drives is vendored, not tscode's.

const { TextModel } = await import(`${OUT}/vs/editor/common/model/textModel.js`);
const { LanguageService } = await import(`${OUT}/vs/editor/common/services/languageService.js`);
const { LanguageConfigurationService, ILanguageConfigurationService } = await import(`${OUT}/vs/editor/common/languages/languageConfigurationRegistry.js`);
const { UndoRedoService } = await import(`${OUT}/vs/platform/undoRedo/common/undoRedoService.js`);
const { IUndoRedoService } = await import(`${OUT}/vs/platform/undoRedo/common/undoRedo.js`);
const { ILanguageService } = await import(`${OUT}/vs/editor/common/languages/language.js`);
const { IConfigurationService } = await import(`${OUT}/vs/platform/configuration/common/configuration.js`);
const { IDialogService } = await import(`${OUT}/vs/platform/dialogs/common/dialogs.js`);
const { INotificationService } = await import(`${OUT}/vs/platform/notification/common/notification.js`);
const { IInstantiationService } = await import(`${OUT}/vs/platform/instantiation/common/instantiation.js`);
const { InstantiationService } = await import(`${OUT}/vs/platform/instantiation/common/instantiationService.js`);
const { ServiceCollection } = await import(`${OUT}/vs/platform/instantiation/common/serviceCollection.js`);
const { ITreeSitterLibraryService } = await import(`${OUT}/vs/editor/common/services/treeSitter/treeSitterLibraryService.js`);
const { IThemeService } = await import(`${OUT}/vs/platform/theme/common/themeService.js`);
const { Event } = await import(`${OUT}/vs/base/common/event.js`);
const { TextView } = await import(`${OUT}/editor/textView.js`);
const { VimMode } = await import(`${OUT}/editor/vimMode.js`);
const { TextEditorController } = await import(`${OUT}/editor/textEditorController.js`);
const { CellTextLayoutBackendFactory } = await import(`${OUT}/tui/editor/cellTextLayout.js`);

let failures = 0;
const check = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { failures++; }
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}\n       got  ${JSON.stringify(got)}${ok ? '' : `\n       want ${JSON.stringify(want)}`}`);
};

const configurationService = {
	_serviceBrand: undefined, onDidChangeConfiguration: Event.None,
	getValue: () => undefined, updateValue: async () => { }, inspect: () => ({}),
	getConfigurationData: () => null, reloadConfiguration: async () => { },
	keys: () => ({ default: [], user: [], workspace: [], workspaceFolder: [], memory: [] }),
};
const languageService = new LanguageService();
const languageConfigurationService = new LanguageConfigurationService(configurationService, languageService);
const themeService = {
	_serviceBrand: undefined,
	onDidColorThemeChange: Event.None,
	getColorTheme: () => ({ getColor: () => undefined, type: 'dark', semanticHighlighting: false, tokenColorMap: [] }),
	onDidFileIconThemeChange: Event.None,
	onDidProductIconThemeChange: Event.None,
};
const collection = new ServiceCollection();
collection.set(IConfigurationService, configurationService);
collection.set(ILanguageService, languageService);
collection.set(ILanguageConfigurationService, languageConfigurationService);
collection.set(IThemeService, themeService);
collection.set(IDialogService, { _serviceBrand: undefined });
collection.set(INotificationService, { _serviceBrand: undefined });
collection.set(ITreeSitterLibraryService, { _serviceBrand: undefined, supportsLanguage: () => false, getParserClass: () => undefined, getLanguage: () => undefined, getInjectionQueries: () => undefined, getHighlightingQueries: () => undefined });
const instantiationService = new InstantiationService(collection, true);
collection.set(IInstantiationService, instantiationService);
collection.set(IUndoRedoService, instantiationService.createInstance(UndoRedoService));

const TEXT = ['alpha beta gamma', 'second line here', '    indented line', 'last'].join('\n');
const model = instantiationService.createInstance(TextModel, TEXT, 'plaintext', TextModel.DEFAULT_CREATION_OPTIONS, null);
const textLayouts = new CellTextLayoutBackendFactory();
const view = instantiationService.createInstance(TextView, model, 80, false, textLayouts);
await view.open();
check('view line count', view.lineCount, 4);
check('rowContent(0)', view.rowContent(0), 'alpha beta gamma');

let saved = 0, quit = 0;
const vim = new VimMode(view, () => { saved++; }, () => { quit++; });

const key = (spec) => {
	// A one-character string is a char; anything else is a name from `input.ts`.
	const k = spec.length === 1 ? { name: 'char', char: spec, sequence: spec } : { name: spec, sequence: '' };
	return vim.handleKey(k);
};
const keys = (str) => { for (const ch of str) { key(ch); } };
const pos = () => view.viewModel.getPosition().toString();

// ---------------------------------------------------------------- motions
check('starts at 1,1', pos(), '(1,1)');
keys('lll');
check('lll', pos(), '(1,4)');
keys('w');
check('w', pos(), '(1,7)');
keys('j');
check('j', pos(), '(2,7)');
keys('0');
check('0', pos(), '(2,1)');
keys('$');
check('$', pos(), '(2,16)');
keys('gg');
check('gg', pos(), '(1,1)');
keys('G');
check('G', pos(), '(4,1)');

// ---------------------------------------------------------------- insert
keys('gg');
key('i');
check('mode after i', vim.mode, 'insert');
keys('XY');
check('typed in insert', model.getLineContent(1), 'XYalpha beta gamma');
key('escape');
check('mode after Esc', vim.mode, 'normal');

// ---------------------------------------------------------------- delete + undo
keys('dd');
check('dd removed the line', model.getLineContent(1), 'second line here');
check('line count after dd', model.getLineCount(), 3);
keys('u');
check('u restored it', model.getLineContent(1), 'XYalpha beta gamma');
keys('u');
check('u again takes back the insert as ONE element', model.getLineContent(1), 'alpha beta gamma');
check('and no further', model.getValue(), TEXT);

// ---------------------------------------------------------------- yank + put
keys('ggyyjp');
check('yy then p', model.getLineContent(3), 'alpha beta gamma');
check('value after p', model.getValue().split('\n').length, 5);
keys('u');
check('undo the put', model.getValue(), TEXT);

// ---------------------------------------------------------------- change word
keys('ggcw');
check('cw enters insert', vim.mode, 'insert');
keys('OMEGA');
key('escape');
check('cw replaced the word', model.getLineContent(1), 'OMEGA beta gamma');

// ---------------------------------------------------------------- visual
keys('gg0v');
check('v enters visual', vim.mode, 'visual');
keys('lll');
check('visual selection text', model.getValueInRange(view.viewModel.getSelection()), 'OMEG');
keys('d');
check('visual d', model.getLineContent(1), 'A beta gamma');
key('escape');

// ---------------------------------------------------------------- search
keys('gg/');
// The prompt's prefix is the engine's own element tree read back as text, so it carries the
// `desc` the engine puts beside `/` as well as the `/` itself.
check('/ opened a prompt', vim.openPrompt?.prefix ?? '(none)', '/(JavaScript regexp: set pcre)');
for (const ch of 'gamma') { key(ch); }
key('enter');
check('search landed on the match', pos(), '(1,8)');
// The engine creates highlights asynchronously without a change event. Poll the
// result with a deadline instead of assuming it finished after a fixed sleep.
const highlightDeadline = Date.now() + 1000;
while (!vim.highlights('A beta gamma').length && Date.now() < highlightDeadline) {
	await new Promise(done => setTimeout(done, 10));
}
check('overlay highlights the match', vim.highlights('A beta gamma').map(r => [r.start, r.endExclusive]), [[7, 12]]);

// ---------------------------------------------------------------- :w
keys(':');
check(': opened a prompt', vim.openPrompt?.prefix ?? '(none)', ':');
for (const ch of 'w') { key(ch); }
key('enter');
check(':w called save exactly once', saved, 1);

keys(':');
for (const ch of 'q') { key(ch); }
key('enter');
check(':q called quit', quit, 1);

// ---------------------------------------------------------------- neutral production projection/gateway
const projectedModel = instantiationService.createInstance(TextModel, 'one\ntwo', 'plaintext', TextModel.DEFAULT_CREATION_OPTIONS, null);
const controller = instantiationService.createInstance(TextEditorController, projectedModel, {
	documentId: 'file:///projection.txt', resource: 'file:///projection.txt', width: 20, visibleRowCount: 10,
	wrap: true, workingCopy: {
		isDirty: () => projectedModel.getValue() !== 'one\ntwo',
		onDidChangeDirty: Event.None, save: async () => true, revert: async () => {}
	}
}, textLayouts);
await controller.open();
const dispatch = async event => {
	const snapshot = controller.projection.snapshot;
	check(`accepted ${event.kind}`, controller.projection.dispatch({ ...event, generation: snapshot.generation, documentId: snapshot.documentId }), true);
	await new Promise(resolve => setImmediate(resolve));
};
await dispatch({ kind: 'text', text: 'X' });
check('projection typed through gateway', projectedModel.getValue(), 'Xone\ntwo');
await dispatch({ kind: 'command', action: 'delete-left' });
check('projection delete through shared cursor', projectedModel.getValue(), 'one\ntwo');
await dispatch({ kind: 'command', action: 'down' });
await dispatch({ kind: 'command', action: 'select-right' });
check('projection selection snapshot', controller.projection.snapshot.selections[0].offsets.length, 1);
await dispatch({ kind: 'text', text: 'Z' });
await dispatch({ kind: 'undo' });
check('projection undo', projectedModel.getValue(), 'one\ntwo');
await dispatch({ kind: 'redo' });
check('projection redo', projectedModel.getValue(), 'one\nZwo');
await dispatch({ kind: 'composition', phase: 'update', text: 'e\u0301', selected: { location: 2, length: 0 } });
check('projection marked range', controller.projection.snapshot.markedRange?.length, 2);
await dispatch({ kind: 'composition', phase: 'commit', text: '\u00e9' });
check('projection composition committed', controller.projection.snapshot.markedRange, undefined);
controller.setVim(true);
await dispatch({ kind: 'key', key: { name: 'escape' } });
await dispatch({ kind: 'key', key: { name: 'char', char: 'G' } });
check('projection Vim uses shared engine', controller.projection.snapshot.primaryCursor.lineNumber, 2);
await dispatch({ kind: 'key', key: { name: 'char', char: 'v' } });
check('projection publishes visual mode', controller.projection.snapshot.mode, 'visual');
check('projection publishes visual selection', controller.projection.snapshot.rows[1].selections.length, 1);
await dispatch({ kind: 'key', key: { name: 'escape' } });
await dispatch({ kind: 'key', key: { name: 'char', char: '/' } });
check('projection publishes / prompt', controller.projection.snapshot.vim?.prompt?.prefix.startsWith('/'), true);
await dispatch({ kind: 'key', key: { name: 'escape' } });
await dispatch({ kind: 'key', key: { name: 'char', char: ':' } });
check('projection publishes : prompt', controller.projection.snapshot.vim?.prompt?.prefix, ':');
await dispatch({ kind: 'key', key: { name: 'char', char: 'q' } });
check('projection publishes command text', controller.projection.snapshot.vim?.prompt?.value, 'q');
await dispatch({ kind: 'key', key: { name: 'enter' } });
await new Promise(resolve => setImmediate(resolve));
check('projection :q detaches Vim', controller.projection.snapshot.mode, 'viewer');
check('projection snapshot structured-clones', (() => { structuredClone(controller.projection.snapshot); return true; })(), true);
controller.dispose(); projectedModel.dispose();

// ---------------------------------------------------------------- the text, read back
console.log(`\nfinal model text:\n${model.getValue()}`);
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);

vim.dispose();
view.dispose();
model.dispose();
process.exit(failures === 0 ? 0 : 1);
