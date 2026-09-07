// The workspace the suites run against.
//
// Ported from the suite T01 deleted (`git show vendor:test/e2e/lib/fixture.mjs`) — only the DOM
// driver was specific to the app that is gone; a fixture is the same problem here. The four
// repositories, the sibling `when` clause and the long line are that file's, with what this
// frontend has no counterpart for removed: the markdown documents, the large streaming corpus,
// and the terminal run's plain directory.
//
// It is made under .build/test-fixtures on every run and deleted afterwards, so **no assertion depends on
// the working tree the suite runs in** — a fixture that is the checkout breaks every time somebody
// edits a file, which is the failure mode this exists to design out.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { setiIcon, themeColour } from './theme.mjs';
import { LONG_LINE_HEAD, LONG_LINE_LEAD, LONG_LINE_TAIL, TOKEN_COLOR_FILE_CONTENT, longLineFileContent } from './editorFixture.mjs';
import { runFixtureGit as git, writeFixtureFile as write } from './fixtureResources.mjs';

/** Distinct needles, so no query can be answered by another test's content. */
/**
 * What the replace steps write over `NEEDLES.sibling` with. The file it lands in is
 * `siblings/lone.js`, which is in no repository — so what a replace writes to disk moves no
 * decoration, no source-control group and no explorer row anywhere else in the run.
 */
export const REPLACEMENT = 'needle-replaced';

/**
 * The file the replace steps write to, and the part of its one line that must survive: a text edit
 * over the match, not a rewrite of the file from what the preview drew.
 */
export const REPLACED_FILE = { name: 'lone.js', path: join('siblings', 'lone.js'), tail: 'in a js file with no ts sibling' };

export const NEEDLES = {
	longLine: 'ZEBRAFISH',
	polyglot: 'POLYGLOT',
	sibling: 'needle-sibling',
	encoded: 'café needle-encoding'
};

/**
 * The one long line, described by construction so the elision is known rather than read back out of
 * the app.
 *
 * **The text before the match has word boundaries in it on purpose.** `MatchImpl.preview()` elides it
 * with `lcut(fullBefore, 26, '…')`, and `lcut` cuts at a `\b` — so a run of one repeated character
 * has nowhere to cut and comes back whole, with the match hundreds of columns off the right of any
 * pane. That is upstream's behaviour and not worth asserting; the elision is.
 */
export const LONG_LINE = {
	file: 'longline.ts',
	folder: join('alpha', 'src'),
	head: LONG_LINE_HEAD,
	length: LONG_LINE_HEAD.length + LONG_LINE_LEAD.length + NEEDLES.longLine.length + LONG_LINE_TAIL.length
};

/**
 * What the steps that open a search result search for, and the glob that narrows it to one file.
 *
 * `longline.ts` is the only file here carrying **two** matches of one word — the two lines below,
 * which it is written from — and two is what a single match cannot show: which of a file's matches a
 * file row opens at, and whether opening the same file twice is one tab or two.
 */
export const OPEN_MATCHES = {
	needle: 'const',
	glob: `**/${LONG_LINE.file}`,
	first: 'const before = 1;',
	second: 'const after = 2;'
};

/** The files carrying `NEEDLES.polyglot`, one per extension, and the folder each is in. */
export const POLYGLOT_FILES = [
	{ name: 'app.ts', folder: join('alpha', 'src') },
	{ name: 'deeply.md', folder: join('alpha', 'src', 'nested', 'deep') },
	{ name: 'main.rs', folder: 'beta' }
];

/**
 * The glob the include and exclude boxes are driven with. One extension per polyglot file is what
 * makes it discriminating in both directions: as an include it leaves exactly one of the three, and
 * as an exclude it leaves exactly the other two.
 */
export const TS_GLOB = '**/*.ts';
export const TS_POLYGLOT = POLYGLOT_FILES.filter(file => file.name.endsWith('.ts'));
export const OTHER_POLYGLOT = POLYGLOT_FILES.filter(file => !file.name.endsWith('.ts'));

/** `siblings/pair.js` is the one the `files.exclude` `when` clause must hide, in both panes. */
export const SIBLING_FILES = { folder: 'siblings', visible: ['lone.js', 'pair.ts'], hidden: ['pair.js'] };

/**
 * What vim mode types into `siblings/pair.js`, and then writes. Distinctive so that a frame and a
 * file can both be searched for it, and punctuation so that it also says the keys reached the
 * buffer rather than the keybinding resolver.
 */
export const VIM_MARK = '// edited-by-vim';

/** The only file not written as UTF-8. */
export const ENCODED_FILE = 'encoding.txt';

/**
 * The workspace's own README, which is the first file the editor area is asked to open — and, since
 * the markdown preview, the document that pane is driven over.
 *
 * **`line` stays the first line**, because three other suites find the open editor by it and vim's
 * `A` appends to it. Everything after it is the preview's input, and every construct in it is one
 * the pane has to substitute for or lay out: `PREVIEW` names the pieces the suite asserts on so no
 * assertion re-types the document.
 */
export const README = { name: 'README.md', line: 'Generated workspace for the tucode end-to-end suite.' };

/**
 * What the markdown preview is asserted against, and the source that produces it.
 *
 * Each field is a *substitution* the pane makes for something a cell grid has no form for, or a
 * layout it computes: the heading rule stands in for `font-size`, the bullet for `list-style`, the
 * gutter for `border-left`, the box for `border-collapse`, and the column widths are computed from
 * the cells rather than declared anywhere.
 */
export const PREVIEW = {
	heading: 'Preview fixture',
	bold: 'bold',
	struck: 'struck',
	link: 'a link',
	codespan: 'inline code',
	bullets: ['first bullet', 'second bullet'],
	quote: 'A quoted line.',
	/** The widest cell of each column, which is what the auto layout has to answer with. */
	table: { columns: ['Language', 'Extension'], widest: ['TypeScript', 'Extension'] },
	fence: { language: 'ts', keyword: 'const', line: 'const answer: number = 42;' },
	image: 'a picture',
	html: '<span>raw</span>'
};

const PREVIEW_SOURCE = [
	'',
	`# ${PREVIEW.heading}`,
	'',
	`A paragraph with **${PREVIEW.bold}**, ~~${PREVIEW.struck}~~, [${PREVIEW.link}](https://example.com) and \`${PREVIEW.codespan}\`.`,
	'',
	`- ${PREVIEW.bullets[0]}`,
	`- ${PREVIEW.bullets[1]}`,
	'',
	`> ${PREVIEW.quote}`,
	'',
	`| ${PREVIEW.table.columns[0]} | ${PREVIEW.table.columns[1]} |`,
	'| --- | --- |',
	`| ${PREVIEW.table.widest[0]} | .ts |`,
	'',
	`\`\`\`${PREVIEW.fence.language}`,
	PREVIEW.fence.line,
	'```',
	'',
	'---',
	'',
	`![${PREVIEW.image}](./nope.png) and ${PREVIEW.html}.`
].join('\n');

/**
 * The workspace folder's own name, which `createFixture` makes under the temp directory.
 *
 * It is a value the suite states because the explorer's `/` needs it: a query there is relative to
 * the **workspace**, so the folder a single-folder workspace opened on is a query's first segment.
 */
export const WORKSPACE = 'workspace';

/**
 * The run's own user-data directory, **beside** the workspace rather than inside it — the explorer
 * asserts its top-level listing exactly (`TOP_LEVEL`), so a directory the app writes into cannot
 * live under the folder it has open.
 *
 * Without it the suite runs against `%APPDATA%\dev.tscode.app\User`, which is the *developer's own*
 * profile: `file.rs`'s `APP_IDENTIFIER` is `dev.tscode.app` and this fork shares it deliberately, so
 * so one `settings.json` and one `keybindings.json` are shared with tscode (§1.2). A driven run
 * therefore shares logs, caches and history with the tscode the user has open, and
 * `LogsDataCleaner` prunes that directory to the newest 49 sessions on every boot. The override has
 * been in `user_data_dir` for exactly this since it was written — *"the end-to-end suite has to run
 * against user data that is not the developer's own"* — and nothing had ever passed it.
 *
 * **It is the identifier that decides this, not the package name.** An earlier version of this
 * comment blamed `package.json` still being named `tscode`; that was never the mechanism, and the
 * package is named `tucode` now while the profile is still shared, which is the intended state.
 */
export const USER_DATA = 'user-data';

/** Every top-level entry the explorer must list, and nothing else. */
export const TOP_LEVEL = ['.vscode', 'alpha', 'beta', 'delta', 'gamma', 'siblings', README.name, ENCODED_FILE];

/**
 * `alpha`'s children — the discriminating listing.
 *
 * `.git` is hidden and `.githooks` is not, so a `files.exclude` glob that matched on prefix
 * rather than on path segments would fail; and `LICENSE` sorts before `src` alphabetically while
 * `FileSorter` puts every directory first, so "directories precede files" cannot be satisfied by
 * an alphabetical listing.
 */
export const ALPHA = {
	folder: 'alpha',
	directories: ['.githooks', 'src', 'zone'],
	files: ['LICENSE', 'staged.txt', 'tracked.txt', 'untracked.txt'],
	hidden: ['.git']
};

/**
 * The single-child folder chain `explorer.compactFolders` folds. `alpha/src` holds four entries so
 * nothing folds there; `nested` holds only `deep`, and `deep` only a file — so the two folders are
 * one row and the file is under it.
 *
 * The separator is `IconLabel`'s own `/`, and the columns around it are `iconlabel.css`'s
 * `margin: 0 2px` read as the presence toggle `§4.4` describes: a terminal separates two boxes by
 * one column or by none.
 */
export const COMPACT_CHAIN = { parent: 'src', folders: ['nested', 'deep'], row: 'nested / deep', file: 'deeply.md' };

/**
 * What quick open is asked for, and what a pick has to say about it. `LICENSE` is in exactly one of
 * the four repositories and nowhere else in the workspace, so the folder beside the name is what
 * makes the assertion about *this* file rather than about any file — and it has no extension, so
 * the name a fuzzy scorer matched cannot be an extension match.
 */
export const QUICK_OPEN_FILE = {
	name: ALPHA.files[0],
	folder: ALPHA.folder,
	line: 'Permission is hereby granted, free of charge, to any person.'
};

export const REPOSITORIES = ['alpha', 'beta', 'delta', 'gamma'];

/**
 * The query the source control pane's `Tab` cycle is driven with, and the repositories it ranks.
 *
 * **It has to keep more than one of them**, because a repository the query misses is hidden rather
 * than ranked last — so the cycle a one-repository query leaves wraps onto the row it started on and
 * says nothing. `beta` and `delta` are the two carrying a `t` before an `a`; `alpha` and `gamma`
 * carry no `t` at all, and neither resource under the two survivors is named for it either.
 */
export const SCM_RANKED = { query: 'ta', repositories: ['beta', 'delta'] };

/**
 * What each repository's groups hold. The group labels are the provider's
 * (`git.contribution.ts`), the letters are `Status::letter` in `tscode-git` — one table, in Rust —
 * and the colours are the loaded theme's values for the `gitDecoration.*` ids
 * `contrib/scm/tauri/gitStatus.ts` maps each status to. The ids are what this file states; the hex
 * behind each one is the theme's, read from the same file the app reads it from (`lib/theme.mjs`).
 */
export const GIT_COLOURS = {
	stageModified: themeColour('gitDecoration.stageModifiedResourceForeground'),
	modified: themeColour('gitDecoration.modifiedResourceForeground'),
	untracked: themeColour('gitDecoration.untrackedResourceForeground'),
	conflicting: themeColour('gitDecoration.conflictingResourceForeground')
};

/**
 * What the explorer must draw on `alpha`'s files — the same `IDecorationData` the source control
 * pane shows, reaching a different pane through `IDecorationsService`. `LICENSE` is committed and
 * unmodified, so its row must carry no badge and the plain foreground: a decoration that leaked
 * onto every row would pass the three positive cases and fail this one.
 */
export const ALPHA_DECORATIONS = {
	'staged.txt': { letter: 'M', colour: GIT_COLOURS.stageModified },
	'tracked.txt': { letter: 'M', colour: GIT_COLOURS.modified },
	'untracked.txt': { letter: 'U', colour: GIT_COLOURS.untracked },
	LICENSE: { letter: '', colour: undefined }
};

/**
 * The icon each of `alpha`'s files draws, as the seti definition its name or extension maps to.
 * `LICENSE` and `README.md` are `fileNames` entries, `untracked.txt` matches nothing and falls to
 * the theme's own `file` default — which is what makes the three of them discriminating: an icon
 * theme that had not loaded would draw none of them, and one whose file-name associations were
 * dropped would draw the default for all three.
 */
export const ALPHA_ICONS = {
	LICENSE: setiIcon('_license'),
	'untracked.txt': setiIcon('_default')
};

export const README_ICON = setiIcon('_info');

/**
 * What a *folder* carries: `IDecorationsService.getDecoration(uri, true)` rolls its children's
 * bubbled decorations up, and `DecorationRule` draws that as the codicon bubble badge — a glyph in
 * the Private Use Area, so `style.ts` substitutes a dot for it — in the colour of the first of them.
 * `beta` is the discriminating one: its only changed file is the conflict, so the colour cannot have
 * come from anywhere else, and `siblings` is in no repository at all.
 */
export const FOLDER_DECORATIONS = {
	beta: { letter: '●', colour: GIT_COLOURS.conflicting },
	siblings: { letter: '', colour: undefined }
};

/**
 * The groups are also where `SCMTreeFilter` shows: `beta` keeps an empty `Changes` row because the
 * provider does not hide that group when it is empty, while `Staged Changes` and `Merge Changes`
 * do — which is why only `alpha` has the first and only `beta` has the second.
 */
export const GROUPS = {
	alpha: {
		'Staged Changes': [{ letter: 'M', name: 'staged.txt', colour: GIT_COLOURS.stageModified }],
		Changes: [
			{ letter: 'U', name: 'nested.txt', colour: GIT_COLOURS.untracked },
			{ letter: 'U', name: 'note.txt', colour: GIT_COLOURS.untracked },
			{ letter: 'M', name: 'tracked.txt', colour: GIT_COLOURS.modified },
			{ letter: 'U', name: 'untracked.txt', colour: GIT_COLOURS.untracked }
		]
	},
	beta: {
		'Merge Changes': [{ letter: '!', name: 'conflict.txt', colour: GIT_COLOURS.conflicting }],
		Changes: []
	},
	delta: { Changes: [{ letter: 'U', name: 'notes.md', colour: GIT_COLOURS.untracked }] },
	gamma: { Changes: [{ letter: 'U', name: 'notes.md', colour: GIT_COLOURS.untracked }] }
};

/**
 * The one resource with a directory in its path. `directory` is the row tree mode builds out of it;
 * `label` is what list mode puts beside the name instead, which is workspace-relative because
 * `ResourceLabelWidget.setFile` asks `ILabelService` for a relative label and the workspace is the
 * folder the app opened.
 */
export const NESTED_RESOURCE = { directory: 'src', name: 'nested.txt', label: join('alpha', 'src') };

/**
 * The source control pane's own chain, and the counterpart of `COMPACT_CHAIN` in the explorer:
 * `zone` holds only `deep` and `deep` only one untracked file, so tree mode draws the two folders as
 * one row. It sorts after `src` so the explorer's row-counting steps are unaffected.
 */
export const SCM_COMPACT_CHAIN = {
	folders: ['zone', 'deep'],
	row: 'zone / deep',
	file: { letter: 'U', name: 'note.txt', colour: GIT_COLOURS.untracked },
	label: join('alpha', 'zone', 'deep')
};

/**
 * The Sapling repository, and what its smartlog must say.
 *
 * **It is a git repository `sl` has been run in, not an `sl init` one** — Sapling's dotgit mode,
 * metadata at `.git/sl`, which is a first-class Sapling checkout and the second marker discovery
 * walks for. `delta` is the graph: a fork and the merge that closes it, so the swimlanes have
 * something to draw, plus a bookmark on each side.
 *
 * `gamma` is the second one, and it exists so the repository picker has a second entry: `delta`
 * sorts first, so it is still the seed the pane opens on.
 */
export const SAPLING = {
	repository: 'delta',
	/** `delta`'s smartlog, descendants first — the order `sl` prints and the pane draws. */
	commits: ['delta merge', 'delta side', 'delta main', 'delta base'],
	/** The commit `.` points at, which `TextRenderer` marks with `@` rather than a badge. */
	dot: 'delta main',
	/**
	 * That commit's message body, which the commit-info drawer renders as its description — and the
	 * one row this fixture puts in the drawer that is wider than the side bar, so that the drawer's
	 * horizontal axis can be asserted at all. The side bar is a quarter of a 300-column frame.
	 */
	description: 'a description written to run past the right-hand edge of the side bar, which is a quarter of the frame and no wider',
	/** Git branches, which `sl` reports as bookmarks. */
	bookmarks: ['delta-merged', 'delta-side'],
	/** The repository `sapling.pickRepository` can move the pane to. */
	other: { repository: 'gamma', commits: ['gamma base'] }
};

const SETTINGS = {
	// `**/.git` is spelled out as well as registered as a default, so this file says what it expects
	// to be hidden. The second entry is a sibling `when` clause — hide a `.js` file when its `.ts`
	// counterpart exists — and it is the one only a workspace can contribute, which is why an
	// unmerged or unread `files.exclude` shows up as `pair.js` appearing rather than as `.git` doing.
	'files.exclude': { '**/.git': true, '**/*.js': { when: '$(basename).ts' } },
	// The encoding `encoding.txt` is written in.
	'files.encoding': 'windows1252',
	'search.followSymlinks': false,
	'git.autofetch': false,
	'telemetry.telemetryLevel': 'off'
};

/** A commit, and — for the one the commit-info drawer is read off — the body it describes itself in. */
const commit = (cwd, message, body) => git(cwd, ['commit', '--no-verify', '-m', message, ...(body ? ['-m', body] : [])]);

/**
 * Runs `sl` in a git repository, which is what makes it a Sapling repository: the first command
 * builds `.git/sl`, the marker discovery walks for. `root --dotdir` is the cheapest one that does
 * it, and it is also the answer `SlRepository::open` caches.
 */
function sl(cwd, args) {
	const result = spawnSync('sl', args, { cwd, encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		throw new Error(`sl ${args.join(' ')} in ${cwd} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
	}
	return result;
}

/** Staged, unstaged and untracked changes in one repository, and the explorer's listing. */
function buildAlpha(root) {
	const repo = join(root, 'alpha');
	write(root, 'alpha/.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
	write(root, `${ALPHA.folder}/${QUICK_OPEN_FILE.name}`, `${QUICK_OPEN_FILE.line}\n`);
	// The needle is on exactly one line of this file, so a case-insensitive search — which is
	// what `search.smartCase` off means for an all-caps query — still counts one match in it.
	write(root, 'alpha/src/app.ts', TOKEN_COLOR_FILE_CONTENT);
	write(root, `alpha/src/${LONG_LINE.file}`, longLineFileContent(NEEDLES.longLine));
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
	// Under a directory, so tree mode has a folder row to build that list mode must not.
	write(root, `alpha/${NESTED_RESOURCE.directory}/${NESTED_RESOURCE.name}`, 'never added either\n');
	// Under a chain of single-child directories, which is what `scm.compactFolders` folds. It sorts
	// after `src` on purpose: the explorer's steps count rows to reach that folder.
	write(root, `alpha/${SCM_COMPACT_CHAIN.folders.join('/')}/${SCM_COMPACT_CHAIN.file.name}`, 'nor this one\n');
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

/**
 * The Sapling graph: a fork off the base and the merge that closes it, so the smartlog has two
 * swimlanes and a row with two parents, plus a bookmark on each side.
 *
 * `main` stays checked out, so `.` is `delta main` — a commit that is neither the tip of the
 * smartlog nor its root, which is what makes the `@` an assertion about the right row rather than
 * about the first one.
 */
function buildDelta(root, sapling = true) {
	const repo = join(root, 'delta');
	write(root, 'delta/base.txt', 'base\n');

	git(repo, ['init']);
	git(repo, ['add', '.']);
	commit(repo, 'delta base');

	write(root, 'delta/main.txt', 'main\n');
	git(repo, ['add', '.']);
	commit(repo, SAPLING.dot, SAPLING.description);

	git(repo, ['checkout', '-b', SAPLING.bookmarks[1], 'main~1']);
	write(root, 'delta/side.txt', 'side\n');
	git(repo, ['add', '.']);
	commit(repo, 'delta side');

	git(repo, ['checkout', '-b', SAPLING.bookmarks[0], 'main']);
	git(repo, ['merge', '--no-ff', '-m', 'delta merge', SAPLING.bookmarks[1]]);
	git(repo, ['checkout', 'main']);

	write(root, 'delta/notes.md', 'not added yet\n');
	if (sapling) {
		sl(repo, ['root', '--dotdir']);
	}
}

/**
 * One untracked file and nothing else — and the *second* Sapling repository, which is the whole
 * reason the smartlog's repository picker has anything to pick. Its one commit is enough: what the
 * pick has to prove is that the pane draws a different repository afterwards.
 */
function buildGamma(root, sapling = true) {
	const repo = join(root, 'gamma');
	write(root, 'gamma/gamma.ts', 'export const gamma = true;\n');
	git(repo, ['init']);
	git(repo, ['add', '.']);
	commit(repo, SAPLING.other.commits[0]);
	write(root, 'gamma/notes.md', 'not added yet\n');
	if (sapling) {
		sl(repo, ['root', '--dotdir']);
	}
}

/**
 * Creates the workspace in a directory of its own under the repository fixture root. The caller owns
 * `dispose()`.
 *
 * @returns {{ root: string, userData: string, dispose: () => void }}
 */
export function createFixture({ parent = resolve(import.meta.dirname, '../../../.build/test-fixtures'), sapling = true } = {}) {
	mkdirSync(parent, { recursive: true });
	const base = mkdtempSync(join(parent, 'tucode-e2e-'));
	const root = join(base, WORKSPACE);
	const userData = join(base, USER_DATA);
	mkdirSync(root, { recursive: true });
	// Under `base` rather than under `root`, so `dispose()` takes it with everything else and the
	// explorer never sees it.
	mkdirSync(userData, { recursive: true });
	// macOS /etc/zshrc replaces an inherited PS1. Use only this fixture's startup file,
	// selected by the driver's ZDOTDIR, so shell readiness never depends on a user profile.
	write(userData, '.zshrc', 'PROMPT="%/ %# "\n');

	write(root, README.name, `${README.line}\n${PREVIEW_SOURCE}\n`);
	write(root, '.vscode/settings.json', `${JSON.stringify(SETTINGS, undefined, '\t')}\n`);

	write(root, 'siblings/pair.ts', `export const kind = '${NEEDLES.sibling} in a ts file';\n`);
	write(root, 'siblings/pair.js', `exports.kind = '${NEEDLES.sibling} in a js file beside a ts file';\n`);
	write(root, 'siblings/lone.js', `exports.kind = '${NEEDLES.sibling} in a js file with no ts sibling';\n`);

	// Written in windows-1252, where "é" is the single byte 0xE9 — read as UTF-8 the needle would
	// not match at all.
	writeFileSync(join(root, ENCODED_FILE), Buffer.from(`${NEEDLES.encoded}\n`, 'latin1'));

	buildAlpha(root);
	buildBeta(root);
	buildDelta(root, sapling);
	buildGamma(root, sapling);

	return {
		root,
		userData,
		dispose() {
			try {
				rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				console.error(`could not remove the fixture at ${base}: ${error.message}`);
			}
		}
	};
}
