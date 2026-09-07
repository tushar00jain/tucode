import type { AsyncDataTree } from '../../vs/base/browser/ui/tree/asyncDataTree.js';
import type { ITreeNode } from '../../vs/base/browser/ui/tree/tree.js';
import type { FuzzyScore } from '../../vs/base/common/filters.js';
import type { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import type { ViewPane } from '../../vs/workbench/browser/parts/views/viewPane.js';
import type { TerminalElement } from '../terminal/dom/document.js';
import { paint, TwistiePainter, type IStyle, type ScopeEntry } from '../terminal/dom/paint.js';
import type { IMouse, IKey } from '../terminal/input.js';
import type { ILine } from '../terminal/screen.js';
import { Pane, TREE_NAVIGATION_HINT } from './pane.js';
import { toBrowserKeyboardEvent } from './keyboard.js';
import { editValue } from '../../input/editValue.js';
import { filterHeader } from '../views/viewRoot.js';
import { INPUT_EDITING_HINT } from './inputBox.js';
import type { IViewRoot } from '../../vs/workbench/browser/tauri/viewRootController.js';

/** Terminal transport and repaint wiring for an existing VS Code tree, not a tree controller. */
export abstract class TreePane<TInput, T, TFilterData = FuzzyScore> extends Pane {
	protected abstract readonly view: ViewPane;
	protected abstract readonly tree: AsyncDataTree<TInput, T, TFilterData>;
	protected abstract readonly container: TerminalElement;
	protected abstract get treeHeight(): number;
	protected abstract get rootController(): IViewRoot & { query: string | undefined; rootPath: string; whenSettled(): Promise<void> };
	override keybindingTarget(): HTMLElement {
		if (this.activeInput) { return this.activeInput as unknown as HTMLElement; }
		this.tree.domFocus();
		return this.tree.getHTMLElement();
	}
	override get hint(): string { return this.editing ? INPUT_EDITING_HINT : TREE_NAVIGATION_HINT; }
	override get filtering(): boolean { return this.rootController.query !== undefined; }
	override get editing(): boolean { return !!this.activeInput; }
	override get textInputValue(): string | undefined { return this.activeInput?.value; }
	override setTextInputValue(value: string): boolean {
		const input = this.activeInput;
		if (!input) { return false; }
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		this.trackRoot();
		return true;
	}
	override setEditing(editing: boolean): boolean {
		if (editing || !this.filtering) { return false; }
		this.rootController.cancel(); this.trackRoot();
		return true;
	}
	override completeFilter(delta: number): void { this.rootController.complete(delta); this.trackRoot(); }
	override header(): ILine[] { return filterHeader(this.themeService.getColorTheme(), this.rootController.rootPath.replace(/\/$/, ''), this.rootController.query); }
	protected get activeInput(): (TerminalElement & { value: string }) | undefined {
		const active = document.activeElement as unknown as (TerminalElement & { value: string }) | null;
		return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && this.container.contains(active) ? active : undefined;
	}
	protected trackRoot(): void { this.track(this.rootController.whenSettled().then(() => this.didChangeRows())); this.repaint(); }
	/** Deliver an unbound terminal key to the real DOM widget; its listeners own the meaning. */
	override handleKey(key: IKey): boolean {
		if (this.activeInput) {
			const edited = editValue(key, this.activeInput.value);
			if (edited !== undefined) { return this.setTextInputValue(edited); }
		}
		const event = toBrowserKeyboardEvent(key);
		if (!event) { return false; }
		const consumed = !this.keybindingTarget().dispatchEvent(event);
		if (this.filtering || consumed) { this.trackRoot(); }
		return consumed;
	}
	protected readonly nodes: ITreeNode<T, TFilterData>[] = [];
	protected twistie!: TwistiePainter;
	private pressedTarget: TerminalElement | undefined;

	/** Called after the upstream view has rendered and the native painter is ready. */
	protected bindTree(configurationService: IConfigurationService, iconScope: readonly ScopeEntry[]): void {
		this.twistie = this._register(new TwistiePainter(this.themeService, configurationService, iconScope));
		this._register(this.twistie.onDidChangeIndent(() => this.repaint()));

		// Acknowledge terminal input after upstream work, including expansion from list commands.
		const expand = this.tree.expand;
		this.tree.expand = (...args) => { const work = expand.apply(this.tree, args); this.track(work); return work; };
		const updateChildren = this.tree.updateChildren;
		this.tree.updateChildren = (...args) => { const work = updateChildren.apply(this.tree, args); this.track(work); return work; };
		this._register({ dispose: () => { this.tree.expand = expand; this.tree.updateChildren = updateChildren; } });

		this._register(this.tree.onDidSpliceRenderedNodes(({ start, deleteCount, elements }) => {
			this.nodes.splice(start, deleteCount, ...elements);
			this.didChangeRows();
		}));
		this._register(this.tree.onDidChangeFocus(change => {
			const focused = change.elements[0];
			const index = focused ? this.nodes.findIndex(node => node.element === focused) : -1;
			if (index >= 0) { this.focusTo(index); }
			else { this.repaint(); }
		}));
		this._register(this.tree.onDidChangeSelection(() => this.repaint()));
		this._register(this.tree.onDidChangeCollapseState(() => this.repaint()));
		this._register(this.paneChromeProjection.onDidSnapshot(snapshot => {
			if (snapshot.focused && !this.editing) { this.tree.domFocus(); }
		}));
	}

	get title(): string { return this.view.title; }
	get rowCount(): number { return this.nodes.length; }
	protected override isRowFocused(index: number): boolean {
		return this.tree.getFocus().includes(this.nodes[index]?.element);
	}

	protected renderRow(index: number, focused: boolean): ILine {
		const contents = this.rowElement(index)?.querySelector('.monaco-tl-contents');
		const node = this.nodes[index];
		return contents && node ? this.paintTreeRow(node, contents, this.rowStyle(index, focused)) : [];
	}

	protected paintTreeRow(node: ITreeNode<T, TFilterData>, contents: TerminalElement, style: IStyle): ILine {
		return [...this.twistie.render(node, style), ...paint(contents, this.themeService.getColorTheme(), style)];
	}

	override layout(height: number, width?: number): ILine[] {
		if (width !== undefined) { this.view.orthogonalSize = width * 4; }
		this.view.layout(this.treeHeight);
		return super.layout(height, width);
	}

	protected rowElement(index: number): TerminalElement | undefined {
		return this.container.querySelectorAll('.monaco-list-row')
			.find(element => element.getAttribute('data-index') === String(index));
	}

	override handleMouse(mouse: IMouse, top: number): boolean {
		if (mouse.kind === 'wheelUp' || mouse.kind === 'wheelDown') {
			return super.handleMouse(mouse, top);
		}
		const index = this.rowIndexAt(mouse.row, top);
		const target = index < 0 ? undefined : this.rowElement(index)?.querySelector('.monaco-tl-contents') ?? undefined;
		if (mouse.kind === 'down') {
			if (!target) { return false; }
			this.tree.domFocus();
			this.pressedTarget = target;
			target.dispatchEvent(new MouseEvent('mousedown', {
				bubbles: true, cancelable: true, detail: 1, button: 0, buttons: 1, shiftKey: !!mouse.shift
			}));
			return true;
		}
		const pressed = this.pressedTarget;
		this.pressedTarget = undefined;
		if (!pressed) { return false; }
		pressed.dispatchEvent(new MouseEvent('mouseup', {
			bubbles: true, cancelable: true, detail: 1, button: 0, buttons: 0, shiftKey: !!mouse.shift
		}));
		if (pressed === target) {
			pressed.dispatchEvent(new MouseEvent('click', {
				bubbles: true, cancelable: true, detail: 1, button: 0, buttons: 0, shiftKey: !!mouse.shift
			}));
		}
		return true;
	}
}
