import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import '../../src/vs/base/node/browserGlobals.js';
import { NativeSCM } from '../../src/editor/nativeScm.js';
import { Event } from '../../src/vs/base/common/event.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { extUri } from '../../src/vs/base/common/resources.js';
import { SCMTreeDataSource, SCMTreeKeyboardNavigationLabelProvider } from '../../src/vs/workbench/contrib/scm/browser/scmViewPane.js';
import { TauriGitSCMProvider } from '../../src/vs/workbench/contrib/scm/tauri/tauriGitProvider.js';
import { ScmChannelClient } from '../../src/vs/workbench/contrib/scm/tauri/scmIpc.js';
import { TauriMainProcessService } from '../../src/vs/base/parts/ipc/tauri/ipc.tauri.js';
import { stopHost } from '../../src/vs/base/parts/ipc/node/ipc.host.js';

test('native Changes uses real multi-repository statuses, shared slash rules and upstream tree/list models', { timeout: 30000 }, async () => {
	mkdirSync('.build/test-fixtures', { recursive: true });
	const workspace = mkdtempSync(join(process.cwd(), '.build/test-fixtures/native-scm-'));
	const service = new TauriMainProcessService();
	const client = new ScmChannelClient(service.getChannel('scm'));
	const providers: TauriGitSCMProvider[] = [];
	const commands: any[] = [];
	let native: NativeSCM | undefined;
	try {
		for (const name of ['repo-a', 'repo-b']) {
			const root = join(workspace, name);
			mkdirSync(join(root, 'nested/one/two'), { recursive: true });
			const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
			git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
			writeFileSync(join(root, 'same.txt'), 'base\n'); writeFileSync(join(root, 'nested/one/two/deep.txt'), 'base\n');
			git('add', '.'); git('commit', '-qm', 'fixture');
			writeFileSync(join(root, 'same.txt'), 'staged\n'); git('add', 'same.txt');
			writeFileSync(join(root, 'same.txt'), 'unstaged\n'); writeFileSync(join(root, 'nested/one/two/deep.txt'), 'changed\n');
			writeFileSync(join(root, 'new.txt'), 'untracked\n');
			providers.push(new TauriGitSCMProvider(URI.file(root), {} as never, async command => { commands.push(command); }, { extUri } as never, { getWorkspaceFolder: () => undefined } as never));
		}
		await service.getChannel('file').call('registerWorkspaceRoot', URI.file(workspace));
		assert.equal((await client.discover(workspace)).length, 2);
		for (const provider of providers) { provider.updateStatus(await client.status(provider.rootUri.fsPath), true); }
		const repositories = providers.map(provider => ({ provider, input: { visible: false } }));
		const view = { repositories, visibleRepositories: repositories, onDidChangeVisibleRepositories: Event.None };
		const settings: Record<string, unknown> = { 'scm.defaultViewMode': 'list', 'scm.compactFolders': true };
		let publications = 0;
		const config = { getValue: (key: string) => settings[key], onDidChangeConfiguration: Event.None };
		const instantiation = { createInstance: (ctor: unknown, mode: any) => {
			if (ctor === SCMTreeDataSource) { return new SCMTreeDataSource(mode, config as never, view as never); }
			assert.equal(ctor, SCMTreeKeyboardNavigationLabelProvider);
			return new SCMTreeKeyboardNavigationLabelProvider(mode, { getUriLabel: (uri: URI) => uri.fsPath } as never);
		} };
		native = new NativeSCM(() => { publications++; }, instantiation as never, config as never, view as never, { get: () => undefined, onDidChangeValue: () => Event.None } as never,
			{ onDidColorThemeChange: Event.None, getColorTheme: () => ({ getColor: (id: string) => id }) } as never);
		native.onError(error => { throw error; });
		await native.refresh();
		const labels = () => native!.snapshot.outlineRows.map(row => row.render.accessibleLabel);
		assert.ok(labels().includes('repo-a')); assert.ok(labels().includes('repo-b'));
		assert.equal(labels().filter(label => label.startsWith('Staged Changes')).length, 2);
		assert.equal(labels().filter(label => label.startsWith('same.txt')).length, 4);
		assert.equal(labels().filter(label => label.startsWith('new.txt')).length, 2);
		assert.ok(native.snapshot.outlineRows.filter(row => row.id.endsWith('/new.txt')).every(row => row.status === 'U'));
		assert.ok(native.snapshot.outlineRows.filter(row => row.id.endsWith('/same.txt')).every(row => row.status === 'M' && !row.render.runs[0].text.includes('Modified')));
		const modifiedColor = native.snapshot.outlineRows.find(row => row.status === 'M')!.statusColor;
		const untrackedColor = native.snapshot.outlineRows.find(row => row.status === 'U')!.statusColor;
		assert.ok(modifiedColor); assert.ok(untrackedColor); assert.notEqual(modifiedColor, untrackedColor);
		const rowB = native.snapshot.outlineRows.find(row => row.id.includes('repo-b') && row.id.includes('/index/') && row.id.includes('same.txt'))!;
		assert.equal(rowB.resource, URI.file(join(workspace, 'repo-b/same.txt')).toString());
		assert.equal(rowB.isDirectory, false);
		assert.ok(native.snapshot.outlineRows.filter(row => row.id.includes('repo-b') && row.status === 'M' && row.resource === rowB.resource).length === 2,
			'staged and unstaged rows must share the same file icon resource');
		native.dispatch({ eventType: 'outline-open', id: rowB.id }); await native.refresh();
		assert.equal(commands.length, 1); assert.ok(JSON.stringify(commands[0]).includes('repo-b')); assert.ok(!JSON.stringify(commands[0]).includes('repo-a'));
		native.dispatch({ eventType: 'scm-filter-change', value: 'repo-a/' }); await native.refresh();
		assert.ok(native.snapshot.outlineRows.every(row => !row.id.includes('repo-b')));
		native.dispatch({ eventType: 'scm-filter-change', value: 'repo-a/nested/' }); await native.refresh();
		assert.ok(labels().some(label => label.startsWith('deep.txt'))); assert.ok(!labels().some(label => label.startsWith('same.txt')));
		native.root.cancel(); await native.refresh(); assert.ok(labels().includes('repo-b'));
		native.root.open(); native.dispatch({ eventType: 'scm-filter-change', value: 'repo-b' }); await native.refresh();
		native.root.complete(1); await native.refresh(); assert.equal(native.snapshot.filter.value, 'repo-b');
		native.root.commit(); await native.refresh(); assert.equal(native.snapshot.filter.visible, false);
		assert.ok(native.snapshot.outlineRows.every(row => !row.id.includes('repo-a')));
		native.root.open(); native.dispatch({ eventType: 'scm-filter-change', value: '' }); await native.refresh(); native.root.commit(); await native.refresh();
		assert.ok(labels().includes('repo-a'));
		native.root.open(); native.dispatch({ eventType: 'scm-filter-change', value: 'repo-b/' }); await native.refresh();
		native.dispatch({ eventType: 'scm-filter-cancel', focused: false });
		native.dispatch({ eventType: 'outline-open', id: rowB.id }); await native.refresh();
		assert.equal(commands.length, 2); assert.ok(JSON.stringify(commands[1]).includes('repo-b'));
		assert.equal(native.snapshot.filter.restoreFocus, false);
		settings['scm.defaultViewMode'] = 'tree'; await native.refresh();
		assert.ok(labels().some(label => label.endsWith('one/two')), JSON.stringify(labels())); assert.ok(!labels().some(label => label.includes(workspace)));
		settings['scm.compactFolders'] = false; await native.refresh(); assert.ok(labels().includes('one')); assert.ok(labels().includes('two'));
		const folder = native.snapshot.outlineRows.find(row => row.id.includes('repo-a') && row.render.accessibleLabel === 'one')!;
		const deep = native.snapshot.outlineRows.find(row => row.id.includes('repo-a') && row.render.accessibleLabel.startsWith('deep.txt'))!;
		assert.ok(deep.parentId?.includes('/two'));
		assert.equal(folder.isDirectory, true);
		assert.equal(deep.isDirectory, false);
		assert.equal(deep.resource, URI.file(join(workspace, 'repo-a/nested/one/two/deep.txt')).toString());
		native.dispatch({ eventType: 'outline-toggle', id: folder.id, expanded: false }); await native.refresh();
		assert.ok(!native.snapshot.outlineRows.some(row => row.id === deep.id));
		writeFileSync(join(providers[1].rootUri.fsPath, 'refresh.txt'), 'new\n');
		providers[1].updateStatus(await client.status(providers[1].rootUri.fsPath), true); await native.refresh();
		assert.equal(labels().filter(label => label.startsWith('refresh.txt')).length, 1);
		assert.equal(native.snapshot.outlineRows.find(row => row.id === folder.id)?.expanded, false);
		native.dispatch({ eventType: 'outline-toggle', id: folder.id, expanded: true }); await native.refresh();
		assert.equal(native.snapshot.outlineRows.find(row => row.id === deep.id)?.parentId, deep.parentId);
		native.root.open(); native.dispatch({ eventType: 'scm-filter-change', value: 'repo-b/nested/' }); native.root.cancel(); await native.refresh();
		assert.ok(labels().includes('repo-a')); assert.ok(labels().includes('repo-b')); assert.equal(native.snapshot.filter.visible, false);
		const originalChildren = native.source.getChildren.bind(native.source);
		let release!: () => void;
		let started!: () => void;
		const fetching = new Promise<void>(resolve => { started = resolve; });
		const pending = new Promise<void>(resolve => { release = resolve; });
		native.source.getChildren = async input => { started(); await pending; return originalChildren(input); };
		const refresh = native.refresh(); await fetching; native.dispose(); const count = publications;
		release(); await refresh; assert.equal(publications, count);
		assert.equal(native.dispatch({ eventType: 'scm-filter-open' }), false);
	} finally { native?.dispose(); providers.forEach(provider => provider.dispose()); await stopHost(); rmSync(workspace, { recursive: true, force: true }); }
});
