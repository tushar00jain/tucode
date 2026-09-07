import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertGone, createZshPtyHarness } from './realPtyHarness.mjs';

test('one shared terminal group owns two independent real PTY pane buffers and reaps both children',
	{ skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
	const harness = await createZshPtyHarness('tucode-terminal-split-', 'terminal-split');
	const { controller, dispatch, terminalEvent, snapshotWhen } = harness;
	const pids = [];
	try {
		let { snapshot, terminalId: firstId, pid } = await harness.createTerminal(
			value => value.sessions[0]?.logicalText.length > 0);
		pids.push(pid);
		dispatch({ kind: 'split' });
		snapshot = await snapshotWhen(value => value.groups.length === 1 && value.groups[0].terminalIds.length === 2 && value.sessions[1]?.logicalText.length > 0);
		pids.push(controller.diagnostics()[1].pid);
		const secondId = snapshot.groups[0].terminalIds[1];
		assert.equal(snapshot.activeTerminalId, secondId);
		assert.equal(new Set(pids).size, 2);

		terminalEvent(secondId, { kind: 'text', text: String.raw`printf '\163\160\154\151\164\055\160\141\156\145\n'` });
		terminalEvent(secondId, { kind: 'key', sequence: '\r' });
		snapshot = await snapshotWhen(value => value.sessions.find(session => session.terminalId === secondId)?.logicalText.includes('split-pane'));
		const first = snapshot.sessions.find(session => session.terminalId === firstId);
		const second = snapshot.sessions.find(session => session.terminalId === secondId);
		assert.ok(first && second);
		assert.equal(first.logicalText.includes('split-pane'), false, 'split panes shared one emulator buffer');
		assert.equal((second.logicalText.match(/split-pane/g) ?? []).length, 1);

		for (const terminalId of [secondId, firstId]) {
			await harness.closeTerminal(terminalId);
		}
		assert.equal(controller.projection.snapshot.sessions.length, 0);
		for (const pid of pids) assertGone(pid);
	} finally {
		await harness.dispose();
		for (const pid of pids) assertGone(pid);
	}
});
