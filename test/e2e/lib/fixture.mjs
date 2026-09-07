// The directories the suites run against.
//
// Both are made under the temp root on every run and deleted afterwards, so the
// assertions depend on nothing that happens to be on the machine: the editor run
// gets a generated workspace, and the terminal run — which opens no workspace at
// all — gets the one thing a terminal takes from the disk, a directory to start in
// that is neither the user's home nor shared with another run.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Distinct needles, so no query can be answered by another test's content. */
export const NEEDLES = {
	longLine: 'ZEBRAFISH',
	polyglot: 'POLYGLOT',
	sibling: 'needle-sibling',
	bulk: 'STREAMNEEDLE',
	encoded: 'café needle-encoding'
};

/**
 * The same discipline for the terminal, where the needles are typed rather than
 * written to disk: one per terminal the suite starts, so a buffer reading can only
 * ever be that terminal's.
 */
export const TERMINAL_NEEDLES = {
	first: 'TERM-FIRST-NEEDLE',
	second: 'TERM-SECOND-NEEDLE',
	split: 'TERM-SPLIT-NEEDLE',
	killed: 'TERM-KILLED-NEEDLE',
	shellIntegration: 'TERM-INTEGRATION-NEEDLE',
	find: 'TERM-FIND-NEEDLE',
	clipboard: 'TERM-CLIPBOARD-NEEDLE',
	// Put on the machine's clipboard and never typed, so a prompt holding it can only have been
	// pasted there.
	paste: 'TERM-PASTED-NEEDLE',
	scroll: 'TERM-SCROLL-NEEDLE',
	// Typed at the prompt and never run, so it is only ever the line `Ctrl+C` interrupts.
	interrupt: 'TERM-INTERRUPTED',
	// Typed into the find box and nowhere else, so "no results" is a fact about the
	// buffer rather than about a search that never ran.
	findAbsent: 'TERM-UNTYPED-NEEDLE'
};

/**
 * The terminal profile that run configures, named so no profile the machine happens to
 * have can answer for it.
 *
 * Its path is written the way stock writes its own Windows defaults — as an environment
 * variable rather than a path — because that is the part of a profile the workbench has to
 * resolve before detection can look for an executable behind it. `COMSPEC` and `SHELL` are
 * the two that name a shell on their platform.
 */
export const TERMINAL_PROFILE = {
	name: 'TERM-VARIABLE-PATH-PROFILE',
	path: process.platform === 'win32' ? '${env:COMSPEC}' : '${env:SHELL}'
};

/**
 * The one long line, described by construction so the expected line and column
 * are known rather than read back out of the app.
 */
const LONG_LINE_HEAD = 'HEAD-MARKER';
const LONG_LINE_LEAD = 'x'.repeat(610);
const LONG_LINE_TAIL = 'y'.repeat(600);

export const LONG_LINE = {
	file: 'longline.ts',
	folderSegments: ['alpha', 'src'],
	line: 3,
	column: LONG_LINE_HEAD.length + LONG_LINE_LEAD.length + 1,
	head: LONG_LINE_HEAD,
	length: LONG_LINE_HEAD.length + LONG_LINE_LEAD.length + NEEDLES.longLine.length + LONG_LINE_TAIL.length
};

/** The files carrying `NEEDLES.polyglot`, one per extension. */
export const POLYGLOT_FILES = ['app.ts', 'main.rs', 'deeply.md'];

/** `siblings/pair.js` is the one `files.exclude`'s `when` clause must hide. */
export const SIBLING_FILES = { folder: 'siblings', visible: ['pair.ts', 'lone.js'], hidden: ['pair.js'] };

/** Extensionless file, and the path-separator query that must find it. */
export const EXTENSIONLESS = { name: 'LICENSE', pathQuery: 'alpha/LICENSE', backslashQuery: 'alpha\\LICENSE' };

export const REPOSITORIES = ['alpha', 'beta', 'delta', 'gamma'];

/**
 * The repositories the Sapling view must discover, and what each is for.
 *
 * **They are git repositories that `sl` has been run in, not `sl init` repositories.**
 * That is Sapling's "dotgit" mode — the metadata lives at `.git/sl` rather than `.sl`,
 * git owns the writes and `sl` reads the same history — and it is a first-class Sapling
 * checkout, which is why discovery looks for both markers. It also lets `alpha` be a
 * Sapling repository without being a second one on disk, so the picker has two entries
 * and the git suites' fixture is untouched.
 *
 * `delta` is the graph: a fork and the merge that closes it, so the swimlanes have
 * something to draw, plus the bookmarks the rows render.
 */
export const SAPLING = {
	repositories: ['alpha', 'delta'],
	/** `delta`'s smartlog, descendants first — the order `sl log` prints and the view draws. */
	commits: ['delta merge', 'delta side', 'delta main', 'delta base'],
	/** The commit `.` points at, which the view marks "You are here". */
	dot: 'delta main',
	/** Git branches, which `sl` reports as bookmarks. */
	bookmarks: ['delta-merged', 'delta-side'],
	/**
	 * A commit that changed more files than the commit-info view can show at once, and more than
	 * `MAX_FETCHED_FILES_PER_COMMIT` — so its file list both overflows the pane and can only have
	 * been drawn from the second `sl` read.
	 */
	wideCommit: { title: 'delta side', files: 40 },
	/** `alpha`'s whole smartlog, which is what picking it must replace the graph with. */
	alphaCommits: ['alpha base']
};

/** The only file not written as UTF-8. */
export const ENCODED_FILE = 'encoding.txt';

/**
 * A markdown document taller than any window the run opens, carrying a marker on its last line.
 * That marker is what makes "the preview scrolled" assertable as content arriving on screen,
 * rather than as a number read back out of the scrollbar it is supposed to be testing.
 */
export const LONG_DOCUMENT = { file: 'long.md', tail: 'SCROLL-TAIL-MARKER', sections: 120 };

/**
 * A document carrying the constructs the preview styles rather than merely renders: a table, a
 * rule, and a fenced code block. `cell` is the one table cell the padding is measured on.
 */
export const STYLED_DOCUMENT = { file: 'styled.md', cell: 'cell-under-test' };

/** Top-level entries the explorer must list. */
export const TOP_LEVEL = ['alpha', 'beta', 'bulk', 'delta', 'gamma', 'siblings', 'README.md', LONG_DOCUMENT.file, STYLED_DOCUMENT.file, ENCODED_FILE];

// Breadth for the streaming test. What makes streaming observable is a walk long
// enough to span several batches with a result set small enough that the renderer
// is never too busy to redraw the count — so the needle is sparse across many
// files rather than dense across few.
const BULK_FILES = 30_000;
const BULK_FILES_PER_DIR = 100;
const BULK_LINES_PER_FILE = 20;
const BULK_NEEDLE_EVERY = 300;
export const BULK_RESULT_COUNT = BULK_FILES / BULK_NEEDLE_EVERY;

const SETTINGS = {
	// A sibling `when` clause: hide a `.js` file when its `.ts` counterpart exists.
	'files.exclude': { '**/*.js': { when: '$(basename).ts' } },
	// The encoding `encoding.txt` is written in.
	'files.encoding': 'windows1252',
	'search.followSymlinks': false,
	'git.autofetch': false,
	'telemetry.telemetryLevel': 'off'
};

function write(root, relative, contents) {
	const path = join(root, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

function git(cwd, args, { allowFailure = false } = {}) {
	const result = spawnSync('git', [
		'-c', 'user.name=tscode e2e',
		'-c', 'user.email=e2e@example.invalid',
		'-c', 'core.autocrlf=false',
		'-c', 'commit.gpgsign=false',
		'-c', 'init.defaultBranch=main',
		...args
	], { cwd, encoding: 'utf8' });
	if (result.status !== 0 && !allowFailure) {
		throw new Error(`git ${args.join(' ')} in ${cwd} failed (${result.status}):\n${result.stderr || result.stdout}`);
	}
	return result;
}

const commit = (cwd, message) => git(cwd, ['commit', '--no-verify', '-m', message]);

/**
 * Runs `sl` in a git repository, which is what makes it a Sapling repository: the first
 * command builds `.git/sl`, the marker discovery walks for. `root --dotdir` is the
 * cheapest one that does it, and it is also the answer `SlRepository::open` caches.
 */
function sl(cwd, args) {
	const result = spawnSync('sl', args, { cwd, encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		throw new Error(`sl ${args.join(' ')} in ${cwd} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
	}
	return result;
}

/** Staged, unstaged and untracked changes in one repository. */
function buildAlpha(root) {
	const repo = join(root, 'alpha');
	write(root, 'alpha/LICENSE', 'Permission is hereby granted, free of charge, to any person.\n');
	write(root, 'alpha/src/app.ts', [
		'/** The syntax-highlighting sample. */',
		"import { readFile } from 'node:fs/promises';",
		'',
		"export const KIND = 'POLYGLOT';",
		'',
		'export async function load(path: string): Promise<number> {',
		'\tconst text = await readFile(path, "utf8");',
		'\treturn text.length > 0 ? text.length : -1;',
		'}',
		''
	].join('\n'));
	write(root, 'alpha/src/longline.ts', [
		'// One very long line, so the search preview has to elide.',
		'const before = 1;',
		LONG_LINE_HEAD + LONG_LINE_LEAD + NEEDLES.longLine + LONG_LINE_TAIL,
		'const after = 2;',
		''
	].join('\n'));
	write(root, 'alpha/src/nested/deep/deeply.md', `# deeply nested\n\n${NEEDLES.polyglot} in markdown\n`);
	write(root, 'alpha/staged.txt', 'committed contents\n');
	write(root, 'alpha/tracked.txt', 'committed contents\n');

	git(repo, ['init']);
	git(repo, ['add', '.']);
	commit(repo, 'alpha base');

	write(root, 'alpha/staged.txt', 'staged contents\n');
	git(repo, ['add', 'staged.txt']);
	write(root, 'alpha/tracked.txt', 'working-tree contents\n');
	write(root, 'alpha/untracked.txt', 'never added\n');

	// The second Sapling repository, so the picker has something to pick between. It costs
	// the git suites nothing: everything `sl` writes is inside `.git`, which git ignores.
	sl(repo, ['root', '--dotdir']);
}

/**
 * The Sapling graph: a fork off the base and the merge that closes it, so the smartlog has
 * two swimlanes and a row with two parents, plus a bookmark on each side.
 *
 * `main` stays checked out, so `.` is `delta main` — a commit that is neither the tip of
 * the smartlog nor its root, which is what makes "You are here" an assertion about the
 * right row rather than about the first one.
 */
function buildDelta(root) {
	const repo = join(root, 'delta');
	write(root, 'delta/base.txt', 'base\n');

	git(repo, ['init']);
	git(repo, ['add', '.']);
	commit(repo, 'delta base');

	write(root, 'delta/main.txt', 'main\n');
	git(repo, ['add', '.']);
	commit(repo, 'delta main');

	git(repo, ['checkout', '-b', 'delta-side', 'main~1']);
	write(root, 'delta/side.txt', 'side\n');
	// The rest of `SAPLING.wideCommit.files` — enough that the commit-info view's file list is
	// taller than the pane, which is the only way to assert that the pane scrolls it. It also
	// puts the count past `MAX_FETCHED_FILES_PER_COMMIT`, so the list on screen can only have
	// come from the second read rather than from the smartlog's sample.
	for (let i = 1; i < SAPLING.wideCommit.files; i++) {
		write(root, `delta/side/file${i}.txt`, `side ${i}\n`);
	}
	git(repo, ['add', '.']);
	commit(repo, 'delta side');

	git(repo, ['checkout', '-b', 'delta-merged', 'main']);
	git(repo, ['merge', '--no-ff', '-m', 'delta merge', 'delta-side']);
	git(repo, ['checkout', 'main']);

	write(root, 'delta/notes.md', 'not added yet\n');
	sl(repo, ['root', '--dotdir']);
}

/** A conflicted merge, so the Merge Changes group has something in it. */
function buildBeta(root) {
	const repo = join(root, 'beta');
	write(root, 'beta/main.rs', `// ${NEEDLES.polyglot} in rust\nfn main() {}\n`);
	write(root, 'beta/conflict.txt', 'base\n');

	git(repo, ['init']);
	git(repo, ['add', '.']);
	commit(repo, 'beta base');

	git(repo, ['checkout', '-b', 'other']);
	write(root, 'beta/conflict.txt', 'other side\n');
	git(repo, ['commit', '--no-verify', '-am', 'other side']);

	git(repo, ['checkout', 'main']);
	write(root, 'beta/conflict.txt', 'main side\n');
	git(repo, ['commit', '--no-verify', '-am', 'main side']);

	git(repo, ['merge', 'other'], { allowFailure: true });
}

/** One untracked file and nothing else. */
function buildGamma(root) {
	const repo = join(root, 'gamma');
	write(root, 'gamma/gamma.ts', 'export const gamma = true;\n');
	git(repo, ['init']);
	git(repo, ['add', '.']);
	commit(repo, 'gamma base');
	write(root, 'gamma/notes.md', 'not added yet\n');
}

/**
 * Headings and paragraphs rather than one long line: the preview wraps, so height has to come
 * from block count, and none of the search needles appear in it.
 */
function writeLongDocument(root) {
	const lines = ['# long document', ''];
	for (let section = 0; section < LONG_DOCUMENT.sections; section++) {
		lines.push(`## section ${section}`, '', `Paragraph ${section} of the long document, written to occupy a line of its own once rendered.`, '');
	}
	lines.push(LONG_DOCUMENT.tail, '');
	write(root, LONG_DOCUMENT.file, `${lines.join('\n')}\n`);
}

/** The table, rule and fenced code block the preview's stylesheet is asserted against. */
function writeStyledDocument(root) {
	write(root, STYLED_DOCUMENT.file, [
		'# styled document',
		'',
		'| column | other |',
		'| --- | --- |',
		`| ${STYLED_DOCUMENT.cell} | second |`,
		'',
		'---',
		'',
		'```js',
		'const answer = 42;',
		'```',
		''
	].join('\n'));
}

function buildBulk(root) {
	const lines = [];
	for (let index = 0; index < BULK_FILES; index++) {
		const needleAt = index % BULK_NEEDLE_EVERY === 0 ? BULK_LINES_PER_FILE / 2 : -1;
		lines.length = 0;
		for (let line = 0; line < BULK_LINES_PER_FILE; line++) {
			lines.push(line === needleAt
				? `${NEEDLES.bulk} in file ${index}`
				: `filler line ${line} of file ${index}, padded so the corpus is large enough to scan`);
		}
		const directory = String(Math.floor(index / BULK_FILES_PER_DIR)).padStart(4, '0');
		write(root, `bulk/dir-${directory}/bulk-${String(index).padStart(5, '0')}.txt`, `${lines.join('\n')}\n`);
	}
}

/**
 * A directory of its own under the temp root, removed with the run.
 * `TSCODE_E2E_TMPDIR` moves it off the default temp drive.
 *
 * @returns {{ root: string, dispose: () => void }}
 */
function createDirectory(name, { parent = process.env.TSCODE_E2E_TMPDIR ?? tmpdir() } = {}) {
	const base = mkdtempSync(join(parent, 'tscode-e2e-'));
	const root = join(base, name);
	mkdirSync(root, { recursive: true });
	return {
		root,
		dispose() {
			try {
				rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				console.error(`could not remove the fixture at ${base}: ${error.message}`);
			}
		}
	};
}

/** The directory the terminal run's shells start in. The caller owns `dispose()`. */
export function createTerminalFixture(options) {
	return createDirectory('cwd', options);
}

/**
 * What the source control watcher run asserts against, and the two numbers that make it
 * discriminating.
 *
 * `churnIntervalMs` is **below** the batching window `CoalescingRefresh` holds a burst of watcher
 * events over, which is what a writer inside a live repository looks like — a dev server, a build
 * watcher, `sl` under `.git/sl`. It is deliberately not much smaller: measured on this app, writes
 * every 20 ms saturate the file service into bursts far enough apart that a *restarting* window
 * still gets to fire between them, so a faster churn is a weaker test, not a stronger one. At
 * 200 ms each write arrives as its own event and a restarting window never closes.
 *
 * The directory is inside `.git`, so git status never reports the churn file and the working set
 * under test is only ever what the run put there.
 */
export const SCM_WATCHER = {
	/** Modified, added and deleted — the three shapes a stale view goes on showing. */
	working: ['added.txt', 'modified.txt', 'removed.txt'],
	churnDirectory: 'e2e-churn',
	churnIntervalMs: 200
};

/**
 * One git repository, at the workspace root, with a working set of all three shapes. The caller
 * owns `dispose()`.
 *
 * A repository *at* the root rather than under it, because that is what leaves the source control
 * view showing one repository — and a single repository draws no repository rows, so its whole
 * working set is on screen at once and a reading of it needs no scroll sweep.
 */
export function createScmWatcherFixture(options) {
	const fixture = createDirectory('repository', options);
	const { root } = fixture;

	write(root, 'modified.txt', 'committed contents\n');
	write(root, 'removed.txt', 'committed contents\n');
	git(root, ['init']);
	git(root, ['add', '.']);
	commit(root, 'scm watcher base');

	write(root, 'modified.txt', 'working-tree contents\n');
	write(root, 'added.txt', 'never added\n');
	rmSync(join(root, 'removed.txt'));

	mkdirSync(join(root, '.git', SCM_WATCHER.churnDirectory), { recursive: true });

	return fixture;
}

/**
 * Commits the whole working tree, as a shell outside the app would — the same identity and
 * options every other commit in a fixture is made with, so a machine with no `user.email`
 * configured fails here the same way it would anywhere else.
 */
export function commitAll(root, message) {
	git(root, ['add', '-A']);
	commit(root, message);
}

/**
 * Creates the workspace. The caller owns `dispose()`.
 *
 * @returns {{ root: string, dispose: () => void }}
 */
export function createFixture(options) {
	const fixture = createDirectory('workspace', options);
	const { root } = fixture;

	write(root, 'README.md', 'Generated workspace for the tscode end-to-end suite.\n');
	writeLongDocument(root);
	writeStyledDocument(root);
	write(root, '.vscode/settings.json', `${JSON.stringify(SETTINGS, undefined, '\t')}\n`);

	write(root, `${SIBLING_FILES.folder}/pair.ts`, `export const kind = '${NEEDLES.sibling} in a ts file';\n`);
	write(root, `${SIBLING_FILES.folder}/pair.js`, `exports.kind = '${NEEDLES.sibling} in a js file beside a ts file';\n`);
	write(root, `${SIBLING_FILES.folder}/lone.js`, `exports.kind = '${NEEDLES.sibling} in a js file with no ts sibling';\n`);

	// Written in windows-1252, where "é" is the single byte 0xE9 — read as UTF-8
	// the needle would not match at all.
	writeFileSync(join(root, 'encoding.txt'), Buffer.from(`${NEEDLES.encoded}\n`, 'latin1'));

	buildAlpha(root);
	buildBeta(root);
	buildDelta(root);
	buildGamma(root);
	buildBulk(root);

	return fixture;
}
