/*---------------------------------------------------------------------------------------------
 *  What `/` in the source control pane answers, over the grammar and the composition `viewRoot.ts`
 *  holds for both panes that have a view root.
 *
 *  **A row is matched on upstream's answer, and that answer is reached by importing the class that
 *  gives it.** `FindFilter` (`abstractTree.ts:626`) over `SCMTreeKeyboardNavigationLabelProvider`
 *  (`scmViewPane.ts:560`) is what tscode's own tree find runs against this pane, so which of the six
 *  row kinds a query scores and what list mode does differently from tree mode are read off there:
 *
 *  - a **resource group** is matched on its label, a **folder node** on its name, and a **resource**
 *    on its basename in tree mode and on `[fileName, filePath]` in list mode, which is where a
 *    path-shaped query means something and where it does not;
 *  - the **commit input** and the **action button** answer `undefined` from the label provider, and
 *    `FindFilter` returns before it scores anything — so a query never takes them away. Neither are
 *    they ranked: they are structure at every root, like the groups, rather than rows the path names.
 *
 *  **A repository is the one row the label provider cannot answer for**, because upstream's find has
 *  no notion of one being *chosen*. It is scored on `provider.name` instead — the same name the
 *  query's first segment resolves against, so the row the ranking puts the cursor on is the
 *  repository `Enter` re-roots to — and it hides when that score is zero, exactly as a folder does
 *  in the explorer. It read *never hides, whatever the query says*; `rank` says why that was wrong.
 *
 *  **The pane's own rows are here too, and not in the view's own file**, per the
 *  one-place-for-interaction rule: where a moved root re-points the data source, which rows the
 *  last segment has anything to say about, and which of them a compressed chain may not start at.
 *  All three are decisions rather than paint, so they are `IAsyncDataSource`/
 *  `ITreeCompressionDelegate` wrappers over the vendored pane's own instances — the seams
 *  `SCMTreeDataSource` is already driven through.
 *
 *  Upstream counterpart: none — the view root is this fork's; what this file holds besides it is `SCMTreeDataSource`'s own arms, wrapped rather than restated.
 *--------------------------------------------------------------------------------------------*/

import { FuzzyScore } from '../../../../base/common/filters.js';
import { FuzzyScorerCache, IPreparedQuery, prepareQuery, scoreItemFuzzy } from '../../../../base/common/fuzzyScorer.js';
import { IResourceNode, ResourceTree } from '../../../../base/common/resourceTree.js';
import { FindFilter, LabelFuzzyScore, TreeFindMode } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeCompressionDelegate } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { isFilterResult } from '../../../../base/browser/ui/tree/indexTreeModel.js';
import { IAsyncDataSource, ITreeFilter, ITreeSorter, TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISCMProvider, ISCMRepository, ISCMResource, ISCMResourceGroup, ISCMViewService, ViewMode } from '../common/scm.js';
import { SCMTreeKeyboardNavigationLabelProvider, TreeElement } from '../browser/scmViewPane.js';
import { isSCMRepository, isSCMResourceGroup, isSCMResourceNode, isSCMViewService } from '../browser/util.js';
import { INodes, nameAccessor, pathQuery, rankOf } from '../../../browser/tauri/viewRoot.js';
import { IRanking, ViewRootFilter } from '../../../browser/tauri/viewRootFilter.js';

/**
 * What a row's `filterData` is. It is `FindFilter`'s pair rather than a plain `FuzzyScore` because
 * list mode scores a resource against two labels — the file name and the path — and says which one
 * matched, which is what `processResourceFilterData` splits the runs by.
 */
export type SCMFilterData = FuzzyScore | LabelFuzzyScore;

/** A folder inside a repository, as every group's own resource tree already knows it. */
type SCMFolder = IResourceNode<ISCMResource, ISCMResourceGroup>;

/**
 * The pane's view root: a repository, and the changed folder inside it the pane is showing.
 *
 * **The folder is a path rather than a node**, because a node belongs to one group's resource tree
 * and a root has to mean the same folder in every group at once — `Changes` and `Staged Changes` are
 * structure, not directories, so they render at every root.
 */
export interface ISCMViewRoot {
	readonly repository: ISCMRepository;
	readonly path: readonly string[];
}

/** Semantic equality for a root resolved from a fresh query against the already-loaded SCM graph. */
export function sameSCMViewRoot(one: ISCMViewRoot | undefined, other: ISCMViewRoot | undefined): boolean {
	return one === other || (!!one && !!other && one.repository === other.repository &&
		one.path.length === other.path.length && one.path.every((segment, index) => segment === other.path[index]));
}

/** Where the root's path lands inside one group's tree, or nothing if that group has no such folder. */
export function folderAt(group: ISCMResourceGroup, path: readonly string[]): SCMFolder | undefined {
	let node: SCMFolder | undefined = group.resourceTree.root;

	for (const name of path) {
		node = node?.get(name);
	}

	return node;
}

/** The path `/` opens with at a root, which is the root's own — so opening the box never moves the pane. */
export function queryFor(root: ISCMViewRoot | undefined): string {
	return pathQuery(root ? [root.repository.provider.name, ...root.path] : []);
}

/** `SCMTreeDataSource.getParent`'s own line for a group: which visible repository a provider is. */
function repositoryOf(scmViewService: ISCMViewService, provider: ISCMProvider): ISCMRepository | undefined {
	return scmViewService.visibleRepositories.find(repository => repository.provider === provider);
}

/**
 * What a path segment descends over: the repositories at the top, and below one of them the changed
 * folders at the root — **the folders the groups have, not the ones on disk**, taken from the
 * resource trees the groups already build. A folder a repository has no change in has no row here and
 * so cannot be named.
 */
export function scmNodes(scmViewService: ISCMViewService): INodes<ISCMViewRoot> {
	return {
		children: root => root ? foldersIn(root) : scmViewService.visibleRepositories.map(repository => ({ repository, path: [] })),
		name: root => root.path.at(-1) ?? root.repository.provider.name
	};
}

function foldersIn(root: ISCMViewRoot): ISCMViewRoot[] {
	const names = new Set<string>();

	for (const group of root.repository.provider.groups) {
		for (const child of folderAt(group, root.path)?.children ?? []) {
			// A node with children is a folder; one with an element and none is a file, which is the
			// discrimination `SCMTreeDataSource.getChildren` makes over the same nodes.
			if (child.childrenCount > 0) {
				names.add(child.name);
			}
		}
	}

	return [...names].map(name => ({ repository: root.repository, path: [...root.path, name] }));
}

/** Which root `Enter` moves to, or nothing for a row that is not one — a resource, a group, a box. */
export function rootFor(scmViewService: ISCMViewService, element: TreeElement | undefined): ISCMViewRoot | undefined {
	if (!element) {
		return undefined;
	}

	if (isSCMRepository(element)) {
		return { repository: element, path: [] };
	}

	if (isSCMResourceNode(element)) {
		const repository = repositoryOf(scmViewService, element.context.provider);

		return repository ? { repository, path: element.relativePath.split('/').filter(Boolean) } : undefined;
	}

	return undefined;
}

/** A `FuzzyScore` and a `LabelFuzzyScore` both carry the score first, and that is where a row ranks. */
function scoreOf(data: SCMFilterData): number {
	return ((data as LabelFuzzyScore).label ? (data as LabelFuzzyScore).score : data as FuzzyScore)[0];
}

/**
 * What a source control row is matched on, which is `FindFilter`'s answer for every row kind that
 * has one, and `provider.name` for the one kind that does not.
 */
class SCMRanking implements IRanking<TreeElement, SCMFilterData>, IDisposable {

	/** The rows the root's groups put on screen — the rows the last segment ranks. */
	private readonly ranked = new Set<TreeElement>();

	/** Where each ranked row sits, so the sorter and the filter ask the scorer once between them. */
	private readonly scores = new Map<TreeElement, number>();

	private repositoryQuery: IPreparedQuery | undefined;
	private cache: FuzzyScorerCache = Object.create(null);
	private _pattern = '';

	constructor(
		private readonly find: FindFilter<TreeElement>,
		private readonly labels: SCMTreeKeyboardNavigationLabelProvider
	) { }

	dispose(): void {
		this.find.dispose();
	}

	get pattern(): string {
		return this._pattern;
	}

	set pattern(pattern: string) {
		this._pattern = pattern;
		this.find.pattern = pattern;
		this.repositoryQuery = pattern ? prepareQuery(pattern) : undefined;
		this.scores.clear();
		this.cache = Object.create(null);
	}

	/**
	 * The rows one level of the rebuild put at the view root, as they are produced.
	 *
	 * **They arrive a level at a time rather than all at once**, because an async data source is
	 * asked for a node's children when that node is expanded — so a group opened later than the
	 * rebuild still hands its rows to the ranking, which a single `setRanked` at the end could not.
	 */
	addRanked(element: TreeElement): void {
		this.ranked.add(element);
	}

	clearRanked(): void {
		this.ranked.clear();
		this.scores.clear();
	}

	ranks(element: TreeElement): boolean {
		return this.ranked.has(element);
	}

	/**
	 * The name a row is matched on, which is the label provider's own answer — the chain's is never
	 * asked for, because compaction is off for as long as the box is open. List mode answers a
	 * resource with `[fileName, filePath]`, and the file name is what the row reads.
	 */
	name(element: TreeElement): string | undefined {
		if (isSCMRepository(element)) {
			return element.provider.name;
		}

		const label = this.labels.getKeyboardNavigationLabel(element);

		return (Array.isArray(label) ? label[0] : label)?.toString();
	}

	rank(element: TreeElement): { data?: SCMFilterData } | undefined {
		// **A repository is hidden when it does not match, which is what the explorer does with a
		// folder** — and it is the same rule rather than a second one because both panes ask
		// `rankOf` (`viewRoot.ts`), which is where the score-to-visibility decision lives. All this
		// pane supplies is the score: a repository is scored on `provider.name` through
		// `repositoryQuery` rather than through `FindFilter`, because the label provider has no
		// answer for a repository row, and it has no label to tint, so it ranks without `data`.
		//
		// It read `return {}` — ranked and never hidden — on the grounds that the query's first
		// segment lands on a repository and a query that has not reached one yet must still be able
		// to name it. That does not survive being asked of the explorer, where the first segment
		// names a folder, non-matching folders hide as they are typed past, and naming the one you
		// want works because it is among the survivors. Same argument, opposite conclusion, and no
		// reason for the difference.
		if (isSCMRepository(element)) {
			return rankOf(this.scoreFor(element));
		}

		// **Every other row carries the rule inside `FindFilter`'s own answer rather than restating
		// it**: upstream returns a filter result only where it scored the label, so the data *is*
		// the match and its absence is the row the query did not score. Reading a score back out to
		// ask `rankOf` would not be the same rule — a row whose label provider answers `undefined`
		// comes back as `FuzzyScore.Default`, which upstream keeps and a score test would hide.
		const data = this.match(element);

		return data ? { data } : undefined;
	}

	compare(one: TreeElement, other: TreeElement): number {
		return this.scoreFor(other) - this.scoreFor(one);
	}

	/** Upstream's own matching, asked of one element: a `TreeVisibility` back is a row it took away. */
	private match(element: TreeElement): SCMFilterData | undefined {
		const result = this.find.filter(element, TreeVisibility.Visible);

		return isFilterResult<SCMFilterData>(result) ? result.data : undefined;
	}

	private scoreFor(element: TreeElement): number {
		let score = this.scores.get(element);

		if (score === undefined) {
			score = isSCMRepository(element)
				? scoreItemFuzzy(element, this.repositoryQuery!, true, repositoryAccessor, this.cache).score
				: scoreOf(this.match(element) ?? FuzzyScore.Default);
			this.scores.set(element, score);
		}

		return score;
	}
}

/** A repository is named by its provider, which is the name `RepositoryRenderer` draws on the row. */
const repositoryAccessor = nameAccessor<ISCMRepository>(repository => repository.provider.name);

/** The pane's `/`, which is the shared composition over the ranking above. */
export class SCMFilter extends ViewRootFilter<TreeElement, SCMFilterData, SCMRanking> implements IDisposable {

	dispose(): void {
		this.ranking.dispose();
	}

	/** A row the rebuild put at the view root, which is a row the last segment has something to say about. */
	addRanked(element: TreeElement): void {
		this.ranking.addRanked(element);
	}

	clearRanked(): void {
		this.ranking.clearRanked();
	}

	/** Whether a row is one of those — which is also what a compressed chain may not start at. */
	ranks(element: TreeElement): boolean {
		return this.ranking.ranks(element);
	}

	set(pattern: string, resolved: boolean): void {
		this.apply(pattern, resolved);
	}
}

/**
 * The pane's filter and sorter, over the two the vendored pane already constructs — so with no query
 * the tree is `SCMTreeFilter` and `SCMTreeSorter` again, and neither is restated here.
 */
export function createSCMFilter(
	instantiationService: IInstantiationService,
	viewMode: () => ViewMode,
	filter: ITreeFilter<TreeElement, FuzzyScore>,
	sorter: ITreeSorter<TreeElement>
): SCMFilter {
	const labels = instantiationService.createInstance(SCMTreeKeyboardNavigationLabelProvider, viewMode);
	const find = new FindFilter<TreeElement>(labels);
	find.findMode = TreeFindMode.Filter;

	return new SCMFilter(new SCMRanking(find, labels), filter, sorter);
}

/**
 * The tree's data source while `/` has moved the root: the repository's own rows stand in for the
 * repository list, and a group's rows are the rows of the node the root's path names inside the
 * resource tree that group has already built.
 *
 * **There is no arm for the two view modes below the group.** Tree mode reads one level of that
 * node, which is what `SCMTreeDataSource` does with a folder row; list mode reads every resource
 * under it, which is what it does with a group. So a group's children are the same thing at a moved
 * root as they are at the top, and the last segment reads as a deep search in list mode for that
 * reason.
 */
export class SCMViewRootDataSource implements IAsyncDataSource<ISCMViewService, TreeElement> {

	/** Where the pane is rooted, and `undefined` for the top level, whose rows are the repositories. */
	root: ISCMViewRoot | undefined;

	/**
	 * Whether the tree's top level is the repository list — **upstream's own answer, read off what it
	 * returned rather than restated here.** `SCMTreeDataSource.getChildren` draws a repository row
	 * only past one repository (or under `scm.alwaysShowRepositories`), and folds the single one's own
	 * rows up to the top otherwise; a second copy of that condition is a decision that would drift.
	 */
	private repositoriesAtTop = false;

	constructor(
		private readonly source: IAsyncDataSource<ISCMViewService, TreeElement>,
		private readonly viewMode: () => ViewMode,
		private readonly filter: SCMFilter
	) { }

	hasChildren(inputOrElement: ISCMViewService | TreeElement): boolean {
		return this.source.hasChildren(inputOrElement);
	}

	getParent(element: TreeElement): ISCMViewService | TreeElement {
		return this.source.getParent!(element);
	}

	/**
	 * **The last segment ranks the view root's own level and nothing below it**, and the rows of that
	 * level are marked as they are produced: the repositories where the top level is the repository
	 * list, and a group's rows everywhere else, since a group is structure the root renders rather
	 * than a level of its own.
	 *
	 * **The groups under a repository the query has not named are two levels down**, and this is the
	 * one place where they can be told apart from the root's own: the pane opens expanded, so those
	 * rows are on screen, where the explorer's equivalents are behind a twistie and no query could
	 * ever have reached them. Ranking them made the last segment filter the whole tree — a repository
	 * name typed at the top emptied every *other* repository of its files.
	 *
	 * **That case no longer arises, and this rule is still the right one.** A repository that does
	 * not match is now hidden outright (`rank`), so its files go with it rather than staying on
	 * screen with every one of them filtered away. What this rule still decides is the *matching*
	 * repository's own contents: the last segment ranks the view root's level, and a repository's
	 * files are not that level. The reason it is written in terms of the explorer no longer holds
	 * — the two panes hide alike now — so what keeps it is the structural fact above, that these
	 * rows are only reachable because this pane opens expanded.
	 */
	async getChildren(inputOrElement: ISCMViewService | TreeElement): Promise<Iterable<TreeElement>> {
		const children = [...await this.rowsOf(inputOrElement)];

		if (isSCMViewService(inputOrElement)) {
			this.repositoriesAtTop = children.some(isSCMRepository);
		}

		const atRoot = isSCMResourceGroup(inputOrElement) && !this.repositoriesAtTop;

		for (const child of children) {
			if (atRoot || isSCMRepository(child)) {
				this.filter.addRanked(child);
			}
		}

		return children;
	}

	private rowsOf(inputOrElement: ISCMViewService | TreeElement): Iterable<TreeElement> | Promise<Iterable<TreeElement>> {
		const root = this.root;

		if (root && isSCMViewService(inputOrElement)) {
			return this.source.getChildren(root.repository);
		}

		if (root?.path.length && isSCMResourceGroup(inputOrElement)) {
			const node = folderAt(inputOrElement, root.path);
			if (!node) {
				return [];
			}

			return this.viewMode() === ViewMode.List ? ResourceTree.collect(node) : this.source.getChildren(node);
		}

		return this.source.getChildren(inputOrElement);
	}
}

/**
 * **A row at the view root is incompressible whatever the pane's own delegate answers**, because
 * that delegate's test for one is `!element.parent.parent` — "a direct child of a group" — and a
 * root a folder down falsifies it: the chain would then start at the group, whose `name` is
 * `undefined`, and `splitMatches` throws inside `renderCompressedElements` where nothing catches it.
 */
export function rootCompression(compression: ITreeCompressionDelegate<TreeElement>, filter: SCMFilter): ITreeCompressionDelegate<TreeElement> {
	return { isIncompressible: element => filter.ranks(element) || compression.isIncompressible(element) };
}
