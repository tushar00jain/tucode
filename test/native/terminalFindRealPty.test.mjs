import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertGone, createZshPtyHarness } from './realPtyHarness.mjs';

test('real PTY output is searched by the shared SearchAddon contract and the child is reaped',
	{ skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
	const harness = await createZshPtyHarness('tucode-terminal-find-', 'terminal-find');
	const { controller, terminalEvent, snapshotWhen } = harness;
	let pid;
	try {
		let { snapshot: projection, terminalId, pid: createdPid } = await harness.createTerminal(
			value => value.sessions[0]?.logicalText.length > 0);
		pid = createdPid;
		terminalEvent(terminalId, { kind: 'text', text:
			"printf '\\156\\145\\145\\144\\154\\145\\nother\\n\\156\\145\\145\\144\\154\\145\\n'" });
		terminalEvent(terminalId, { kind: 'key', sequence: '\r' });
		projection = await snapshotWhen(value => (value.sessions[0]?.logicalText.match(/needle/g) ?? []).length === 2);
		terminalEvent(terminalId, { kind: 'find', action: 'open' });
		terminalEvent(terminalId, { kind: 'find', action: 'query', query: 'needle' });
		let find = controller.projection.snapshot.sessions[0].find;
		assert.equal(find.resultCount, 2);
		assert.equal(find.resultIndex, 1);
		assert.ok(find.decorations.length >= 2);
		assert.equal(find.decorations.filter(value => value.active).length, 1);
		terminalEvent(terminalId, { kind: 'find', action: 'next' });
		find = controller.projection.snapshot.sessions[0].find;
		assert.equal(find.resultIndex, 0);
		terminalEvent(terminalId, { kind: 'find', action: 'previous' });
		assert.equal(controller.projection.snapshot.sessions[0].find.resultIndex, 1);
		terminalEvent(terminalId, { kind: 'find', action: 'query', query: 'absent' });
		assert.equal(controller.projection.snapshot.sessions[0].find.resultCount, 0);
		terminalEvent(terminalId, { kind: 'find', action: 'close' });
		assert.equal(controller.projection.snapshot.sessions[0].find.visible, false);

		await harness.closeTerminal(terminalId);
		assert.equal(controller.projection.snapshot.sessions.length, 0);
		assertGone(pid);
	} finally {
		await harness.dispose();
	}
});
