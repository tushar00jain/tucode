import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { createFixture } from './lib/fixture.mjs';
import { drive, KEYS, paste, unexpectedStderr } from './lib/session.mjs';
import { activeTab, paneTextLines } from './lib/probes.mjs';
import { themeColour } from './lib/theme.mjs';
import { assertCleanLogs } from './lib/logs.mjs';

it('complete SearchView scrolls a large result set and settles rapid filter close/reopen', async () => {
	const fixture = createFixture({ sapling: false });
	try {
		const settings = join(fixture.root, '.vscode/settings.json');
		writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), 'search.collapseResults': 'alwaysExpand' }));
		writeFileSync(join(fixture.root, 'many-search.txt'), Array.from({ length: 1500 }, (_, index) => `bounded-search ${String(index).padStart(4, '0')}`).join('\n'));
		const run = await drive(fixture, { cols: 220, rows: 30 }, [
			{ name: 'search', keys: '2i' },
			{ name: 'results', keys: paste('bounded-search') },
			{ name: 'replacedQuery', keys: `${KEYS.ctrlU}${paste('missing-query')}${KEYS.ctrlU}${paste('bounded-search')}` },
			{ name: 'bottom', keys: `${KEYS.escape}${KEYS.end}` },
			{ name: 'top', keys: KEYS.home },
			{ name: 'filter', keys: '/' },
			{ name: 'narrow', keys: `1499${KEYS.escape}/1498${KEYS.enter}` },
			{ name: 'bottomAgain', keys: KEYS.end },
			{ name: 'openedMatch', keys: KEYS.enter },
			{ name: 'openedNextMatch', keys: `${KEYS.up}${KEYS.enter}` },
			{ name: 'terminal', keys: 't', child: true, prompt: true }
		]);
		assert.equal(run.exit.code, 0);
		assert.equal(unexpectedStderr(run.stderr).trim(), '');
		const lines = name => paneTextLines(run.frames[name]).join('\n');
		assert.match(lines('results'), /1500 results in 1 file/);
		assert.match(lines('replacedQuery'), /1500 results in 1 file/);
		assert.match(lines('bottom'), /bounded-search 1499/);
		assert.match(lines('top'), /many-search\.txt/);
		assert.match(lines('bottomAgain'), /bounded-search 1499/);
		assert.match(activeTab(run.frames.terminal, themeColour('tab.activeBackground'))?.name ?? '', /[\\/]/,
			'a delayed Search open stole activation from the terminal');
		assertCleanLogs(fixture.userData);
	} finally { fixture.dispose(); }
});
