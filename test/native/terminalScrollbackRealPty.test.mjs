import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertGone, createRealPtyHarness, ROOT } from './realPtyHarness.mjs';

test('shared page commands project real PTY scrollback and reap the child',
	{ skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
	const harness = await createRealPtyHarness({
		prefix: 'tucode-terminal-scrollback-', collectionId: 'terminal-scrollback',
		workspaceRoot: fixtureRoot => fixtureRoot,
		prepare: fixtureRoot => {
			const fixture = join(fixtureRoot, 'terminal-fixture');
			execFileSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror',
				join(ROOT, 'test/native/fixtures/terminal-fixture.c'), '-o', fixture]);
			return fixture;
		},
		createLaunch: ({ fixtureRoot, prepared: fixture }) => ({ executable: fixture, cwd: fixtureRoot,
			env: { ...process.env }, label: 'fixture' })
	});
	const { controller, terminalEvent, snapshotWhen } = harness;
	let pid;
	try {
		let { snapshot: projection, terminalId, pid: createdPid } = await harness.createTerminal(
			value => value.sessions[0]?.logicalText.includes('READY:'),
			{ label: 'fixture ready', rejectExited: true });
		pid = createdPid;
		terminalEvent(terminalId, { kind: 'text', text: 'scroll-setup' });
		terminalEvent(terminalId, { kind: 'key', sequence: '\r' });
		projection = await snapshotWhen(value => value.sessions[0]?.logicalText.includes('OUT:scroll-needle'),
			{ label: 'needle output', rejectExited: true });
		assert.equal(projection.sessions[0].scrollTop, 0);

		terminalEvent(terminalId, { kind: 'key', sequence: '\r' });
		projection = await snapshotWhen(value => !value.sessions[0].logicalText.includes('scroll-needle'),
			{ label: 'needle pushed out', rejectExited: true });
		let session = projection.sessions[0];
		const bottom = session.scrollTop;
		terminalEvent(terminalId, { kind: 'scroll-page', pages: -1 });
		session = controller.projection.snapshot.sessions[0];
		assert.ok(session.scrollTop < bottom);
		assert.equal(session.logicalText.includes('scroll-needle'), true, 'page up did not project historical PTY rows');
		terminalEvent(terminalId, { kind: 'scroll-page', pages: 1 });
		session = controller.projection.snapshot.sessions[0];
		assert.equal(session.scrollTop, bottom);
		assert.equal(session.logicalText.includes('scroll-needle'), false, 'page down did not restore the bottom viewport');

		await harness.closeTerminal(terminalId);
		assert.equal(controller.projection.snapshot.sessions.length, 0);
		assertGone(pid);
	} finally {
		await harness.dispose();
	}
});
