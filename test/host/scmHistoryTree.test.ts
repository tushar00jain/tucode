import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { observableValue } from '../../src/vs/base/common/observable.js';
import { SCMHistoryViewModel } from '../../src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.js';
import { SCMHistoryTreeModel } from '../../src/vs/workbench/contrib/scm/browser/scmHistoryTreeModel.js';
import { SCMHistoryTreeDataSource, openSCMHistoryChange, resolveSCMHistoryItemComparison } from '../../src/vs/workbench/contrib/scm/browser/scmHistoryTree.js';
import { ViewMode } from '../../src/vs/workbench/contrib/scm/common/scm.js';
import { SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId } from '../../src/vs/workbench/contrib/scm/common/history.js';
import { getSCMHistoryGraphGeometry, getSCMHistoryGraphPlaceholderGeometry, scmHistoryGraphPathCommands, toISCMHistoryItemViewModelArray } from '../../src/vs/workbench/contrib/scm/browser/scmHistory.js';
import { isSCMHistoryItemChangeNode, isSCMHistoryItemChangeViewModelTreeElement } from '../../src/vs/workbench/contrib/scm/browser/util.js';

function fixture() {
	let requests = 0;
	let wait: Promise<void> | undefined;
	const originalUri = URI.parse('git:/repo/old.txt?parent'), modifiedUri = URI.parse('git:/repo/new.txt?commit');
	const change = { uri: URI.file('/repo/nested/deep/file.txt'), originalUri, modifiedUri };
	const provider = { historyItemRef: observableValue('head', { id: 'main', name: 'main', revision: 'commit' }),
		historyItemRemoteRef: observableValue('remote', { id: 'remote', name: 'origin/main', revision: 'remotecommit' }),
		async resolveHistoryItemRefsCommonAncestor() { return 'base'; },
		async provideHistoryItemChanges() { requests++; await wait; return [change]; } };
	const repository = { provider: { id: 'repo', rootUri: URI.file('/repo'), historyProvider: observableValue('provider', provider) } };
	const item = { id: 'commit', parentIds: ['parent'], subject: 'Subject', message: 'Full message', author: 'Author', displayId: 'commit' };
	const commit: any = { repository, type: 'historyItemViewModel', historyItemViewModel: toISCMHistoryItemViewModelArray([item])[0] };
	const repositoryObs = observableValue<any>('repository', repository);
	const mode = observableValue('mode', ViewMode.List);
	let roots = [commit];
	const viewModel = Object.assign(Object.create(SCMHistoryViewModel.prototype), { repository: repositoryObs, viewMode: mode,
		clearRepositoryState() {}, loadMore() {}, hasMoreHistoryItems() { return true; }, async getHistoryItems() { return roots; } });
	const model = new SCMHistoryTreeModel(viewModel);
	const errors: unknown[] = []; model.onError(error => errors.push(error));
	return { model, commit, provider, repositoryObs, mode, change, errors, get requests() { return requests; },
		setWait(value: Promise<void>) { wait = value; }, setRoots(value: any[]) { roots = value; } };
}

test('history loading is lazy; repeated expand/collapse/reopen deduplicates changed-file requests', async () => {
	const f = fixture();
	try {
		await f.model.refresh(); assert.equal(f.requests, 0);
		const id = f.model.identity.getId(f.commit);
		await Promise.all([f.model.toggle(id, true), f.model.toggle(id, true)]);
		assert.equal(f.requests, 1); assert.equal(f.model.rendered.length, 3);
		await f.model.toggle(id, false); assert.equal(f.model.rendered.length, 2);
		await f.model.toggle(id, true); assert.equal(f.requests, 1);
		const file = f.model.rendered[1].element!;
		assert.equal(f.model.tree.getParentNodeLocation(file), f.commit);
		assert.deepEqual(f.errors, []);
	} finally { f.model.dispose(); }
});

test('collapse during request wins, and repository switch/disposal discard late children', async () => {
	for (const action of ['collapse', 'switch', 'dispose']) {
		const f = fixture(); await f.model.refresh();
		let release!: () => void; f.setWait(new Promise(resolve => release = resolve));
		const id = f.model.identity.getId(f.commit), opening = f.model.toggle(id, true);
		await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.requests, 1);
		let next = Promise.resolve();
		if (action === 'collapse') { next = f.model.toggle(id); }
		else if (action === 'switch') { f.repositoryObs.set(undefined, undefined); f.setRoots([]); next = f.model.refresh(); }
		else { f.model.dispose(); }
		let publications = 0; f.model.onDidChange(() => publications++);
		release(); await opening; await next;
		assert.ok(!f.model.rendered.some(row => isSCMHistoryItemChangeViewModelTreeElement(row.element)));
		if (action === 'dispose') { assert.equal(publications, 0); }
		assert.deepEqual(f.errors, []); f.model.dispose();
	}
});

test('tree/list reuse vendor resource tree compression and folders toggle from default expanded state', async () => {
	const f = fixture();
	try {
		await f.model.refresh(); await f.model.toggle(f.model.identity.getId(f.commit), true);
		f.mode.set(ViewMode.Tree, undefined); await f.model.setViewMode();
		const folder = f.model.rendered.find(row => isSCMHistoryItemChangeNode(row.element))!.element!;
		const id = f.model.identity.getId(folder);
		assert.equal(f.model.tree.isCollapsed(folder), false);
		await f.model.toggle(id); assert.equal(f.model.tree.isCollapsed(folder), true);
		await f.model.refresh(); assert.equal(f.model.tree.isCollapsed(f.model.get(id)!), true);
		await f.model.toggle(id); assert.equal(f.model.tree.isCollapsed(f.model.get(id)!), false);
		assert.deepEqual(f.errors, []);
	} finally { f.model.dispose(); }
});

test('mode changes queued during refresh settle loading and use the current roots', async () => {
	const f = fixture();
	try {
		const refresh = f.model.refresh(); f.mode.set(ViewMode.Tree, undefined);
		await Promise.all([refresh, f.model.setViewMode()]);
		assert.equal(f.model.loading, false); assert.equal(f.requests, 0); assert.equal(f.model.rendered.length, 2);
	} finally { f.model.dispose(); }
});

test('vendor incoming/outgoing comparison and synthetic-parent rules survive restoration', async () => {
	const f = fixture();
	try {
		for (const [kind, id, expected] of [['incoming-changes', SCMIncomingHistoryItemId, 'remote'], ['outgoing-changes', SCMOutgoingHistoryItemId, 'main']]) {
			const element = { ...f.commit, historyItemViewModel: { ...f.commit.historyItemViewModel, kind, historyItem: { ...f.commit.historyItemViewModel.historyItem, id } } };
			assert.deepEqual(await resolveSCMHistoryItemComparison(element), { historyItemId: expected, historyItemParentId: 'base' });
		}
		f.commit.historyItemViewModel.historyItem.parentIds = [SCMIncomingHistoryItemId];
		assert.deepEqual(await resolveSCMHistoryItemComparison(f.commit), { historyItemId: 'commit', historyItemParentId: 'base' });
		f.commit.historyItemViewModel.historyItem.parentIds = [];
		assert.deepEqual(await resolveSCMHistoryItemComparison(f.commit), { historyItemId: 'commit', historyItemParentId: undefined });
	} finally { f.model.dispose(); }
});

test('historical edits, renames, additions and deletions open provider revision URIs', async () => {
	const f = fixture(), source = new SCMHistoryTreeDataSource(() => ViewMode.List);
	try {
		const element: any = Array.from(await source.getChildren(f.commit))[0];
		const opened: any[] = [], editors = { async openEditor(input: any) { opened.push(input); } } as any;
		await openSCMHistoryChange(editors, element);
		assert.equal(opened[0].original.resource, f.change.originalUri); assert.equal(opened[0].modified.resource, f.change.modifiedUri);
		await openSCMHistoryChange(editors, { ...element, historyItemChange: { uri: f.change.uri, modifiedUri: f.change.modifiedUri } });
		await openSCMHistoryChange(editors, { ...element, historyItemChange: { uri: f.change.uri, originalUri: f.change.originalUri } });
		assert.equal(opened[1].resource, f.change.modifiedUri); assert.equal(opened[2].resource, f.change.originalUri);
		assert.match(opened[0].label, /old.txt.*parent.*new.txt.*commit/);
	} finally { source.dispose(); f.model.dispose(); }
});

test('merge graph cubic paint commands meet lane endpoints and child placeholders continue outgoing lanes', () => {
	const items = [ ['merge', ['left', 'right']], ['left', ['base']], ['right', ['base']], ['base', []] ].map(([id, parentIds]) => ({ id, parentIds, subject: id, message: id, author: 'A' })) as any;
	const models = toISCMHistoryItemViewModelArray(items);
	for (const model of models) {
		const geometry = getSCMHistoryGraphGeometry(model);
		for (const shape of geometry.shapes.filter(shape => shape.d)) {
			const commands = scmHistoryGraphPathCommands(shape.d!);
			assert.ok(commands.flat().every(Number.isFinite));
			assert.equal(commands[0][0], 0);
		}
		const placeholder = getSCMHistoryGraphPlaceholderGeometry(model.outputSwimlanes);
		assert.equal(placeholder.shapes.length, model.outputSwimlanes.length);
		placeholder.shapes.forEach((shape, index) => {
			assert.deepEqual(scmHistoryGraphPathCommands(shape.d!), [[0, 11 * (index + 1), 0], [1, 11 * (index + 1), 22]]);
			assert.equal(shape.color, model.outputSwimlanes[index].color);
		});
	}
	const curve = scmHistoryGraphPathCommands('M 22 0 A 11 11 0 0 1 11 11')[1];
	assert.equal(curve[0], 2); assert.equal(curve[1], 22); assert.equal(curve[4], 11); assert.deepEqual(curve.slice(5), [11, 11]);
});

test('view model stops missing-cursor paging at exhaustion, deduplicates and preserves provider getters/parents', async () => {
	const { Event } = await import('../../src/vs/base/common/event.js');
	let statistics = 1, calls = 0;
	const commits = [
		{ id: 'commit', parentIds: ['base'], subject: 'Local', message: 'Local', author: 'A', get statistics() { return { files: statistics, insertions: 0, deletions: 0 }; } },
		{ id: 'remotecommit', parentIds: ['base'], subject: 'Remote', message: 'Remote', author: 'A' },
		{ id: 'base', parentIds: [], subject: 'Base', message: 'Base', author: 'A' }
	];
	const f = fixture();
	const provider = Object.assign(f.provider, { historyItemBaseRef: observableValue('baseRef', undefined),
		async provideHistoryItems(options: { skip: number }) { calls++; return commits.slice(options.skip, options.skip + 1); } });
	const repository: any = { provider: { id: 'repo', providerId: 'git', label: 'Git', rootUri: URI.file('/repo'), historyProvider: observableValue('p', provider) } };
	const vm = new SCMHistoryViewModel({ getValue: (key: string) => key === 'scm.graph.pageSize' ? 1 : 'list' } as any,
		{ createKey: () => ({ set() {}, reset() {} }) } as any, { onWillStop: Event.None } as any,
		{ repositoryCount: 1, repositories: [repository], onDidAddRepository: Event.None, onDidRemoveRepository: Event.None } as any,
		{ activeRepository: observableValue('active', { repository }), graphShowIncomingChangesConfig: observableValue('incoming', true), graphShowOutgoingChangesConfig: observableValue('outgoing', true) } as any,
		{ get() {}, store() {}, onWillSaveState: Event.None } as any);
	try {
		await vm.getHistoryItems(); vm.loadMore('absent');
		const rows = await vm.getHistoryItems();
		assert.equal(calls, 4); assert.equal(vm.hasMoreHistoryItems(), false);
		assert.deepEqual(commits[0].parentIds, ['base']);
		statistics = 12;
		assert.equal(rows.find(row => row.historyItemViewModel.historyItem.id === 'commit')!.historyItemViewModel.historyItem.statistics!.files, 12);
		assert.equal(Array.from(await new SCMHistoryTreeDataSource(() => ViewMode.List).getChildren(vm)).some((row: any) => row.type === 'historyItemLoadMore'), false);
	} finally { vm.dispose(); f.model.dispose(); }
});

test('real Git root/add/delete/rename rows open exact historical content through backend revision URIs', { timeout: 30000 }, async () => {
	const { execFileSync } = await import('node:child_process');
	const { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { ScmChannelClient } = await import('../../src/vs/workbench/contrib/scm/tauri/scmIpc.js');
	const { TauriMainProcessService } = await import('../../src/vs/base/parts/ipc/tauri/ipc.tauri.js');
	const { stopHost } = await import('../../src/vs/base/parts/ipc/node/ipc.host.js');
	const { TauriGitHistoryProvider } = await import('../../src/vs/workbench/contrib/scm/tauri/tauriGitHistoryProvider.js');
	const { fromGitUri } = await import('../../src/vs/workbench/contrib/scm/tauri/gitUri.js');
	mkdirSync('.build/test-fixtures', { recursive: true });
	const root = mkdtempSync(join(process.cwd(), '.build/test-fixtures/history-'));
	const service = new TauriMainProcessService(), client = new ScmChannelClient(service.getChannel('scm'));
	const provider = new TauriGitHistoryProvider(client, root, { addHistoryItemChanges() {} }, { getValue() {} } as any, { error() {} } as any);
	try {
		const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
		git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
		writeFileSync(join(root, 'old.txt'), 'historic original\n'); writeFileSync(join(root, 'deleted.txt'), 'historic deleted\n');
		git('add', '.'); git('commit', '-qm', 'Root'); const first = git('rev-parse', 'HEAD');
		renameSync(join(root, 'old.txt'), join(root, 'renamed.txt'));
		rmSync(join(root, 'deleted.txt')); writeFileSync(join(root, 'added.txt'), 'historic added\n');
		git('add', '-A'); git('commit', '-qm', 'Rename add delete'); const second = git('rev-parse', 'HEAD');
		writeFileSync(join(root, 'renamed.txt'), 'working content must not open\n');
		await service.getChannel('file').call('registerWorkspaceRoot', URI.file(root)); await client.discover(root);
		const roots = await provider.provideHistoryItemChanges(first, undefined);
		assert.equal(roots?.length, 2); assert.ok(roots?.every(change => !change.originalUri && change.modifiedUri));
		const changes = await provider.provideHistoryItemChanges(second, first);
		const rename = changes!.find(change => change.uri.path.endsWith('/renamed.txt'))!;
		const added = changes!.find(change => change.uri.path.endsWith('/added.txt'))!;
		const deleted = changes!.find(change => change.uri.path.endsWith('/deleted.txt'))!;
		assert.ok(rename.originalUri && rename.modifiedUri); assert.equal(added.originalUri, undefined); assert.equal(deleted.modifiedUri, undefined);
		const read = async (uri: URI) => { const { path, ref } = fromGitUri(uri); return (await client.show(root, ref, path)).toString(); };
		assert.equal(await read(rename.originalUri!), 'historic original\n');
		assert.equal(await read(rename.modifiedUri!), 'historic original\n');
		assert.equal(await read(added.modifiedUri!), 'historic added\n');
		assert.equal(await read(deleted.originalUri!), 'historic deleted\n');
	} finally { provider.dispose(); await stopHost(); rmSync(root, { recursive: true, force: true }); }
});

test('restored reference picker uses native multi-selection without recursive selection events', async () => {
	const { NativeQuickInputService } = await import('../../src/editor/nativeQuickInput.js');
	const { HistoryItemRefPicker } = await import('../../src/vs/workbench/contrib/scm/browser/scmHistoryTree.js');
	const service = new NativeQuickInputService({} as any, { createKey: () => ({ set() {}, reset() {} }) } as any);
	const picker = new HistoryItemRefPicker({ async provideHistoryItemRefs() { return [{ id: 'main', name: 'main' }, { id: 'topic', name: 'topic' }]; } } as any, 'auto', service);
	try {
		let accepted = false;
		const result = picker.pickHistoryItemRef().then(value => { accepted = true; return value; });
		await new Promise(resolve => setTimeout(resolve, 0));
		const projection = service.currentProjection!;
		assert.equal(projection.snapshot.canSelectMany, true);
		const select = (label: string) => {
			const row = projection.snapshot.rows.find(row => row.label === label)!;
			assert.equal(projection.dispatch({ sessionId: projection.snapshot.sessionId, type: 'select', id: row.id, selected: true }), true);
		};
		select('main'); select('topic');
		assert.deepEqual(projection.snapshot.rows.filter(row => row.selected).map(row => row.label), ['main', 'topic']);
		assert.equal(accepted, false);
		select('All'); assert.deepEqual(projection.snapshot.rows.filter(row => row.selected).map(row => row.label), ['All']);
		select('main'); select('topic');
		projection.dispatch({ sessionId: projection.snapshot.sessionId, type: 'accept' });
		assert.deepEqual(await result, ['main', 'topic']);
	} finally { picker.dispose(); service.dispose(); }
});
