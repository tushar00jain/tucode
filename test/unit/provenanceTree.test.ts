import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';

// @ts-ignore — the provenance tools are plain Node modules.
import { workingTree, gitTree } from '../../docs/provenance/tree.mjs';

it('keeps ignored local files and symlinks out of the provenance inventory', () => {
	const root = mkdtempSync(join(tmpdir(), 'tucode-provenance-'));
	const put = (rel: string, body = 'fixture\n') => {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), body);
	};
	try {
		execFileSync('git', ['init', '-q', root]);
		put('.gitignore', '.env*\nmac/.swiftpm/\n*.local\n');
		put('tracked.ts');
		put('deleted.ts');
		execFileSync('git', ['-C', root, 'add', '.gitignore', 'tracked.ts', 'deleted.ts']);
		const snapshot = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf8' }).trim();
		assert.equal(gitTree(root, snapshot).read('tracked.ts'), 'fixture\n');
		assert.deepEqual(gitTree(root, snapshot).readBytes('tracked.ts'), Buffer.from('fixture\n'));
		rmSync(join(root, 'deleted.ts'));
		put('new source.ts');
		put('.env');
		put('settings.local');
		put('mac/.swiftpm/xcode/xcuserdata/fixture.xcuserdatad/state');
		put('nested/gen/output.ts');
		symlinkSync('.env', join(root, 'linked-secret'));

		assert.deepEqual(workingTree(root).list(), ['.gitignore', 'new source.ts', 'tracked.ts']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
