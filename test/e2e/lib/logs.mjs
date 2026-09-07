import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function assertCleanLogs(userData) {
	const logs = readdirSync(userData, { recursive: true }).filter(path => String(path).endsWith('.log'))
		.map(path => readFileSync(join(userData, String(path)), 'utf8')).join('\n');
	assert.doesNotMatch(logs, /TypeError|ReferenceError|UNKNOWN service|Got bad scroll event/);
}
