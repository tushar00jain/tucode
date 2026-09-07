/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Ancestor, AncestorType, Renderer } from '../common/render.js';
import type { ExtendedGraphRow } from '../common/render.js';
import type { CommitInfo, Hash } from '../common/types.js';
// Type-only, and it has to say so: `slIpc.ts` reaches `base/parts/ipc` for `IChannel`, which
// uses decorators — so a plain import would drag that module into the unit tests, which run on
// Node's type stripping rather than through a bundler.
import type { ISlCommit } from './slIpc.js';

/**
 * One rendered smartlog row: the commit and the swimlane geometry `render.ts` laid out for it.
 * One of them is the virtual working copy rather than a commit off the wire — see
 * `youAreHereCommit`.
 */
export interface ISaplingRow {
	readonly info: CommitInfo;
	readonly row: ExtendedGraphRow;
}

/** The wire commit as the copied renderer wants it: `date` is a `Date` in ISL's `CommitInfo`. */
export function toCommitInfo(commit: ISlCommit): CommitInfo {
	return { ...commit, date: new Date(commit.date * 1000) };
}

/**
 * The "wdir()" virtual hash.
 * This needs to match the CLI's interpretation of "wdir()". See `wdirhex` in sapling/node.py.
 */
const WDIR_NODE = 'ffffffffffffffffffffffffffffffffffffffff';

/**
 * `YOU_ARE_HERE_VIRTUAL_COMMIT` in `addons/isl/src/dag/virtualCommit.ts`, over the fields this
 * port's `CommitInfo` carries, and with the parent `CommitTreeList.tsx` sets on it —
 * `dag.add([YOU_ARE_HERE_VIRTUAL_COMMIT.set('parents', [dot.hash])])`.
 *
 * It is what puts the "You are here" label on a row of its own above ".", and what makes the
 * curve between the two a link line the renderer derives rather than a stroke drawn by hand.
 */
function youAreHereCommit(dot: Hash): CommitInfo {
	return {
		hash: WDIR_NODE,
		title: '',
		parents: [dot],
		grandparents: [],
		phase: 'draft',
		isDot: false,
		date: new Date(8640000000000000),
		bookmarks: [],
		remoteBookmarks: [],
		author: '',
		description: '',
		filePathsSample: [],
		totalFileCount: 0,
		closestPredecessors: [],
		isYouAreHere: true
	};
}

/**
 * Port of `Dag.subsetForRenderingImpl` in `addons/isl/src/dag/dag.ts`, over the fetched list
 * rather than over a client-side dag.
 *
 * **`sl` returns more than ISL draws.** The revset answers with a set; ISL then hides two kinds
 * of row from it before rendering, and without this the port draws public commits upstream
 * never shows and whole obsolete stacks it condenses to their ends:
 *
 * - **Unnamed public commits** — public, no bookmark of either kind, not "." — unless a draft
 *   commit hangs directly off them. `stableCommitMetadata` is the fourth term of upstream's
 *   test and is absent here, as it is absent from the fetch; a commit that would have carried
 *   one is therefore hidden rather than kept.
 * - **The middle of an obsolete stack**, keeping only its roots, its heads, and the parents of
 *   the drafts that are not themselves obsolete. Upstream puts this behind
 *   `isl.condense-obsolete-stacks`, which defaults to true.
 *
 * The edges are `parents` *and* `grandparents`, which is the pair `Dag.add` folds into one
 * parent list (`dag.ts`: `.set('parents', [...c.parents, ...c.grandparents])`).
 */
export function subsetForRendering(commits: readonly CommitInfo[]): CommitInfo[] {
	const all = new Set(commits.map(info => info.hash));
	const edges = (info: CommitInfo) => [...info.parents, ...info.grandparents].filter(hash => all.has(hash));

	/** `dag.parents(set)`: everything in the fetched set that a member of `set` names as a parent. */
	const parentsOf = (set: ReadonlySet<Hash>) => new Set(commits
		.filter(info => set.has(info.hash))
		.flatMap(edges));

	const draft = new Set(commits.filter(info => info.phase === 'draft').map(info => info.hash));
	const obsolete = new Set(commits.filter(info => info.successorInfo !== undefined).map(info => info.hash));

	const unnamedPublic = commits.filter(info =>
		info.phase === 'public' &&
		info.remoteBookmarks.length === 0 &&
		info.bookmarks.length === 0 &&
		!info.isDot);

	const parentsOfDraft = parentsOf(draft);
	const toHide = new Set(unnamedPublic
		.filter(info => !parentsOfDraft.has(info.hash))
		.map(info => info.hash));

	// `roots(obsolete)` names no obsolete parent; `heads(obsolete)` is named by no obsolete child.
	const obsoleteParents = parentsOf(obsolete);
	const nonObsoleteDraft = new Set([...draft].filter(hash => !obsolete.has(hash)));
	const toKeep = parentsOf(nonObsoleteDraft);

	for (const info of commits) {
		if (!obsolete.has(info.hash)) {
			continue;
		}
		const isRoot = !edges(info).some(hash => obsolete.has(hash));
		const isHead = !obsoleteParents.has(info.hash);
		if (isRoot || isHead) {
			toKeep.add(info.hash);
		}
	}

	for (const hash of obsolete) {
		if (!toKeep.has(hash)) {
			toHide.add(hash);
		}
	}

	return commits.filter(info => !toHide.has(info.hash));
}

/**
 * Port of `Dag.renderToRowsImpl` and `Dag.dagWalkerForRendering` in `addons/isl/src/dag/dag.ts`,
 * for a set that is always the whole smartlog rather than a subset of a client-side dag.
 *
 * The two arms ISL's walker has that this one does not need follow from that: a parent outside
 * the set is not "elsewhere in the dag" here, it is absent, so it is anonymous ("~") rather than
 * something to resolve a grandparent for. Sapling answers the indirect edges itself, in
 * `grandparents`, which `Dag.add` folds into `parents` and `ancestors` exactly as below.
 *
 * `commits` must arrive descendants first, which is the order `sl` renders a smartlog in: the
 * renderer assigns each row's column from the columns its children already claimed.
 */
export function renderToRows(commits: readonly CommitInfo[]): ISaplingRow[] {
	const renderer = new Renderer();
	const renderSet = new Set<Hash>(commits.map(info => info.hash));
	const rows: ISaplingRow[] = [];

	// Reserve a column for the public branch, which is what indents the draft commits beside it.
	for (const info of commits) {
		if (info.phase === 'public') {
			renderer.reserve(info.hash);
			break;
		}
	}

	for (const info of commits) {
		// The working copy is a child of ".", so it is rendered ahead of it. `forceLastColumn` is
		// what `renderToRowsImpl` passes for it, and is what keeps the label out of the columns
		// the commits below are using.
		if (info.isDot) {
			rows.push({ info: youAreHereCommit(info.hash), row: renderer.nextRow(WDIR_NODE, [new Ancestor({ type: AncestorType.Parent, hash: info.hash })], { forceLastColumn: true }) });
		}

		// directParents: solid edges
		// ancestors (`grandparents`): dashed edges
		// anonymousParents: ----"~"
		const parents = [...info.parents, ...info.grandparents];
		const typedParents: Ancestor[] = [];
		let anonymousParents = 0;

		for (const parent of parents) {
			if (!renderSet.has(parent)) {
				anonymousParents++;
				continue;
			}

			const type = info.grandparents.includes(parent) ? AncestorType.Ancestor : AncestorType.Parent;
			typedParents.push(new Ancestor({ type, hash: parent }));
		}

		if (anonymousParents > 0 && info.grandparents.length === 0) {
			typedParents.push(new Ancestor({ type: AncestorType.Anonymous, hash: undefined }));
		}

		if (parents.length > 0 && typedParents.length === 0) {
			// The commit has parents but none of them are rendered. An anonymous parent is what
			// says it is not a root.
			typedParents.push(new Ancestor({ type: AncestorType.Anonymous, hash: undefined }));
		}

		rows.push({ info, row: renderer.nextRow(info.hash, typedParents) });
	}

	return rows;
}
