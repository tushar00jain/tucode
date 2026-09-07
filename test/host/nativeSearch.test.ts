import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Boot } from '../../src/boot.js';
import { NativeSearch } from '../../src/editor/nativeSearch.js';
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
	constructor(folder: string) { super(); this.folder = URI.file(folder); }
	protected registerFrontendServices(services: ServiceCollection): void {
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
	try {
		for (const folder of ['alpha', 'beta']) {
			mkdirSync(join(fixture, folder, 'nested'), { recursive: true });
			writeFileSync(join(fixture, folder, 'nested', 'same.txt'), `before\n${folder} NEEDLE\nafter\n`);
		}
		writeFileSync(join(fixture, 'alpha', 'long.txt'), `${'padding '.repeat(200)} NEEDLE tail\n`);
		const workspacePath = join(fixture, 'test.code-workspace');
		writeFileSync(workspacePath, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }],
			settings: { 'search.searchOnType': false, 'search.collapseResults': 'alwaysExpand', 'search.defaultViewMode': 'list' } }));
		const boot = new SearchTestBoot(fixture);
		const instantiation = await boot.start(workspacePath);
		const configuration = instantiation.invokeFunction(accessor => accessor.get(IConfigurationService));
		const theme = instantiation.invokeFunction(accessor => accessor.get(IThemeService));
		await (theme as IThemeService & { initialize(): Promise<void> }).initialize();
		const editors = instantiation.invokeFunction(accessor => accessor.get(IEditorService));
		editors.openEditor = (async (input: unknown) => { opened.push(input); return undefined; }) as IEditorService['openEditor'];
		native = instantiation.createInstance(NativeSearch, () => {});
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
		assert.deepEqual(errors, []);
	} finally {
		native?.dispose();
		await stopHost();
		if (savedProfile === undefined) { delete process.env.TSCODE_USER_DATA_DIR; } else { process.env.TSCODE_USER_DATA_DIR = savedProfile; }
		rmSync(fixture, { recursive: true, force: true });
	}
});
