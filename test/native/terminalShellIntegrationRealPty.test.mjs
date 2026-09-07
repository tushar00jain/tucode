import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { createRealPtyHarness } from './realPtyHarness.mjs';

function bounded(promise, label) {
	return Promise.race([promise, delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`timed out: ${label}`); })]);
}

test('real zsh emits a completed command through the production shell-integration path',
	{ skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
	const harness = await createRealPtyHarness({
		prefix: 'tucode-shell-integration-', collectionId: 'shell-integration', shellIntegration: true,
		configurationValue: () => undefined,
		createLaunch: ({ fixtureRoot }) => ({ executable: '/bin/zsh', cwd: fixtureRoot,
			env: { ...process.env }, label: 'zsh' })
	});
	const { fixtureRoot, userData, product, controller, dispatch, snapshotWhen } = harness;
	try {
		dispatch({ kind: 'create' });
		let snapshot = await snapshotWhen(value => value.sessions.length === 1, { label: 'terminal creation' });
		const terminal = snapshot.sessions[0];
		const event = inner => dispatch({ kind: 'terminal', event: {
			...inner, terminalId: terminal.terminalId, generation: controller.projection.snapshot.sessions[0].generation
		} });
		event({ kind: 'text', text: "printf 'REAL-SHELL-INTEGRATION\\n'" });
		event({ kind: 'key', sequence: '\r' });
		snapshot = await snapshotWhen(value => value.sessions[0]?.logicalText.includes('REAL-SHELL-INTEGRATION'),
			{ label: 'command output' });
		const integrationRoot = join(userData, 'terminal-shell-integration', `${process.env.USER}-${product.applicationName}-zsh`);
		assert.equal(existsSync(integrationRoot), true, `startup directory missing; user-data entries=${readdirSync(userData)}`);
		assert.deepEqual(readdirSync(integrationRoot).sort(), ['.zlogin', '.zprofile', '.zshenv', '.zshrc']);
		if (snapshot.sessions[0].commandDecorations.length !== 1) {
			snapshot = await snapshotWhen(value => value.sessions[0]?.commandDecorations.length === 1,
				{ label: 'completed command decoration' });
		}
		assert.match(snapshot.sessions[0].logicalText, /REAL-SHELL-INTEGRATION/);
		assert.equal(snapshot.sessions[0].commandDecorations[0].outcome, 'success');
		assert.match(snapshot.sessions[0].commandDecorations[0].command, /printf/);
		dispatch({ kind: 'close', terminalId: terminal.terminalId });
		await bounded(controller.whenSettled(), 'terminal shutdown');
		assert.equal(controller.projection.snapshot.sessions.length, 0);
		assert.ok(realpathSync(userData).startsWith(realpathSync(fixtureRoot)));
	} finally {
		await bounded(harness.dispose(), 'host teardown');
	}
});
