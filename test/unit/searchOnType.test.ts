import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchOnTypeDelay } from '../../src/vs/workbench/contrib/search/common/searchOnType.js';

test('shared SearchWidget debounce preserves ordinary and broad-regex delays', () => {
	assert.equal(searchOnTypeDelay('needle', false, 300), 300);
	assert.equal(searchOnTypeDelay('needle', true, 300), 300);
	assert.equal(searchOnTypeDelay('\\w', true, 300), 1500);
	assert.equal(searchOnTypeDelay('', true, 300), 3000);
	assert.equal(searchOnTypeDelay('needle', false, 0), 0);
	assert.throws(() => searchOnTypeDelay('[', true, 300), SyntaxError);
});
