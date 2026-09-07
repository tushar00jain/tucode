import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { it } from 'node:test';
import { createFixture } from './lib/fixture.mjs';
import { drive, KEYS, paste, unexpectedStderr } from './lib/session.mjs';
import { paneTextLines } from './lib/probes.mjs';
import { assertCleanLogs } from './lib/logs.mjs';

it('SCM stages, unstages and commits through the upstream view, with shared slash and commit input', async () => {
	const fixture = createFixture({ sapling: false });
	try {
		const alpha = join(fixture.root, 'alpha');
		const git = (...args) => execFileSync('git', ['-C', alpha, ...args], { encoding: 'utf8' }).trim();
		const before = git('rev-parse', 'HEAD');
		const run = await drive(fixture, { cols: 300, rows: 90 }, [
			{ name: 'scm', keys: '3' },
			{ name: 'filter', keys: '/' },
			{ name: 'tracked', keys: `alpha/tracked${KEYS.enter}` },
			{ name: 'staged', keys: 'a' },
			{ name: 'findStaged', keys: '/' },
			{ name: 'selectStaged', keys: `tracked${KEYS.enter}` },
			{ name: 'unstaged', keys: 'u' },
			{ name: 'commitInput', keys: KEYS.home },
			{ name: 'edit', keys: 'i' },
			{ name: 'message', keys: paste('terminal SCM controller commit') },
			{ name: 'committed', keys: KEYS.enter },
			{ name: 'leaveInput', keys: KEYS.escape },
			{ name: 'rootFilter', keys: '/' },
			{ name: 'top', keys: `${KEYS.ctrlU}${KEYS.enter}` }
		]);
		assert.equal(run.exit.code, 0);
		assert.equal(unexpectedStderr(run.stderr).trim(), '');
		const lines = name => paneTextLines(run.frames[name]).map(line => line.trim());
		assert.ok(lines('staged').includes('▾ Staged Changes 2'), 'stage did not update the view');
		assert.ok(lines('unstaged').includes('▾ Staged Changes 1'), 'unstage did not update the view');
		assert.ok(lines('message').some(line => line.includes('terminal SCM controller commit')));
		assert.notEqual(git('rev-parse', 'HEAD'), before);
		assert.equal(git('log', '-1', '--format=%s'), 'terminal SCM controller commit');
		assert.equal(git('diff', '--cached', '--name-only'), '');
		assert.ok(git('diff', '--name-only').includes('tracked.txt'), 'unstaged changes were committed');
		assert.ok(lines('top').some(line => /^▾ beta\s/.test(line)), 'rapid clear/Enter retained the old root');
		assertCleanLogs(fixture.userData);
	} finally {
		fixture.dispose();
	}
});
