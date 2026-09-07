import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { trackFocus } from '../../src/vs/base/browser/dom.js';

test('upstream FocusTracker follows terminal child focus, sidebar blur and reentry', async () => {
	const container = document.createElement('div');
	const first = container.appendChild(document.createElement('div'));
	const second = container.appendChild(document.createElement('div'));
	const sidebar = document.createElement('div');
	const tracker = trackFocus(container);
	const events: string[] = [];
	tracker.onDidFocus(() => events.push('focus'));
	tracker.onDidBlur(() => events.push('blur'));
	try {
		first.focus(); second.focus();
		await new Promise(resolve => setTimeout(resolve, 5));
		assert.deepEqual(events, ['focus'], 'switching children must retain parent focus');
		sidebar.focus();
		await new Promise(resolve => setTimeout(resolve, 5));
		assert.deepEqual(events, ['focus', 'blur']);
		second.focus();
		assert.deepEqual(events, ['focus', 'blur', 'focus']);
	} finally { tracker.dispose(); second.blur(); }
});
