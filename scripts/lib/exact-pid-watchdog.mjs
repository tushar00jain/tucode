import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Copied verbatim from ../tscode/test/e2e/lib/wait.mjs. */
export const bound = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

/** Copied verbatim from ../tscode/test/e2e/lib/wait.mjs. */
export async function timedOut(promise, timeoutMs) {
	return Promise.race([promise.then(() => false), bound(timeoutMs).then(() => true)]);
}

const alive = pid => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

async function killPid(pid, graceMs) {
	if (!alive(pid)) return { pid, killed: false };
	try { process.kill(pid, 'SIGTERM'); } catch { return { pid, killed: false }; }
	const deadline = Date.now() + graceMs;
	while (alive(pid) && Date.now() < deadline) await bound(10);
	if (alive(pid)) {
		try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
	}
	const killDeadline = Date.now() + graceMs;
	while (alive(pid) && Date.now() < killDeadline) await bound(10);
	return { pid, killed: !alive(pid) };
}

export function createOwnedPidSession(prefix = 'tucode-owned-pids-') {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	const path = join(directory, 'registry.json');
	const token = randomUUID();
	writeFileSync(path, `${JSON.stringify({ token, pids: [] })}\n`);
	return {
		path, token,
		env: { TUCODE_OWNED_PID_REGISTRY: path, TUCODE_OWNED_PID_TOKEN: token },
		dispose: () => rmSync(directory, { recursive: true, force: true })
	};
}

function registeredPids(path, token) {
	if (!path || !token) return [];
	try {
		const registry = JSON.parse(readFileSync(path, 'utf8'));
		if (registry.token !== token) throw new Error(`owned-PID registry token mismatch at ${path}`);
		return [...new Set(registry.pids)].filter(pid => Number.isSafeInteger(pid) && pid > 1);
	} catch (error) {
		if (error?.code === 'ENOENT') return [];
		throw error;
	}
}

export async function killExactPid(child, graceMs = 1_000) {
	if (child.exitCode !== null || child.signalCode !== null) return { pid: child.pid, killed: false };
	const exited = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGTERM');
	if (await timedOut(exited, graceMs) && alive(child.pid)) child.kill('SIGKILL');
	await Promise.race([exited, bound(graceMs)]);
	return { pid: child.pid, killed: !alive(child.pid), signal: child.signalCode };
}

export async function runBounded(command, args, { cwd, env, timeoutMs, label, killGraceMs = 1_000, ownedPidRegistry, ownedPidToken } = {}) {
	const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });
	const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
	const startedAt = Date.now();
	if (await timedOut(exit, timeoutMs)) {
		const ownedPids = registeredPids(ownedPidRegistry, ownedPidToken).filter(pid => pid !== child.pid);
		const ownedKills = [];
		for (const pid of ownedPids) ownedKills.push(await killPid(pid, killGraceMs));
		const kill = await killExactPid(child, killGraceMs);
		const result = { label, pid: child.pid, timeoutMs, durationMs: Date.now() - startedAt, stdout, stderr, ownedPids, ownedKills, ...kill };
		const error = new Error(`${label} exceeded ${timeoutMs} ms; killed exact pid ${child.pid}\n${JSON.stringify(result)}`);
		error.result = result;
		throw error;
	}
	const completed = await exit;
	const ownedPids = registeredPids(ownedPidRegistry, ownedPidToken).filter(pid => pid !== child.pid && alive(pid));
	if (ownedPids.length) {
		const ownedKills = [];
		for (const pid of ownedPids) ownedKills.push(await killPid(pid, killGraceMs));
		const survivors = ownedPids.filter(alive);
		const result = { label, pid: child.pid, durationMs: Date.now() - startedAt, stdout, stderr, ownedPids, ownedKills, survivors, ...completed };
		const error = new Error(`${label} exited with owned descendants still live; cleaned exact registered PIDs\n${JSON.stringify(result)}`);
		error.result = result;
		throw error;
	}
	return { label, pid: child.pid, durationMs: Date.now() - startedAt, stdout, stderr, ownedPids, ...completed };
}
