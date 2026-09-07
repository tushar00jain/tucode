import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeFixtureFile(root, relativePath, contents, options) {
	const path = join(root, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, options);
	return path;
}

export function runFixtureGit(cwd, args, { allowFailure = false, spawnGit = spawnSync } = {}) {
	const result = spawnGit('/usr/bin/git', [
		'-c', 'user.name=tucode e2e',
		'-c', 'user.email=e2e@example.invalid',
		'-c', 'core.autocrlf=false',
		'-c', 'commit.gpgsign=false',
		'-c', 'init.defaultBranch=main',
		...args
	], { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0 && !allowFailure) {
		throw new Error(`git ${args.join(' ')} in ${cwd} failed (${result.status}):\n${result.stderr || result.stdout}`);
	}
	return result;
}

/** The four small repositories used by public SCM and repository-filter journeys. */
export function createTinyGitRepositories(workspace, options = {}) {
	const git = (cwd, args, commandOptions) => runFixtureGit(cwd, args, { ...commandOptions, spawnGit: options.spawnGit });
	const write = (path, contents) => writeFixtureFile(workspace, path, contents);
	for (const name of ['alpha', 'beta', 'delta', 'gamma']) mkdirSync(join(workspace, name), { recursive: true });
	if (options.profile === 'empty') {
		for (const name of ['alpha', 'beta', 'delta', 'gamma']) git(join(workspace, name), ['init']);
		return;
	}

	const alpha = join(workspace, 'alpha');
	write('alpha/tracked.txt', 'committed contents\n');
	write('alpha/staged.txt', 'committed contents\n');
	write('alpha/modified.txt', 'committed contents\n');
	write('alpha/removed.txt', 'committed contents\n');
	git(alpha, ['init']); git(alpha, ['add', '.']); git(alpha, ['commit', '--no-verify', '-m', 'alpha base']);
	write('alpha/modified.txt', 'working-tree contents\n');
	write('alpha/added.txt', 'never added\n');
	rmSync(join(alpha, 'removed.txt'));
	mkdirSync(join(alpha, '.git', 'e2e-churn'), { recursive: true });

	const beta = join(workspace, 'beta');
	write('beta/conflict.txt', 'base\n');
	git(beta, ['init']); git(beta, ['add', '.']); git(beta, ['commit', '--no-verify', '-m', 'beta base']);
	git(beta, ['checkout', '-b', 'other']);
	write('beta/conflict.txt', 'other side\n');
	git(beta, ['commit', '--no-verify', '-am', 'other side']);
	git(beta, ['checkout', 'main']);
	write('beta/conflict.txt', 'main side\n');
	git(beta, ['commit', '--no-verify', '-am', 'main side']);
	git(beta, ['merge', 'other'], { allowFailure: true });

	const delta = join(workspace, 'delta');
	write('delta/base.txt', 'base\n');
	git(delta, ['init']); git(delta, ['add', '.']); git(delta, ['commit', '--no-verify', '-m', 'delta base']);
	write('delta/main.txt', 'main\n');
	git(delta, ['add', '.']); git(delta, ['commit', '--no-verify', '-m', 'delta main']);

	const gamma = join(workspace, 'gamma');
	write('gamma/gamma.ts', 'export const gamma = true;\n');
	git(gamma, ['init']); git(gamma, ['add', '.']); git(gamma, ['commit', '--no-verify', '-m', 'gamma base']);
	write('gamma/notes.md', 'not added yet\n');
}
