import assert from 'node:assert/strict';
import { test } from 'node:test';
import xtermHeadless from '@xterm/headless';
import { SearchAddon } from '@xterm/addon-search';
import { HeadlessSearchTerminalAdapter } from '../../src/terminal/headlessSearchTerminal.js';

const decorations = {
	matchBackground: '#000000', matchBorder: 'transparent', matchOverviewRuler: 'transparent',
	activeMatchBackground: '#000000', activeMatchBorder: 'transparent', activeMatchColorOverviewRuler: 'transparent'
};

test('the real SearchAddon counts, decorates and steps over the real headless buffer', async () => {
	const terminal = new xtermHeadless.Terminal({ cols: 80, rows: 10 });
	const adapter = new HeadlessSearchTerminalAdapter(terminal);
	const addon = new SearchAddon({ highlightLimit: 20000 });
	addon.activate(adapter.forSearchAddon());
	try {
		await new Promise<void>(resolve => terminal.write('first needle\r\nsecond needle\r\n', resolve));
		let result = { resultIndex: -1, resultCount: 0 };
		const listener = addon.onDidChangeResults(value => result = value);
		assert.equal(addon.findPrevious('needle', { incremental: true, decorations }), true);
		assert.equal(result.resultCount, 2);
		assert.equal(result.resultIndex, 1);
		assert.ok(adapter.decorations().length >= 2);
		assert.equal(adapter.decorations().filter(item => item.active).length, 1);

		assert.equal(addon.findNext('needle', { decorations }), true);
		assert.equal(result.resultIndex, 0);
		assert.equal(addon.findPrevious('needle', { decorations }), true);
		assert.equal(result.resultIndex, 1);

		assert.equal(addon.findPrevious('absent', { incremental: true, decorations }), false);
		assert.deepEqual(result, { resultIndex: -1, resultCount: 0 });
		assert.equal(adapter.decorations().length, 0);
		addon.clearDecorations();
		assert.equal(adapter.getSelectionPosition(), undefined);
		listener.dispose();
	} finally {
		addon.dispose();
		terminal.dispose();
	}
});
