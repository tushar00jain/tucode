import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pane } from '../../src/tui/workbench/pane.js';

class ProjectionPane extends Pane {
	readonly title = 'projection';
	readonly viewId = 'projection';
	readonly rowCount = 20;
	protected renderRow(index: number) { return [{ text: String(index) }]; }

	transaction<T>(work: () => Promise<T>, diagnosticEventId?: number): Promise<T> {
		return this.transactTreeProjection(work, diagnosticEventId);
	}
	invalidate(): void { this.invalidateTreeProjection(); }
	prepare(): void { this.didChangeRows(); this.layout(5, 20); }
	moveFocus(index: number): void { this.focusTo(index); }
	scrollTo(index: number): void { this.setScrollTop(index); }
	get viewportStart(): number { return this.firstVisibleRow; }
}

test('pane viewport start follows scrolling rather than the focused row', () => {
	const pane = new ProjectionPane({ getColorTheme: () => ({ getColor: () => undefined }) } as never);
	pane.prepare();
	pane.scrollTo(4);
	pane.moveFocus(8);

	assert.equal(pane.focus, 8);
	assert.equal(pane.viewportStart, 4,
		'a cursor inside the viewport must not discard the rows visible above it');
	pane.dispose();
});

test('tree projection transaction publishes one settled event for unchanged visible identities', async () => {
	const pane = new ProjectionPane({} as never);
	let events = 0;
	const listener = pane.onDidTreeProjectionChange(() => events++);
	let release!: () => void;
	const barrier = new Promise<void>(resolve => { release = resolve; });

	const update = pane.transaction(async () => {
		pane.invalidate();
		pane.invalidate();
		assert.equal(events, 0, 'an in-flight semantic update published an intermediate snapshot');
		await barrier;
		pane.invalidate();
	});
	assert.equal(events, 0);
	release();
	await update;
	assert.equal(events, 1, 'one semantic update did not publish exactly one settled projection');

	await pane.transaction(async () => undefined);
	assert.equal(events, 1, 'a clean transaction published a duplicate projection');
	listener.dispose(); pane.dispose();
});

test('nested tree projection transactions flush only after the outer owner settles', async () => {
	const pane = new ProjectionPane({} as never);
	let events = 0;
	pane.onDidTreeProjectionChange(() => events++);

	await pane.transaction(async () => {
		await pane.transaction(async () => pane.invalidate());
		assert.equal(events, 0);
		pane.invalidate();
	});
	assert.equal(events, 1);
	pane.dispose();
});

test('tree projection diagnostic correlation is observational and leaves no state behind', async () => {
	const pane = new ProjectionPane({} as never);
	const events: Array<number | undefined> = [];
	pane.onDidTreeProjectionChange(event => events.push(event.diagnosticEventId));

	await pane.transaction(async () => pane.invalidate(), 41);
	await pane.transaction(async () => pane.invalidate());
	assert.deepEqual(events, [41, undefined]);
	pane.dispose();
});
