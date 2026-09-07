// Text search: locations, supersession, filters, sibling excludes, encoding,
// and progressive delivery.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BULK_RESULT_COUNT, ENCODED_FILE, LONG_LINE, NEEDLES, POLYGLOT_FILES, SIBLING_FILES } from '../lib/fixture.mjs';
import { openFirstMatch, streamingTextSearch, textSearch } from '../lib/probes.mjs';

const fileNames = result => result.files.map(file => file.name).sort();

export default function registerSearchSuite(context) {
	describe('text search', () => {
		it('reports the file, line and column of a known string', async () => {
			const result = await textSearch(context.page, NEEDLES.longLine);
			assert.equal(result.resultCount, 1, `unexpected result count: ${result.message}`);
			assert.equal(result.fileCount, 1, `unexpected file count: ${result.message}`);
			assert.deepEqual(fileNames(result), [LONG_LINE.file]);

			const [file] = result.files;
			for (const segment of LONG_LINE.folderSegments) {
				assert.ok(file.folder.includes(segment), `folder ${JSON.stringify(file.folder)} is missing ${segment}`);
			}
			assert.equal(file.matches.length, 1);
			assert.equal(file.matches[0].column, LONG_LINE.column, 'the match is reported at the wrong column');

			const position = await openFirstMatch(context.page);
			assert.equal(position.tab, LONG_LINE.file);
			assert.equal(position.line, LONG_LINE.line);
			assert.equal(position.startColumn, LONG_LINE.column);
		});

		it('elides the preview of a long line', async () => {
			const result = await textSearch(context.page, NEEDLES.longLine);
			const preview = result.files[0].matches[0].rowText;
			assert.ok(LONG_LINE.length > 1000, 'the fixture line is not long enough to force elision');
			assert.ok(preview.length < 400, `the preview was not elided (${preview.length} chars of ${LONG_LINE.length})`);
			assert.ok(!preview.includes(LONG_LINE.head), 'the preview starts at the beginning of the line rather than near the match');
			assert.ok(preview.includes(NEEDLES.longLine), 'the preview does not contain the match');
		});

		it('replaces the previous result set on a second query', async () => {
			const first = await textSearch(context.page, NEEDLES.longLine);
			assert.deepEqual(fileNames(first), [LONG_LINE.file]);

			const second = await textSearch(context.page, NEEDLES.polyglot);
			assert.deepEqual(fileNames(second), [...POLYGLOT_FILES].sort(), `second query mixed in earlier results: ${second.message}`);
			assert.ok(!fileNames(second).includes(LONG_LINE.file), 'the first query\'s file survived the second query');
		});

		it('filters by include and exclude patterns', async () => {
			const all = await textSearch(context.page, NEEDLES.polyglot);
			assert.equal(all.fileCount, POLYGLOT_FILES.length, `unfiltered: ${all.message}`);

			const included = await textSearch(context.page, NEEDLES.polyglot, { include: '**/*.ts' });
			assert.deepEqual(fileNames(included), ['app.ts'], `include **/*.ts: ${included.message}`);

			const excluded = await textSearch(context.page, NEEDLES.polyglot, { exclude: '**/*.ts' });
			assert.deepEqual(fileNames(excluded), ['deeply.md', 'main.rs'], `exclude **/*.ts: ${excluded.message}`);
		});

		it('honours a sibling when clause in files.exclude', async () => {
			const result = await textSearch(context.page, NEEDLES.sibling);
			assert.deepEqual(fileNames(result), [...SIBLING_FILES.visible].sort(), `sibling excludes: ${result.message}`);
			for (const hidden of SIBLING_FILES.hidden) {
				assert.ok(!fileNames(result).includes(hidden), `${hidden} should be hidden by its .ts sibling`);
			}
		});

		it('reads a file in a non-UTF-8 encoding', async () => {
			const result = await textSearch(context.page, NEEDLES.encoded);
			assert.deepEqual(fileNames(result), [ENCODED_FILE], `windows-1252 content: ${result.message}`);
		});

		it('delivers results progressively rather than only at the end', async () => {
			const result = await streamingTextSearch(context.page, NEEDLES.bulk);
			assert.equal(result.resultCount, BULK_RESULT_COUNT, `unexpected total: ${result.message}`);
			// Either reading proves the view held results before the search ended:
			// a count below the total, or any count at all while it was still running.
			const partial = result.samples.some(sample => sample.count > 0 && sample.count < result.resultCount);
			const duringRun = result.samples.some(sample => sample.count > 0 && sample.running);
			assert.ok(
				partial || duringRun,
				`no results were visible before the search finished; ${result.sampleCount} readings, distinct: ${JSON.stringify(result.samples)}`
			);
		});
	});
}
