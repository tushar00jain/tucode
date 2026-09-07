import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const audit = JSON.parse(readFileSync(resolve(root, 'test/coverage/workbench-layer-audit.json')));
const historical = [
	'src/workbench/commands.ts',
	'src/workbench/input.ts',
	'src/workbench/keyboard.ts',
	'src/workbench/listNavigation.ts',
	'src/workbench/paneContainers.ts'
];

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : [path];
	});
}

test('accounts for removed shims and the deliberate neutral projection protocols', () => {
	assert.deepEqual(audit.modules.map(module => module.source).sort(), historical);
	assert.ok(audit.modules.filter(module => module.source !== 'src/workbench/paneContainers.ts').every(module => module.status === 'removed'));
	assert.equal(audit.modules.find(module => module.source === 'src/workbench/paneContainers.ts').status, 'neutral-shared');
	assert.ok(audit.modules.every(module => module.consumers.length > 0));
	assert.equal(existsSync(resolve(root, 'src/workbench/paneContainers.ts')), true);
});

test('prevents compatibility imports and parallel list navigation from returning', () => {
	for (const file of sourceFiles(resolve(root, 'src')).filter(file => file.endsWith('.ts'))) {
		const source = readFileSync(file, 'utf8');
		assert.doesNotMatch(source, /(?:workbench\/input\.js|workbench\/listNavigation\.js)/, file);
		assert.doesNotMatch(source, /\blistFocusAfterKey\b/, file);
	}
});

test('records exact remaining shared policy and unavailable service evidence', () => {
	assert.match(audit.serviceSearch.result, /registry-backed neutral controller/);
	assert.deepEqual(audit.frontendAdapterDeltas, []);
	assert.deepEqual(audit.minimalSharedPolicy.map(entry => entry.policy), [
		'tucode command registration and command-hint metadata'
	]);
});
