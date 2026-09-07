/*---------------------------------------------------------------------------------------------
 *  One upstream row renderer, driven over one template — and the two things this fork does with the
 *  tree that comes out.
 *
 *  `renderTemplate`/`renderElement` is a recycling split, so a row is *rendered* and *read* in one
 *  breath: there is one template per renderer and the next row is written into the same elements.
 *  `RowTemplate.withRow` is that pairing, fused into a single call so a caller cannot keep the tree
 *  past the read or forget the `disposeElement` owed with it.
 *
 *  The terminal walks the tree into spans through `RowPainter` below — `withRow` with `paint` as
 *  the reader. `FilesRenderer`,
 *  `ResourceRenderer`, `RepositoryRenderer`, `ResourceGroupRenderer` and `ActionButtonRenderer` run
 *  here exactly as upstream wrote them, against `document.ts`'s element tree — which is
 *  measurement-free by construction. Nothing of `iconLabel.ts`, `highlightedLabel.ts` or
 *  `countBadge.ts` is re-derived as a cell view.
 *
 *  What it stands in for there is `TreeRenderer`'s `renderTemplate`/`renderElement` split, which is
 *  the half of that file a list widget drives; nothing of the widget itself is here.
 *
 *  Upstream counterpart: src/vs/base/browser/ui/tree/abstractTree.ts
 *--------------------------------------------------------------------------------------------*/

import type { ICompressedTreeNode } from '../../../vs/base/browser/ui/tree/compressedObjectTreeModel.js';
import type { ICompressibleTreeRenderer } from '../../../vs/base/browser/ui/tree/objectTree.js';
import type { ITreeNode } from '../../../vs/base/browser/ui/tree/tree.js';
import type { ISpan } from '../screen.js';
import type { TerminalElement } from './document.js';
import type { IRenderStyle, ISegmentedDomRenderRecords } from './renderRecords.js';

import { Disposable, toDisposable } from '../../../vs/base/common/lifecycle.js';
import { IThemeService } from '../../../vs/platform/theme/common/themeService.js';
import { IStyle, LIST_ROW_CLASS, paint, ScopeEntry, treeRow } from './paint.js';
import { interpretSegmentedDom } from './renderRecords.js';

export type { ScopeEntry };

/**
 * A rendered row's element tree, valid only inside the `read` callback it is handed to.
 *
 * The lifetime is not a caution, it is the recycling contract: there is one template per renderer
 * and `renderElement` writes the next row into the same elements, so a tree kept past the call is
 * a tree that will silently describe some other row.
 */
export type ReadRow<R> = (contents: TerminalElement) => R;

export class RowTemplate<T, TFilterData = void> extends Disposable {

	private readonly row: TerminalElement;
	private readonly contents: TerminalElement;
	private readonly template: unknown;

	/**
	 * `scope` is `treeRow`'s — the chain of view containers the sheets are written against.
	 *
	 * `FilesRenderer` is stateful, so one renderer per row kind preserves upstream's shape.
	 */
	constructor(
		readonly renderer: ICompressibleTreeRenderer<T, TFilterData, unknown>,
		protected readonly themeService: IThemeService,
		scope: readonly ScopeEntry[] = []
	) {
		super();

		({ row: this.row, contents: this.contents } = treeRow(scope, themeService, this._store));

		this.template = this.renderer.renderTemplate(this.contents as unknown as HTMLElement);
		this._register(toDisposable(() => this.renderer.disposeTemplate(this.template)));
	}

	/**
	 * The row rendered, read, and disposed. `classes` are the row's own terminal focus and selection
	 * states.
	 *
	 * `compressed` is the raw node behind a compressed row, which the model answers with; the branch
	 * on `elements.length` is `CompressibleRenderer.renderElement`'s own, and it is what turns a
	 * folder chain into the single `a/b/c` row `explorer.compactFolders` asks for.
	 */
	withRow<R>(node: ITreeNode<T, TFilterData>, index: number, classes: readonly string[], compressed: ITreeNode<ICompressedTreeNode<T>, TFilterData> | undefined, read: ReadRow<R>): R {
		this.row.className = [LIST_ROW_CLASS, ...classes].join(' ');

		const chained = !!compressed && compressed.element.elements.length > 1;
		if (chained) {
			this.renderer.renderCompressedElements(compressed!, index, this.template);
		} else {
			this.renderer.renderElement(node, index, this.template);
		}

		try {
			return read(this.contents);
		} finally {
			if (chained) {
				this.renderer.disposeCompressedElements?.(compressed!, index, this.template);
			} else {
				this.renderer.disposeElement?.(node, index, this.template);
			}
		}
	}

	/** Unselected semantic row records; selection and focus are frontend projection flags. */
	records(node: ITreeNode<T, TFilterData>, index: number,
		compressed?: ITreeNode<ICompressedTreeNode<T>, TFilterData>, base: IRenderStyle = {}): ISegmentedDomRenderRecords {
		return this.withRow(node, index, [], compressed, contents => interpretSegmentedDom(contents,
			this.themeService.getColorTheme(), element => element.getAttribute('data-icon-label-index') ?? undefined, base));
	}
}

/**
 * The terminal's reader: the row's contents as spans. The wrapper is upstream's own, because a
 * renderer reaches out of its container for it — `FilesRenderer.renderStat` walks two parents up to
 * find the twistie. `TwistiePainter` draws that twistie; this draws the contents beside it.
 */
export class RowPainter<T, TFilterData = void> extends RowTemplate<T, TFilterData> {

	render(node: ITreeNode<T, TFilterData>, index: number, base: IStyle = {}, classes: readonly string[] = [], compressed?: ITreeNode<ICompressedTreeNode<T>, TFilterData>): ISpan[] {
		return this.withRow(node, index, classes, compressed,
			contents => paint(contents, this.themeService.getColorTheme(), base));
	}
}
