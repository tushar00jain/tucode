import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Boot } from '../../src/boot.js';
import { NativeSearch } from '../../src/editor/nativeSearch.js';
import { DeferredPromise } from '../../src/vs/base/common/async.js';
import { Emitter, Event } from '../../src/vs/base/common/event.js';
import { IMainProcessService } from '../../src/vs/platform/ipc/common/mainProcessService.js';
import { IChannel } from '../../src/vs/base/parts/ipc/common/ipc.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { stopHost } from '../../src/vs/base/parts/ipc/node/ipc.host.js';
import { IConfigurationService, ConfigurationTarget } from '../../src/vs/platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../src/vs/platform/contextview/browser/contextView.js';
import { ServiceCollection } from '../../src/vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../src/vs/platform/instantiation/common/descriptors.js';
import { IKeyboardLayoutService } from '../../src/vs/platform/keyboardLayout/common/keyboardLayout.js';
import { IThemeService } from '../../src/vs/platform/theme/common/themeService.js';
import { IEditorService } from '../../src/vs/workbench/services/editor/common/editorService.js';
import { IStatusbarService } from '../../src/vs/workbench/services/statusbar/browser/statusbar.js';
import { TerminalContextMenuService } from '../../src/tui/workbench/contextMenu.js';
import { TerminalKeyboardLayoutService } from '../../src/tui/workbench/terminalKeyboard.js';
import { TerminalStatusbarPart } from '../../src/tui/workbench/statusbarPart.js';

class SearchTestBoot extends Boot {
	constructor(folder: string, private readonly delayedStream: Event<any>) { super(); this.folder = URI.file(folder); }
	protected registerFrontendServices(services: ServiceCollection): void {
		const mainProcess = services.get(IMainProcessService) as IMainProcessService;
		const getChannel = mainProcess.getChannel.bind(mainProcess);
		mainProcess.getChannel = name => {
			const channel = getChannel(name);
			return name !== 'search' ? channel : {
				call: channel.call.bind(channel),
				listen: (event: string, args: any) => args?.query?.pattern === 'slow-original' ? this.delayedStream : channel.listen(event, args)
			} as IChannel;
		};
		services.set(IContextMenuService, new SyncDescriptor(TerminalContextMenuService, [this.overlays]));
		services.set(IKeyboardLayoutService, new TerminalKeyboardLayoutService());
		services.set(IStatusbarService, new SyncDescriptor(TerminalStatusbarPart));
	}
	async start(workspacePath: string) {
		const { serviceCollection } = await this.initServices();
		const configuration = serviceCollection.get(IConfigurationService) as IConfigurationService & { initialize(workspace: { id: string; configPath: URI }): Promise<void> };
		await configuration.initialize({ id: 'native-search-test', configPath: URI.file(workspacePath) });
		return this.createInstantiationService(serviceCollection);
	}
}

test('native Search uses real multi-root results, shared / and exact editor ranges', { timeout: 45000 }, async t => {
	const fixtureRoot = join(process.cwd(), '.build', 'test-fixtures');
	mkdirSync(fixtureRoot, { recursive: true });
	const fixture = mkdtempSync(join(fixtureRoot, 'native-search-'));
	const savedProfile = process.env.TSCODE_USER_DATA_DIR;
	process.env.TSCODE_USER_DATA_DIR = join(fixture, 'profile');
	const opened: any[] = [];
	let native: NativeSearch | undefined;
	let boot: SearchTestBoot | undefined;
	try {
		// The native watcher observes configuration files as well as their parents.
		for (const directory of ['.vscode', 'alpha/.vscode', 'beta/.vscode', 'profile']) {
			mkdirSync(join(fixture, directory), { recursive: true });
			for (const name of ['settings', 'tasks', 'launch', 'mcp', 'keybindings']) {
				writeFileSync(join(fixture, directory, `${name}.json`), name === 'keybindings' ? '[]' : '{}');
			}
		}
		for (const folder of ['alpha', 'beta']) {
			mkdirSync(join(fixture, folder, 'nested'), { recursive: true });
			writeFileSync(join(fixture, folder, 'nested', 'same.txt'), `before\n${folder} NEEDLE\nafter\n`);
		}
		writeFileSync(join(fixture, 'alpha', 'long.txt'), `${'padding '.repeat(200)} NEEDLE tail\n`);
		const workspacePath = join(fixture, 'test.code-workspace');
		writeFileSync(workspacePath, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }],
			settings: { 'search.searchOnType': false, 'search.collapseResults': 'alwaysExpand', 'search.defaultViewMode': 'list' } }));
		let streamStarted = new DeferredPromise<void>(), streamCancelled = new DeferredPromise<void>();
		const stream = new Emitter<any>({ onDidAddFirstListener: () => { void streamStarted.complete(); },
			onDidRemoveLastListener: () => { void streamCancelled.complete(); } });
		t.after(() => stream.dispose());
		boot = new SearchTestBoot(fixture, stream.event);
		const instantiation = await boot.start(workspacePath);
		const configuration = instantiation.invokeFunction(accessor => accessor.get(IConfigurationService));
		const theme = instantiation.invokeFunction(accessor => accessor.get(IThemeService));
		await (theme as IThemeService & { initialize(): Promise<void> }).initialize();
		const editors = instantiation.invokeFunction(accessor => accessor.get(IEditorService));
		editors.openEditor = (async (input: unknown) => { opened.push(input); return undefined; }) as IEditorService['openEditor'];

		let onPaint = () => {};
		native = instantiation.createInstance(NativeSearch, () => onPaint());
		const errors: unknown[] = [];
		native.onError(error => errors.push(error));
		const view = native;
		const send = (eventType: string, payload = {}) => assert.equal(view.dispatch({ eventType, ...payload }), true, eventType);
		send('search-query-change', { value: 'NEEDLE', revision: 1 });
		send('search-submit'); await view.whenSettled();
		assert.deepEqual(errors, [], 'native row construction failed');
		await t.test('both roots and upstream preview elision reach native rows', () => {
			assert.equal(view.snapshot.search.revision, 1);
			assert.equal(view.model.searchResult.count(), 3);
			const rows = view.snapshot.outlineRows;
			assert.ok(rows.some(row => row.resource?.endsWith('/alpha/nested/same.txt')), JSON.stringify(rows));
			assert.ok(rows.some(row => row.resource?.endsWith('/beta/nested/same.txt')));
			const long = rows.find(row => row.kind === 'search-match' && row.resource?.endsWith('/long.txt'));
			assert.ok(long);
			const text = long.render.runs.map(run => run.text).join('');
			assert.ok(text.includes('NEEDLE'));
			const sourceMatch = view.model.searchResult.matches().find(file => file.resource.path.endsWith('/long.txt'))!.matches()[0];
			const preview = sourceMatch.preview();
			assert.ok(text.endsWith(preview.before + preview.inside + preview.after));
			assert.ok(text.length < 200, 'must use preview() elision, not full source line');
		});
		await t.test('/ filters result paths without changing the search and Escape restores them', async () => {
			send('search-filter-open');
			try {
				send('search-filter-change', { value: 'nested/same', revision: 1 }); await view.whenSettled();
				assert.equal(view.model.searchResult.count(), 3);
				assert.equal(view.snapshot.outlineRows.filter(row => row.kind === 'search-match').length, 2);
				// Multi-root labels use “root • path”, not an invented root/path prefix.
				send('search-filter-change', { value: 'beta', revision: 2 }); await view.whenSettled();
				const matches = view.snapshot.outlineRows.filter(row => row.kind === 'search-match');
				assert.equal(matches.length, 1);
				assert.ok(matches[0].resource?.endsWith('/beta/nested/same.txt'));
			} finally {
				send('search-filter-cancel'); await view.whenSettled();
			}
			assert.equal(view.snapshot.outlineRows.filter(row => row.kind === 'search-match').length, 3);
		});
		await t.test('opens exact range and rejects a stale explicit row ID', async () => {
			const match = view.snapshot.outlineRows.find(row => row.kind === 'search-match' && row.resource?.endsWith('/beta/nested/same.txt'))!;
			send('outline-focus', { id: match.id }); send('outline-open', { id: match.id }); await view.whenSettled();
			assert.equal(opened.length, 1);
			assert.ok(opened[0].resource.path.endsWith('/beta/nested/same.txt'));
			assert.equal(opened[0].options.selection.startLineNumber, 2);
			assert.equal(opened[0].options.selection.startColumn, 6);
			assert.equal(view.dispatch({ eventType: 'outline-open', id: 'stale-id' }), false);
			await view.whenSettled(); assert.equal(opened.length, 1);
		});
		await t.test('tree setting changes hierarchy without losing matches', async () => {
			await configuration.updateValue('search.defaultViewMode', 'tree', ConfigurationTarget.MEMORY);
			await view.whenSettled();
			assert.equal(view.snapshot.outlineRows.filter(row => row.kind === 'search-match').length, 3);
			assert.ok(view.snapshot.outlineRows.some(row => row.isDirectory && row.resource?.endsWith('/nested')));
		});
		await t.test('case, include and exclude controls use the real search service', async () => {
			send('search-query-change', { value: 'needle', revision: 2 });
			send('search-toggle-case'); await view.whenSettled();
			assert.equal(view.model.searchResult.count(), 0);
			send('search-toggle-case'); await view.whenSettled();
			assert.equal(view.model.searchResult.count(), 3);
			send('search-includes-change', { value: '**/long.txt', revision: 3 });
			send('search-submit'); await view.whenSettled();
			assert.equal(view.model.searchResult.count(), 1);
			send('search-includes-change', { value: '', revision: 4 });
			send('search-excludes-change', { value: '**/long.txt', revision: 5 });
			send('search-submit'); await view.whenSettled();
			assert.equal(view.model.searchResult.count(), 2);
			send('search-excludes-change', { value: '', revision: 6 });
		});
		await t.test('invalid regex is reported and a later valid query recovers', async () => {
			send('search-query-change', { value: '[', revision: 7 });
			send('search-toggle-regex'); await view.whenSettled();
			assert.ok(view.snapshot.search.message);
			assert.equal(view.model.searchResult.count(), 0);
			send('search-query-change', { value: 'NEEDLE', revision: 8 });
			send('search-submit'); await view.whenSettled();
			assert.equal(view.model.searchResult.count(), 3);
		});
		await t.test('replace paint and selected replacement use upstream model operations', async () => {
			send('search-toggle-replace');
			send('search-replace-change', { value: 'REPLACED', revision: 9 }); await view.whenSettled();
			const row = view.snapshot.outlineRows.find(row => row.kind === 'search-match' && row.resource?.endsWith('/beta/nested/same.txt'))!;
			assert.ok(row.render.runs.some(run => run.text === 'NEEDLE' && run.style.strikethrough));
			assert.ok(row.render.runs.some(run => run.text === 'REPLACED' && run.style.bg));
			send('outline-focus', { id: row.id });
			send('search-replace-selected'); await view.whenSettled();
			assert.equal(readFileSync(join(fixture, 'beta', 'nested', 'same.txt'), 'utf8'), 'before\nbeta REPLACED\nafter\n');
			assert.equal(readFileSync(join(fixture, 'alpha', 'nested', 'same.txt'), 'utf8'), 'before\nalpha NEEDLE\nafter\n');
			assert.equal(view.model.searchResult.count(), 2);
		});
		await t.test('typing coalesces queries and Enter flushes the pending search', async () => {
			await configuration.updateValue('search.searchOnType', true, ConfigurationTarget.MEMORY);
			await configuration.updateValue('search.searchOnTypeDebouncePeriod', 10000, ConfigurationTarget.MEMORY);
			const queries: string[] = [];
			const search = view.model.search.bind(view.model);
			view.model.search = (...args) => { queries.push(args[0].contentPattern.pattern); return search(...args); };
			try {
				for (const value of ['N', 'NE', 'NEE', 'NEEDLE']) { send('search-query-change', { value }); }
				assert.deepEqual(queries, [], 'typing must not start four filesystem searches');
				send('search-submit'); await view.whenSettled();
				assert.deepEqual(queries, ['NEEDLE'], 'Enter replaces the delayed query, not a second search');
				assert.equal(view.model.searchResult.count(), 2);
				queries.length = 0;
				await configuration.updateValue('search.searchOnTypeDebouncePeriod', 1, ConfigurationTarget.MEMORY);
				for (const value of ['R', 'RE', 'REPLACED']) { send('search-query-change', { value }); }
				await view.whenSettled();
				assert.deepEqual(queries, ['REPLACED'], 'automatic search should also coalesce without Enter');
				assert.equal(view.model.searchResult.count(), 1);
			} finally { view.model.search = search; }
		});
		await t.test('large result refreshes coalesce; waiting does not rebuild or traverse match leaves', async () => {
			writeFileSync(join(fixture, 'alpha', 'many.txt'), Array.from({ length: 2000 }, (_, index) => `speed-fixture ${index}`).join('\n'));
			send('search-query-change', { value: 'speed-fixture' });
			send('search-submit'); await view.whenSettled();
			assert.equal(view.snapshot.outlineRows.filter(row => row.kind === 'search-match').length, 2000);
			let roots = 0;
			let leaves = 0;
			const getChildren = view.source.getChildren.bind(view.source);
			view.source.getChildren = element => {
				if (element === view.model.searchResult) { roots++; }
				if (!('searchModel' in element) && !view.source.hasChildren(element as any)) { leaves++; }
				return getChildren(element);
			};
			try {
				const started = performance.now();
				await Promise.all(Array.from({ length: 32 }, () => view.refresh()));
				assert.ok(roots <= 2, `32 overlapping refreshes caused ${roots} full traversals`);
				assert.equal(leaves, 0, 'leaf rows need no child lookup');
				t.diagnostic(`2000 results: 32 refresh requests coalesced to ${roots} traversals in ${Math.round(performance.now() - started)}ms`);
				roots = 0;
				await view.whenSettled(); await view.whenSettled();
				assert.equal(roots, 0, 'idle acknowledgements must not rebuild the tree');
			} finally { view.source.getChildren = getChildren; }
		});
		await t.test('collapsed search files defer children and expansion loads current results', async () => {
			const file = view.model.searchResult.matches().find(file => file.resource.path.endsWith('/many.txt'))!;
			const row = view.snapshot.outlineRows.find(row => row.resource?.endsWith('/many.txt') && row.kind !== 'search-match')!;
			send('outline-toggle', { id: row.id, expanded: false }); await view.whenSettled();
			let leafFetches = 0;
			const getChildren = view.source.getChildren.bind(view.source);
			view.source.getChildren = element => { if (element === file) { leafFetches++; } return getChildren(element); };
			try {
				await view.refresh();
				assert.equal(leafFetches, 0, 'refreshing a collapsed file must not enumerate its 2000 matches');
				assert.equal(view.snapshot.outlineRows.filter(row => row.kind === 'search-match').length, 0);
				send('outline-toggle', { id: row.id, expanded: true }); await view.whenSettled();
				assert.equal(leafFetches, 1);
				assert.equal(view.snapshot.outlineRows.filter(row => row.kind === 'search-match').length, 2000);
			} finally { view.source.getChildren = getChildren; }
		});
		await t.test('existing-file changes use the upstream targeted refresh and input keeps cached rows', async () => {
			const file = view.model.searchResult.matches().find(file => file.resource.path.endsWith('/many.txt'))!;
			let roots = 0, files = 0;
			const getChildren = view.source.getChildren.bind(view.source);
			view.source.getChildren = element => {
				if (element === view.model.searchResult) { roots++; }
				if (element === file) { files++; }
				return getChildren(element);
			};
			try {
				file.add(file.matches()[0], true);
				await view.whenSettled();
				assert.equal(roots, 0, 'updating one existing file should not refresh the root');
				assert.equal(files, 1);
				await configuration.updateValue('search.searchOnType', false, ConfigurationTarget.MEMORY);
				await view.whenSettled();
				const rows = view.snapshot.outlineRows;
				send('search-query-change', { value: 'draft only' });
				assert.equal(view.snapshot.outlineRows, rows, 'draft edits must not reconstruct result rows');
			} finally { view.source.getChildren = getChildren; }
		});

		assert.deepEqual(errors, []);
		await t.test('typing during an unfinished result stream cancels its subscription and rejects late results', { timeout: 5000 }, async () => {
			for (const submit of [true, false]) {
				streamStarted = new DeferredPromise<void>();
				streamCancelled = new DeferredPromise<void>();
				writeFileSync(join(fixture, 'alpha', 'slow.txt'), 'slow-original\n');
				writeFileSync(join(fixture, 'alpha', 'slow-next.txt'), 'slow-original\n');
				await configuration.updateValue('search.searchOnType', true, ConfigurationTarget.MEMORY);
				await configuration.updateValue('search.searchOnTypeDebouncePeriod', submit ? 10000 : 1, ConfigurationTarget.MEMORY);
				await view.whenSettled();
				const firstPaint = new DeferredPromise<void>();
				onPaint = () => {
					if (view.snapshot.outlineRows.some(row => row.resource?.endsWith('/slow.txt'))) { void firstPaint.complete(); }
				};
				send('search-query-change', { value: 'slow-original' }); send('search-submit');
				await streamStarted.p;
				t.diagnostic('paused backend stream started');
				const range = { startLineNumber: 0, endLineNumber: 0, startColumn: 0, endColumn: 13 };
				// The stock collector completes a file when it sees the next resource.
				const batch = ['slow.txt', 'slow-next.txt'].map(name => ({ path: join(fixture, 'alpha', name), numMatches: 1,
					results: [{ previewText: 'slow-original', rangeLocations: [{ source: range, preview: range }] }] }));
				stream.fire(batch); // Intentionally leave the backend stream open.
				await firstPaint.p;
				t.diagnostic('partial results painted while stream remained open');
				assert.equal(view.snapshot.search.searching, true);
				send('search-query-change', { value: 'speed-fixture', revision: 100 });
				assert.equal(view.snapshot.search.query, 'speed-fixture', 'draft input is accepted before the old search finishes');
				assert.equal(view.snapshot.search.searching, true);
				if (submit) { send('search-submit'); } // Otherwise search-on-type must cancel and restart by itself.
				await streamCancelled.p;
				t.diagnostic('previous backend subscription disposed');
				await view.whenSettled();
				assert.equal(view.model.searchResult.count(), 2000);
				stream.fire(batch); // A late backend event has no subscribed consumer.
				await view.whenSettled();
				assert.equal(view.snapshot.search.query, 'speed-fixture');
				assert.equal(view.snapshot.search.searching, false);
				assert.equal(view.model.searchResult.count(), 2000);
				assert.ok(view.snapshot.outlineRows.every(row => !row.resource?.endsWith('/slow.txt')));
				onPaint = () => {};
			}
		});
	} finally {
		native?.dispose();
		boot?.dispose();
		await stopHost();
		if (savedProfile === undefined) { delete process.env.TSCODE_USER_DATA_DIR; } else { process.env.TSCODE_USER_DATA_DIR = savedProfile; }
		rmSync(fixture, { recursive: true, force: true });
	}
});
