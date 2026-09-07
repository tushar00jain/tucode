/*---------------------------------------------------------------------------------------------
 *  The tree walker: an element tree in, the spans `screen.ts` already paints out.
 *
 *  Document order, one style inherited down the chain — what the sheets say about an element
 *  merged onto what its ancestors said, and `display: none` pruning the subtree. Nothing new is
 *  invented on the way: the colours are the ones upstream's stylesheets name, resolved through
 *  the colour registry this fork already resolves, and the text is whatever upstream's renderer
 *  put in the tree.
 *
 *  `treeRow` builds the row wrapper upstream's sheets are written against. `RowPainter` — the seam
 *  a pane sits behind — now lives in `rowTemplate.ts` with the template it paints.
 *
 *  Upstream counterpart: none — stands in for the browser's layout and paint. The row seam beside it in `rowTemplate.ts` is the render half of `src/vs/base/browser/ui/list/listView.ts`, which this fork does not use.
 *--------------------------------------------------------------------------------------------*/

import type { ITreeNode } from '../../../vs/base/browser/ui/tree/tree.js';
import type { IFileIconTheme, IColorTheme, IThemeService } from '../../../vs/platform/theme/common/themeService.js';
import type { IDisposable } from '../../../vs/base/common/lifecycle.js';
import type { ISpan } from '../screen.js';
import type { TerminalElement } from './document.js';

import { Emitter, Event } from '../../../vs/base/common/event.js';
import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { TerminalElement as MutableTerminalElement } from './document.js';
import { interpretDom, mergeRenderStyle } from './renderRecords.js';

export { colorOf } from './renderRecords.js';

/** A span's style, which is a span with nothing said yet. */
export type IStyle = Omit<ISpan, 'text'>;

/**
 * This fork's one pixel divergence, declared once and in one place. The row stack consults no
 * geometric property at all; the single measurement that
 * survives into a terminal is `workbench.tree.indent`, "Controls tree indentation in pixels"
 * (`listService.ts:179`). Four pixels is one column, so its default of 8 is the two-column indent
 * this frontend already draws. Do not add a second conversion.
 */
const PIXELS_PER_COLUMN = 4;

export function indentColumns(pixels: number): number {
	return Math.max(1, Math.round(pixels / PIXELS_PER_COLUMN));
}

/** `workbench.tree.indent`'s default, for a boot where `listService.ts` registered no schema. */
const DEFAULT_TREE_INDENT = 8;

/**
 * `--vscode-badge-background` is `asCssVariableName`'s transform of `badge.background`, so the
 * registry is the table — inverted from it rather than written out beside it.
 */
export function merge(inherited: IStyle, cell: Parameters<typeof mergeRenderStyle>[1], theme: IColorTheme): IStyle {
	return mergeRenderStyle(inherited, cell, theme);
}

/** `element` and everything under it, as spans, over the style the row starts in. */
export function paint(element: TerminalElement, theme: IColorTheme, base: IStyle = {}): ISpan[] {
	return interpretDom(element, theme, base).runs.map(({ text, style }) => ({ ...style, text }));
}

/**
 * One element of a row's scope: a class name, or a function that dresses the element itself.
 * Upstream has both — `searchView.ts:951` writes its container's classes into the selector it
 * builds it with, while the explorer's are a function that keeps two of them in step with the file
 * icon theme.
 */
export type ScopeEntry = string | ((container: TerminalElement, themeService: IThemeService) => IDisposable);

/**
 * `.monaco-list-row`, written once: `treeRow` puts it on the wrapper and `RowTemplate.withRow`
 * restates it with the row's own classes beside it, and the two must name the same class or the
 * second write takes the row out of every sheet the first put it in.
 */
export const LIST_ROW_CLASS = 'monaco-list-row';

/**
 * `createFileIconThemableTreeContainerScope`, copied from
 * `src/vs/workbench/contrib/files/browser/views/explorerView.ts` because importing it is what a
 * rung-1 reuse would be and it costs more than the function is worth: that module registers four
 * `Action2`s at load, two of them `f1: true`, so an import would put *Refresh Explorer* and
 * *Collapse Folders in Explorer* in this fork's command palette over an `IViewsService` nothing
 * registers. The body is verbatim; only the parameter's type is narrowed to what it reads.
 */
export function createFileIconThemableTreeContainerScope(container: TerminalElement, themeService: IThemeService): IDisposable {
	container.classList.add('file-icon-themable-tree');
	container.classList.add('show-file-icons');

	const onDidChangeFileIconTheme = (theme: IFileIconTheme) => {
		container.classList.toggle('align-icons-and-twisties', theme.hasFileIcons && !theme.hasFolderIcons);
		container.classList.toggle('hide-arrows', theme.hidesExplorerArrows === true);
	};

	onDidChangeFileIconTheme(themeService.getFileIconTheme());
	return themeService.onDidFileIconThemeChange(onDidChangeFileIconTheme);
}

/**
 * Upstream's own row wrapper — `.monaco-list-row > .monaco-tl-row > .monaco-tl-twistie +
 * .monaco-tl-contents`, as `TreeRenderer.renderTemplate` builds it — inside the chain of view
 * containers its stylesheets are written against.
 *
 * `scope` is that chain, outermost first: `['scm-view', 'monaco-list']` is what makes `scm.css`'s
 * `.scm-view .monaco-list-row .resource.faded` apply here as it applies there, and
 * `'show-file-icons'` is what `applyAndSetFileIconTheme` puts on the workbench container in tscode,
 * so that the file icon theme's own rules reach a resource label's `::before`.
 *
 * An entry that is a function dresses its wrapper itself, which is what
 * `createFileIconThemableTreeContainerScope` is for: it owns which classes the explorer's tree
 * container carries and keeps `align-icons-and-twisties` in step with the file icon theme, and that
 * is what decides whether a file row carries a twistie's width in front of its icon.
 *
 * It is exported because `RowTemplate` builds the same scoped row for an `NSTableCellView` and must
 * build it the *same* way — a second copy of the nesting is a second answer to which CSS rules a row
 * matches, and the sheets are upstream's.
 */
export function treeRow(scope: readonly ScopeEntry[], themeService: IThemeService, store: DisposableStore): { row: TerminalElement; twistie: TerminalElement; contents: TerminalElement } {
	const row = new MutableTerminalElement('div');
	const inner = new MutableTerminalElement('div');
	const twistie = new MutableTerminalElement('div');
	const contents = new MutableTerminalElement('div');
	row.className = LIST_ROW_CLASS;
	inner.className = 'monaco-tl-row';
	twistie.className = 'monaco-tl-twistie';
	contents.className = 'monaco-tl-contents';
	inner.append(twistie, contents);
	row.append(inner);

	let outer = row;
	for (const entry of [...scope].reverse()) {
		const wrapper = new MutableTerminalElement('div');
		if (typeof entry === 'string') {
			wrapper.className = entry;
		} else {
			store.add(entry(wrapper, themeService));
		}
		wrapper.append(outer);
		outer = wrapper;
	}

	return { row, twistie, contents };
}

/**
 * The 16px twistie box, as the two columns a terminal can spare for it. The *glyph* is this
 * fork's — upstream's is a codicon and there is no icon font here — but whether the box is drawn
 * at all is not: `views.css` takes it out for a `force-no-twistie` row, and that is a
 * `visibility: hidden` the style resolver already reads.
 */
export const TWISTIE = { collapsed: '▸ ', expanded: '▾ ', leaf: '  ' };

/**
 * What `AbstractTree` puts before a row's contents: `abstractTree.ts:437` computes
 * `indentSize = defaultIndent + (depth - 1) * indent` and `:483` pads the twistie by it, then
 * `renderTreeElement` puts `collapsible`, `collapsed` and the tree's `twistieAdditionalCssClass`
 * on the twistie for the sheets to read.
 *
 * The indent is padding on the twistie and survives its box being taken away, so it is a span of
 * its own here; the box itself is painted through the element, which is what lets `views.css`
 * remove it for the source control view's input and action button rows without a rule of ours.
 *
 * The one measurement that crosses is `workbench.tree.indent`, read here so every tree reads it
 * in one place. `defaultIndent` is a fixed pixel pad and is dropped with every other one.
 */
export class TwistiePainter extends Disposable {

	private readonly twistie: TerminalElement;

	/** `workbench.tree.indent`, in columns. */
	private indent: number;

	private readonly _onDidChangeIndent = this._register(new Emitter<void>());
	/** Fires when `workbench.tree.indent` changed, so the pane holding this can repaint. */
	readonly onDidChangeIndent: Event<void> = this._onDidChangeIndent.event;

	constructor(
		private readonly themeService: IThemeService,
		configurationService: IConfigurationService,
		scope: readonly ScopeEntry[] = []
	) {
		super();

		this.twistie = treeRow(scope, themeService, this._store).twistie;

		const read = () => indentColumns(configurationService.getValue<number>('workbench.tree.indent') ?? DEFAULT_TREE_INDENT);
		this.indent = read();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbench.tree.indent')) {
				this.indent = read();
				this._onDidChangeIndent.fire();
			}
		}));
	}

	/** The row's indent and twistie as spans. `additionalClass` is `twistieAdditionalCssClass`'s. */
	render(node: ITreeNode<unknown, unknown>, base: IStyle, additionalClass?: string): ISpan[] {
		return this.renderProjection(node.depth, node.collapsible, !node.collapsed, base, additionalClass);
	}

	/** The same projection from an immutable tree record rather than a live widget node. */
	renderProjection(depth: number, expandable: boolean, expanded: boolean, base: IStyle, additionalClass?: string): ISpan[] {
		const classes = ['monaco-tl-twistie'];
		if (expandable) {
			classes.push('collapsible');
			if (!expanded) {
				classes.push('collapsed');
			}
		}
		if (additionalClass) {
			classes.push(additionalClass);
		}
		this.twistie.className = classes.join(' ');
		this.twistie.textContent = expandable ? (expanded ? TWISTIE.expanded : TWISTIE.collapsed) : TWISTIE.leaf;

		const padding = ' '.repeat(this.indent * Math.max(0, depth - 1));
		const box = paint(this.twistie, this.themeService.getColorTheme(), base);

		return padding ? [{ ...base, text: padding }, ...box] : box;
	}
}
