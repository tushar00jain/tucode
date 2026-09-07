import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createOwnedPidSession, runBounded } from './lib/exact-pid-watchdog.mjs';

const root = resolve(import.meta.dirname, '..');
const budgets = JSON.parse(readFileSync(resolve(root, 'test/safe-matrix-durations.json')));
const tests = (directory, suffix = '.test.mjs') => readdirSync(resolve(root, directory)).filter(name => name.endsWith(suffix)).sort().map(name => `${directory}/${name}`);
const node = (...args) => ({ command: process.execPath, args });
const steps = [
	['typecheck', { command: resolve(root, 'node_modules/.bin/tsc'), args: ['--noEmit'] }],
	['build', node('bin/build.mjs')],
	['unit', node('--test', '--test-concurrency=8', '--import', './test/unit/tsResolve.mjs', 'test/unit/*.test.ts')],
	['host', node('--import', './bin/bundler-imports.mjs', '--test', ...tests('out/test/host', '.test.js'))],
	['rust', { command: 'cargo', args: ['test', '--profile', 'dev-small', '-j', '8'], cwd: resolve(root, 'src-tauri') }],
	['tui-e2e', node('--test', '--test-concurrency=1', ...tests('test/e2e'))],
	['native', node('--test', '--test-concurrency=1', ...tests('test/native'))],
	['coverage', node('--test', ...tests('test/coverage'))],
	['diff-check', { command: 'git', args: ['diff', '--check'] }]
];

const parseMeasured = output => [...output.matchAll(/^\s*[✔✖]\s+(.+?)\s+\(([\d.]+)(ms|s)\)/gm)].map(match => ({
	title: match[1], durationMs: Math.round(Number(match[2]) * (match[3] === 's' ? 1_000 : 1))
}));
const startedAt = Date.now();
const results = [];
for (const [name, spec] of steps) {
	const budget = budgets.steps[name];
	if (!budget) throw new Error(`safe-matrix duration budget missing for ${name}`);
	const owned = createOwnedPidSession(`tucode-safe-${name}-`);
	let result;
	try {
		result = await runBounded(spec.command, spec.args, {
			cwd: spec.cwd ?? root,
			env: { ...process.env, ...owned.env },
			timeoutMs: budget.budgetMs,
			label: `safe matrix: ${name}`,
			ownedPidRegistry: owned.path,
			ownedPidToken: owned.token
		});
	} finally {
		owned.dispose();
	}
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	const measured = parseMeasured(result.stdout);
	const slowest = measured.toSorted((a, b) => b.durationMs - a.durationMs)[0] ?? null;
	const diagnostic = {
		name, currentMs: result.durationMs, baselineMs: budget.baselineMs,
		baselineDeltaMs: result.durationMs - budget.baselineMs,
		budgetMs: budget.budgetMs, budgetRemainingMs: budget.budgetMs - result.durationMs, slowest
	};
	console.log(`TUCODE_SAFE_MATRIX_STEP ${JSON.stringify(diagnostic)}`);
	if (result.code !== 0 || result.signal !== null) throw new Error(`safe-matrix step failed ${JSON.stringify({ ...diagnostic, code: result.code, signal: result.signal })}`);
	if (slowest && budget.slowestTestBudgetMs !== undefined && slowest.durationMs > budget.slowestTestBudgetMs) {
		throw new Error(`safe-matrix slow-test budget exceeded ${JSON.stringify({ ...diagnostic, slowestTestBudgetMs: budget.slowestTestBudgetMs })}`);
	}
	results.push(diagnostic);
}
const currentMs = Date.now() - startedAt;
const slowestStep = results.toSorted((a, b) => b.currentMs - a.currentMs)[0];
const summary = {
	currentMs, baselineMs: budgets.matrixBaselineMs, baselineDeltaMs: currentMs - budgets.matrixBaselineMs,
	budgetMs: budgets.matrixBudgetMs, budgetRemainingMs: budgets.matrixBudgetMs - currentMs,
	slowestStep, steps: results
};
console.log(`TUCODE_SAFE_MATRIX ${JSON.stringify(summary)}`);
if (currentMs > budgets.matrixBudgetMs) throw new Error(`safe-matrix wall-time budget exceeded ${JSON.stringify(summary)}`);
