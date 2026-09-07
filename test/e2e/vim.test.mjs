// Vim mode, driven over a real `TextModel`.
//
// The work is `lib/vimDriver.mjs`, in a process of its own: it needs `bin/bundler-imports.mjs`,
// which answers this tree's `*.css` imports, and a loader cannot be added to a test process that
// is already running. So this spawns it and reports what it printed — which is what makes a
// failure a list of named checks rather than an exit code.
//
// Upstream counterpart: none — this fork's own suite, over a vim mode tscode does not have.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('vim mode edits the model, and the model says so', { timeout: 60_000 }, async () => {
	const output = await new Promise((fulfil, reject) => {
		const child = spawn(process.execPath,
			['--import', './bin/bundler-imports.mjs', 'test/e2e/lib/vimDriver.mjs'],
			{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

		let text = '';
		child.stdout.on('data', chunk => { text += chunk; });
		child.stderr.on('data', chunk => { text += chunk; });
		child.on('error', reject);
		child.on('exit', code => fulfil({ code, text }));
	});

	assert.strictEqual(output.code, 0, `the driver reported:\n${output.text}`);
});
