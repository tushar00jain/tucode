// Quick open (Ctrl+P) against the file search.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXTENSIONLESS } from '../lib/fixture.mjs';
import { closeQuickOpen, quickOpen } from '../lib/probes.mjs';

const labels = result => result.picks.map(pick => pick.label);

export default function registerQuickOpenSuite(context) {
	describe('quick open', () => {
		it('finds an extensionless file', async () => {
			const result = await quickOpen(context.page, EXTENSIONLESS.name);
			await closeQuickOpen(context.page);
			assert.ok(labels(result).includes(EXTENSIONLESS.name), `${EXTENSIONLESS.name} is missing from ${JSON.stringify(labels(result))}`);
		});

		it('finds a file by a path-separator query', async () => {
			const forward = await quickOpen(context.page, EXTENSIONLESS.pathQuery);
			await closeQuickOpen(context.page);
			assert.ok(
				labels(forward).includes(EXTENSIONLESS.name),
				`${JSON.stringify(EXTENSIONLESS.pathQuery)} returned ${JSON.stringify(labels(forward))}`
			);

			const backward = await quickOpen(context.page, EXTENSIONLESS.backslashQuery);
			await closeQuickOpen(context.page);
			assert.ok(
				labels(backward).includes(EXTENSIONLESS.name),
				`${JSON.stringify(EXTENSIONLESS.backslashQuery)} returned ${JSON.stringify(labels(backward))}`
			);
		});
	});
}
