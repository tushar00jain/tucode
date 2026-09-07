import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createOwnedPidSession, runBounded } from '../../scripts/lib/exact-pid-watchdog.mjs';

test('the outer watchdog kills and reports only its exact hung child PID', { timeout: 5_000 }, async () => {
	const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
	let failure;
	try {
		await runBounded(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)"], {
			timeoutMs: 100, killGraceMs: 100, label: 'fake hung child'
		});
	} catch (error) { failure = error; }
	try {
		assert.ok(failure, 'the hung child escaped its watchdog');
		assert.equal(failure.result.killed, true);
		assert.match(failure.message, new RegExp(`killed exact pid ${failure.result.pid}`));
		assert.equal(Number(failure.result.stdout), failure.result.pid);
		assert.equal(failure.result.timeoutMs, 100);
		assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'the exact-PID watchdog killed an unrelated sibling');
	} finally {
		unrelated.kill('SIGKILL');
	}
});

test('the outer watchdog kills an atomically registered owned child and no unrelated PID', { timeout: 5_000 }, async () => {
	const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
	const owned = createOwnedPidSession('tucode-watchdog-proof-');
	let failure;
	try {
		const script = [
			"const {spawn}=require('node:child_process')",
			"const {writeFileSync,renameSync}=require('node:fs')",
			"const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])",
			"const path=process.env.TUCODE_OWNED_PID_REGISTRY",
			"const token=process.env.TUCODE_OWNED_PID_TOKEN",
			"const temporary=path+'.fake.tmp'",
			"writeFileSync(temporary,JSON.stringify({token,pids:[child.pid]}))",
			"renameSync(temporary,path)",
			"process.stdout.write(String(child.pid))",
			"setInterval(()=>{},1000)"
		].join(';');
		await runBounded(process.execPath, ['-e', script], {
			env: { ...process.env, ...owned.env }, timeoutMs: 150, killGraceMs: 100,
			label: 'fake runner with owned child', ownedPidRegistry: owned.path, ownedPidToken: owned.token
		});
	} catch (error) { failure = error; }
	try {
		assert.ok(failure, 'the fake runner escaped its watchdog');
		assert.deepEqual(failure.result.ownedPids, [Number(failure.result.stdout)]);
		assert.equal(failure.result.ownedKills[0].killed, true);
		assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'the owned-PID registry widened to an unrelated process');
	} finally {
		unrelated.kill('SIGKILL');
		owned.dispose();
	}
});
