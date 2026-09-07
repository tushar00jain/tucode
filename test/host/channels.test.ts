/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: none — tscode exercises the six channels through the running app, so there is no host-level suite to stand in for.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { Event } from '../../src/vs/base/common/event.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { generateUuid } from '../../src/vs/base/common/uuid.js';
import { stopHost } from '../../src/vs/base/parts/ipc/node/ipc.host.js';
import { TauriMainProcessService, whenSubscribed } from '../../src/vs/base/parts/ipc/tauri/ipc.tauri.js';

/**
 * The six channels, answering a real `tscode-host` over the stdio transport.
 *
 * Every call goes through `IChannel` — the same object the vendored clients hold
 * — so what passes here is the seam itself, not a stand-in for it. Needs the host
 * binary, which `npm run test:host` builds.
 */

const service = new TauriMainProcessService();
const file = service.getChannel('file');
const watch = service.getChannel('watch');
const search = service.getChannel('search');
const scm = service.getChannel('scm');
const sl = service.getChannel('sl');
const pty = service.getChannel('pty');

/**
 * The checkout, and the one git repository these tests can count on. `cwd`
 * rather than a path relative to this file, because the file runs from the
 * compiler's output directory and its depth there is not this one.
 */
const repository = process.cwd();

/** Nothing here should take seconds; a hang is a failure, not a slow machine. */
const TIMEOUT = 30_000;

let workspace: string;

before(async () => {
	// macOS FSEvents deliberately does not promise events for its per-user
	// temporary tree. Keep the disposable fixture on the checkout's volume so
	// the host test exercises the same watcher used for a real workspace.
	workspace = mkdtempSync(join(repository, 'src-tauri', 'target', 'tucode-host-'));
	mkdirSync(join(workspace, 'src'));
	writeFileSync(join(workspace, 'src', 'alpha.txt'), 'alpha\n');

	// Nothing outside a registered root is reachable, so this is the first call
	// any frontend makes, exactly as boot will make it.
	await file.call('registerWorkspaceRoot', URI.file(workspace));
});

after(async () => {
	await stopHost();
	rmSync(workspace, { recursive: true, force: true });
});

test('file: userDataDir, stat and readdir', { timeout: TIMEOUT }, async () => {
	const userDataDir = URI.revive(await file.call('userDataDir'));
	assert.equal(userDataDir.scheme, 'file');
	assert.match(userDataDir.path, /\/User$/);

	const stat = await file.call<{ type: number; size: number }>('stat', [URI.file(join(workspace, 'src', 'alpha.txt'))]);
	assert.equal(stat.type, 1 /* FileType.File */);
	assert.equal(stat.size, 6);

	const entries = await file.call<[string, number][]>('readdir', [URI.file(workspace)]);
	assert.deepEqual(entries, [['src', 2 /* FileType.Directory */]]);
});

test('file: a rejection rehydrates as a FileSystemProviderError', { timeout: TIMEOUT }, async () => {
	await assert.rejects(
		() => file.call('stat', [URI.file(join(workspace, 'missing.txt'))]),
		(error: Error & { code?: string }) => error.code === 'EntryNotFound'
	);
});

test('watch: a write reaches the fileChange event', { timeout: TIMEOUT }, async () => {
	const sessionId = generateUuid();
	const requestId = generateUuid();

	const changes = Event.toPromise(watch.listen<{ resource: unknown; type: number }[]>('fileChange', [sessionId]));

	// The next call is what starts the producer, and `listen()` has no completion
	// of its own — this is the race `whenSubscribed` exists for.
	await whenSubscribed(watch);
	await watch.call('watch', [sessionId, requestId, URI.file(workspace), { recursive: true, excludes: [] }]);

	writeFileSync(join(workspace, 'src', 'beta.txt'), 'beta\n');

	const batch = await changes;
	assert.ok(batch.length > 0);

	await watch.call('unwatch', [sessionId, requestId]);
});

test('search: fileSearch streams the workspace', { timeout: TIMEOUT }, async () => {
	const results: string[] = [];
	const complete = new Promise<void>(resolve => {
		const subscription = search.listen<any>('fileSearch', {
			type: 1 /* QueryType.File */,
			folderQueries: [{ folder: URI.file(workspace) }]
		})(item => {
			if (Array.isArray(item)) {
				results.push(...item.map(match => match.path));
			} else if (item?.path) {
				results.push(item.path);
			} else if (item?.limitHit !== undefined || item?.stats || item?.type === 'success') {
				subscription.dispose();
				resolve();
			}
		});
	});

	await complete;
	assert.ok(results.some(path => path.endsWith('alpha.txt')), `no alpha.txt in ${JSON.stringify(results)}`);
});

test('scm: the checkout opens as a git repository', { timeout: TIMEOUT }, async () => {
	await file.call('registerWorkspaceRoot', URI.file(repository));

	const repositories = await scm.call<{ root: string }[]>('discover', { path: repository, maxDepth: 0 });
	assert.equal(repositories.length, 1);

	const epoch = await scm.call<number>('epoch');
	assert.equal(typeof epoch, 'number');
});

test('sl: the repository registry answers', { timeout: TIMEOUT }, async () => {
	assert.deepEqual(await sl.call('repositories'), []);
	assert.equal(typeof await sl.call<number>('epoch'), 'number');
});

test('pty: the shell environment answers', { timeout: TIMEOUT }, async () => {
	const environment = await pty.call<Record<string, string>>('getEnvironment');
	assert.ok(Object.keys(environment).length > 0);
});

test('pty: a bare executable resolves on PATH and receives its arguments', { timeout: TIMEOUT }, async () => {
	const environment = await pty.call<Record<string, string>>('getEnvironment');
	const ptyId = await pty.call<number>('create', {
		shellLaunchConfig: {
			executable: basename(process.execPath),
			args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('EDITOR-OPENED:'+process.argv[1]+'\\r\\n');process.stdin.on('data',d=>{if(d.toString()==='Z'){process.exit(0);}process.stdout.write('EDITOR-SAW:'+JSON.stringify(d.toString())+'\\r\\n');})", 'fixture.txt']
		},
		cwd: workspace,
		cols: 80,
		rows: 24,
		env: environment,
		executableEnv: environment
	});
	const data = Event.toPromise(pty.listen<string>('onProcessData', { ptyId }));
	await whenSubscribed(pty);
	assert.equal(await pty.call('start', { ptyId }), null);
	assert.match(await data, /EDITOR-OPENED:fixture\.txt/);
	await pty.call('shutdown', { ptyId, immediate: true });
});

/**
 * **This test ends the host, so it has to stay last** — everything after it would be answered with
 * `the host was stopped`.
 *
 * What it asserts is §16.7's shape at the backend's own boundary: a run that has finished its
 * work leaves nothing alive behind it. A shell holds its cwd on Windows, so a directory that can be
 * removed the *first* time is the whole statement — a `shutdown_all` that only signalled its
 * children leaves the shell and its `conhost.exe --headless` holding this one, which is `rmSync`
 * failing `EPERM` and retrying, and a process tree outliving the run by hours.
 */
test('pty: closing the host reaps its shells, so nothing holds their cwd', { timeout: TIMEOUT }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'tucode-shell-'));
	const executable = await pty.call<string>('getDefaultSystemShell', {});
	const environment = await pty.call<Record<string, string>>('getEnvironment');

	const ptyId = await pty.call<number>('create', {
		shellLaunchConfig: { executable, args: [] },
		cwd,
		cols: 80,
		rows: 24,
		env: environment,
		executableEnv: environment
	});
	assert.equal(await pty.call('start', { ptyId }), null, 'the shell did not launch');

	await stopHost();

	// `maxRetries: 0`, because a retry is what this defect looks like rather than what fixes it.
	rmSync(cwd, { recursive: true, force: true, maxRetries: 0 });
});
