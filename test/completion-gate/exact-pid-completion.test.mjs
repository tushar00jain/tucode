import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createOwnedPidSession, runBounded } from '../../scripts/lib/exact-pid-watchdog.mjs';

const alive = pid => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

test('bounded completion kills only its exact timed-out child and reports cleanup', { timeout: 5_000 }, async () => {
	const owned = createOwnedPidSession('tucode-gate-selftest-');
	let caught;
	try {
		await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 100, killGraceMs: 500, label: 'completion-gate-owned-child',
			ownedPidRegistry: owned.path, ownedPidToken: owned.token, env: { ...process.env, ...owned.env }
		});
	} catch (error) { caught = error; }
	finally { owned.dispose(); }
	assert.match(caught?.message ?? '', /exceeded 100 ms; killed exact pid/);
	assert.ok(Number.isSafeInteger(caught.result.pid));
	assert.equal(alive(caught.result.pid), false);
});

async function isolatedFixture(file, timeoutMs = 1_000) {
	const owned = createOwnedPidSession('tucode-isolated-fixture-');
	try {
		return await runBounded(process.execPath, [resolve(import.meta.dirname, 'fixtures', file)], {
			timeoutMs, killGraceMs: 500, label: file, ownedPidRegistry: owned.path, ownedPidToken: owned.token,
			env: { ...process.env, ...owned.env }
		});
	} finally { owned.dispose(); }
}

test('polluting native fixture cannot contaminate the following isolated child', async () => {
	const polluted = await isolatedFixture('polluting-global.mjs');
	const clean = await isolatedFixture('clean-global.mjs');
	assert.equal(polluted.code, 0); assert.equal(clean.code, 0);
	assert.notEqual(polluted.pid, clean.pid);
});

test('multi-child sequence cleans a timed-out child and its exact registered descendant', { timeout: 5_000 }, async () => {
	const first = await isolatedFixture('clean-global.mjs');
	assert.equal(first.code, 0); assert.equal(alive(first.pid), false);
	const owned = createOwnedPidSession('tucode-isolated-timeout-');
	const descendantScript = `const fs=require('node:fs');const cp=require('node:child_process');
		const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
		const path=process.env.TUCODE_OWNED_PID_REGISTRY;const record=JSON.parse(fs.readFileSync(path,'utf8'));
		record.pids.push(child.pid);fs.writeFileSync(path,JSON.stringify(record));setInterval(()=>{},1000);`;
	let caught;
	try {
		await runBounded(process.execPath, ['-e', descendantScript], { timeoutMs: 150, killGraceMs: 500,
			label: 'isolated-timeout-with-descendant', ownedPidRegistry: owned.path, ownedPidToken: owned.token,
			env: { ...process.env, ...owned.env } });
	} catch (error) { caught = error; }
	finally { owned.dispose(); }
	assert.match(caught?.message ?? '', /exceeded 150 ms/);
	assert.equal(alive(caught.result.pid), false);
	assert.equal(caught.result.ownedPids.length, 1);
	assert.ok(caught.result.ownedKills.every(value => value.killed));
});

test('production Node loader registers exact PID and token before application imports', () => {
	const owned = createOwnedPidSession('tucode-loader-registration-');
	try {
		const result = spawnSync(process.execPath, ['--import', './bin/bundler-imports.mjs', '--eval', 'process.stdout.write(String(process.pid))'],
			{ cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: { ...process.env, ...owned.env } });
		assert.equal(result.status, 0, result.stderr);
		const registry = JSON.parse(readFileSync(owned.path, 'utf8'));
		assert.equal(registry.token, owned.token); assert.deepEqual(registry.pids, [Number(result.stdout)]);
		writeFileSync(owned.path, `${JSON.stringify({ token: 'wrong', pids: [] })}\n`);
		const rejected = spawnSync(process.execPath, ['--import', './bin/bundler-imports.mjs', '--eval', '0'],
			{ cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: { ...process.env, ...owned.env } });
		assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /registry token mismatch/);
	} finally { owned.dispose(); }
});
