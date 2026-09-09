import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMarkdownUri } from '../../src/vs/base/common/markdownUri.js';
import { URI } from '../../src/vs/base/common/uri.js';

test('Markdown resolves encoded image paths once, including nested paths and URL components', () => {
	const base = URI.file('/workspace/docs/readme.md');
	for (const [href, expected] of [
		['images/my%20plot.png', 'file:///workspace/docs/images/my%20plot.png'],
		['../logo%20%23%20%25%20caf%C3%A9.png', 'file:///workspace/logo%20%23%20%25%20caf%C3%A9.png'],
		['plot%2520.png', 'file:///workspace/docs/plot%2520.png'],
		['plot.svg?v=2#figure', 'file:///workspace/docs/plot.svg?v%3D2#figure'],
		['#heading', 'file:///workspace/docs/readme.md#heading'],
		['/absolute/plot.png', 'file:///absolute/plot.png'],
		['https://example.com/a%20b.png', 'https://example.com/a%20b.png'],
		['//example.com/plot.png', 'https://example.com/plot.png'],
	]) {
		assert.equal(resolveMarkdownUri(base, href), expected);
	}
	assert.equal(resolveMarkdownUri(URI.file('/workspace/docs/'), 'plot.png'), 'file:///workspace/docs/plot.png');
});
