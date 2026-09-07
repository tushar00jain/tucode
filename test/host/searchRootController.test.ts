import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { TreeVisibility } from '../../src/vs/base/browser/ui/tree/tree.js';
import { getVisibleState, isFilterResult } from '../../src/vs/base/browser/ui/tree/indexTreeModel.js';
import { SearchRootController } from '../../src/vs/workbench/contrib/search/tauri/searchRootController.js';
import type { RenderableMatch } from '../../src/vs/workbench/contrib/search/browser/searchTreeModel/searchTreeCommon.js';

function fixture() {
	const files = ['alpha.txt', 'alpine.txt', 'other.txt'].map(name => {
		const matches: RenderableMatch[] = [];
		const file = { id: () => `FILE_MATCH_${name}`, name: () => name, resource: URI.file(`/workspace/nested/${name}`), matches: () => matches };
		matches.push({ id: () => `MATCH_${name}`, text: () => 'ordinary contents', parent: () => file } as unknown as RenderableMatch);
		return file as unknown as RenderableMatch;
	});
	let focus = files[2];
	let visible = [...files];
	let pending = Promise.resolve();
	let gate = Promise.resolve();
	let started: (() => void) | undefined;
	let focused = 0;
	const box = { isOpen: false, value: '', height: 0, open(value: string) { this.isOpen = true; this.value = value; }, close() { this.isOpen = false; return true; }, dispose() { this.isOpen = false; } };
	const refresh = async () => {
		started?.();
		await gate;
		visible = files.filter(row => {
			const result = root.filter.filter(row, TreeVisibility.Visible);
			return getVisibleState(isFilterResult(result) ? result.visibility : result) === TreeVisibility.Visible;
		});
	};
	const root = new SearchRootController(() => ({
		getFocus: () => focus ? [focus] : [], setFocus: rows => { focus = rows[0]; }, reveal() {}, domFocus() { focused++; },
		navigate: () => { let at = 0; return { next: () => visible[at++] ?? null }; },
		updateChildren: refresh
	}), { getUriLabel: (uri: URI) => uri.fsPath } as never, () => box, () => {}, work => { pending = pending.then(work); });
	return { root, box, files, refresh, settled: () => pending, focus: () => focus, visible: () => visible, focused: () => focused,
		change: (value: string) => { box.value = value; root.apply(value); },
		block: () => {
			let release!: () => void;
			gate = new Promise<void>(resolve => { release = resolve; });
			const entered = new Promise<void>(resolve => { started = resolve; });
			return { release, entered };
		} };
}

test('Search filter preserves typed completion candidates across streamed results', async () => {
	const f = fixture();
	try {
		f.root.open(); f.change('alp'); await f.settled();
		f.root.complete(1); await f.settled(); assert.equal(f.box.value, 'alpha.txt');
		f.root.invalidate();
		await f.refresh();
		assert.deepEqual(f.visible(), f.files.slice(0, 2), 'stream refresh must keep the typed filter, not the completed filename');
		f.root.complete(1); await f.settled(); assert.equal(f.box.value, 'alpine.txt');
		f.root.commit(); await f.settled(); assert.equal(f.box.isOpen, false); assert.equal(f.focus(), f.files[1]);
	} finally { f.root.dispose(); }
});

test('Search cancel and immediate reopen restore the original focus after a pending refresh', async () => {
	const f = fixture();
	try {
		f.root.open(); f.change('alp'); await f.settled(); assert.equal(f.focus(), f.files[0]);
		const gate = f.block();
		f.change('alpha'); await gate.entered;
		f.root.cancel(); f.root.open(); f.root.cancel();
		assert.equal(f.box.isOpen, false);
		gate.release(); await f.settled(); assert.equal(f.focus(), f.files[2]);
	} finally { f.root.dispose(); }
});

test('Search filter sees a matching line added to the same previously hidden file', async () => {
	const f = fixture();
	try {
		f.root.open(); f.change('unique line'); await f.settled(); assert.equal(f.visible().length, 0);
		const file = f.files[2] as any;
		file.matches().push({ id: () => 'MATCH_stream', text: () => 'a unique line arrived', parent: () => file });
		f.root.invalidate();
		const result = f.root.filter.filter(file, TreeVisibility.Visible);
		assert.equal(getVisibleState(isFilterResult(result) ? result.visibility : result), TreeVisibility.Visible);
		await f.refresh();
		assert.deepEqual(f.visible(), [file]);
		f.root.complete(1); await f.settled();
		assert.equal(f.box.value, 'unique line', 'matching source text does not make its filename a completion candidate');
	} finally { f.root.dispose(); }
});

test('Search path filtering and rapid Enter use the final typed query', async () => {
	const f = fixture();
	try {
		f.root.open(); f.change('nested/other'); f.root.commit(); await f.settled();
		assert.equal(f.box.isOpen, false);
		assert.equal(f.focus(), f.files[2]);
		assert.deepEqual(f.visible(), f.files);
	} finally { f.root.dispose(); }
});

test('Search filter disposal during a refresh cannot publish late focus', async () => {
	const f = fixture();
	f.root.open(); await f.settled();
	const before = f.focus();
	const focused = f.focused();
	const gate = f.block();
	f.change('other'); await gate.entered;
	f.root.dispose(); gate.release(); await f.settled();
	assert.equal(f.focus(), before);
	assert.equal(f.focused(), focused);
});
