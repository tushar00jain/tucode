/*---------------------------------------------------------------------------------------------
 * The stock VS Code SCM view, painted into terminal cells.
 *
 * SCMViewPane owns the model, tree widget, rendering, focus, selection, expansion and commands.
 * This class supplies only terminal layout, DOM-to-cell painting and input-event transport.
 * Upstream counterpart: src/vs/workbench/contrib/scm/browser/scmViewPane.ts
 *--------------------------------------------------------------------------------------------*/

import '../../vs/workbench/contrib/scm/browser/media/scm.css';
import './media/scm.css';

import type { ITreeNode } from '../../vs/base/browser/ui/tree/tree.js';
import type { FuzzyScore } from '../../vs/base/common/filters.js';
import { KeyCode } from '../../vs/base/common/keyCodes.js';
import { localize } from '../../vs/nls.js';
import { TerminalSCMInput } from './scmInput.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../vs/platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { ISCMViewService, VIEW_PANE_ID } from '../../vs/workbench/contrib/scm/common/scm.js';
import type { TreeElement } from '../../vs/workbench/contrib/scm/browser/scmViewPane.js';
import { SCMViewPane } from '../../vs/workbench/contrib/scm/browser/scmViewPane.js';
import type { TauriGitContribution } from '../../vs/workbench/contrib/scm/tauri/git.contribution.js';
import { ICommandService } from '../../vs/platform/commands/common/commands.js';
import { isSCMInput, isSCMActionButton } from '../../vs/workbench/contrib/scm/browser/util.js';
import { toggleSCMViewMode, cycleSCMViewSortKey, scmResourceCommandArguments } from '../../vs/workbench/contrib/scm/tauri/scmViewCommands.js';
import { TerminalElement } from '../terminal/dom/document.js';
import { paint, type IStyle } from '../terminal/dom/paint.js';
import type { ILine } from '../terminal/screen.js';
import { registerPaneCommand, registerTuiCommand, registerTuiKeybinding, commandTitle } from '../workbench/commands.js';
import { TreePane } from '../workbench/treePane.js';
import { ContextKeyExpr } from '../../vs/platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../vs/platform/contextkey/common/contextkeys.js';
import { FocusedViewContext } from '../../vs/workbench/common/contextkeys.js';
import { inputSpans } from '../workbench/inputBox.js';
import { descriptionForeground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { Registry } from '../../vs/platform/registry/common/platform.js';
import { Extensions, IConfigurationRegistry } from '../../vs/platform/configuration/common/configurationRegistry.js';
import type { IPaneContextMenu } from '../workbench/pane.js';

// Keep the terminal's existing count badges through the upstream view's configurable policy.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([
	{ overrides: { 'scm.providerCountBadge': 'visible' } }
]);

export class SCMPane extends TreePane<ISCMViewService, TreeElement> {
	readonly viewId = VIEW_PANE_ID;
	protected readonly view: SCMViewPane;
	protected readonly tree: SCMViewPane['treeWidget'];
	protected readonly container: TerminalElement;

	constructor(
		private readonly git: TauriGitContribution,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService
	) {
		super(themeService);
		this.view = this._register(instantiationService.createInstance(SCMViewPane, {
			createInputWidget: container => instantiationService.createInstance(TerminalSCMInput, container),
			id: VIEW_PANE_ID,
			title: localize('scm', "Source Control"),
			expanded: true
		}));
		this.view.headerVisible = false;
		this.view.render();
		this.tree = this.view.treeWidget;
		// Terminal row clicks select; Left/Right remain the expansion gestures. The stock
		// controller implements that distinction through this option.
		this.tree.updateOptions({ expandOnlyOnTwistieClick: true });
		this._register(registerPaneCommand(VIEW_PANE_ID, {
			id: 'tscode.scm.toggleViewMode', title: 'List/Tree', primary: KeyCode.KeyV,
			handler: () => toggleSCMViewMode(this.view)
		}));
		this._register(registerPaneCommand(VIEW_PANE_ID, {
			id: 'tscode.scm.cycleSortKey', title: 'Sort By', primary: KeyCode.KeyS,
			handler: () => cycleSCMViewSortKey(this.view)
		}));
		this._register(registerPaneCommand(VIEW_PANE_ID, {
			id: 'tscode.scm.stage', title: 'Stage Changes', primary: KeyCode.KeyA,
			handler: () => this.track(this.commandService.executeCommand('git.stage', ...scmResourceCommandArguments(this.tree.getFocus())))
		}));
		this._register(registerPaneCommand(VIEW_PANE_ID, {
			id: 'tscode.scm.unstage', title: 'Unstage Changes', primary: KeyCode.KeyU,
			handler: () => this.track(this.commandService.executeCommand('git.unstage', ...scmResourceCommandArguments(this.tree.getFocus())))
		}));
		this._register(registerPaneCommand(VIEW_PANE_ID, {
			id: 'tscode.scm.refresh', title: 'Refresh', primary: KeyCode.KeyR,
			handler: () => this.track(this.commandService.executeCommand('git.refresh'))
		}));
		this._register(registerPaneCommand(VIEW_PANE_ID, {
			id: 'tscode.scm.filter', title: 'Filter', primary: KeyCode.Slash,
			handler: () => { this.view.rootController.open(); this.trackRoot(); }
		}));
		this._register(registerTuiKeybinding('scm.setActiveProvider', KeyCode.KeyP,
			ContextKeyExpr.and(FocusedViewContext.isEqualTo(this.viewId), InputFocusedContext.negate()), undefined, 'pane'));
		this._register(registerTuiCommand({
			id: 'tscode.scm.acceptInput', title: commandTitle('scm.acceptInput') ?? 'Accept Input', primary: KeyCode.Enter,
			when: ContextKeyExpr.and(FocusedViewContext.isEqualTo(this.viewId), InputFocusedContext, ContextKeyExpr.has('scmRepository')),
			scope: 'pane', handler: () => this.track(this.commandService.executeCommand('scm.acceptInput'))
		}));
		this.container = this.view.element as unknown as TerminalElement;
		this.container.classList.add('terminal-scm');
		this.bindTree(configurationService, ['scm-view', 'show-file-icons', 'file-icon-themable-tree']);
	}

	protected get treeHeight(): number { return Math.max(1, this.rowCount) * 36 + this.view.rootController.height; }
	protected get rootController() { return this.view.rootController; }
	override async open(): Promise<void> { await this.git.whenDiscovered; this.view.setVisible(true); await this.view.whenSettled(); }
	override get canEdit(): boolean { const element = this.tree.getFocus()[0]; return !!element && isSCMInput(element); }
	override setEditing(editing: boolean): boolean {
		if (!editing) {
			if (this.filtering) { this.view.rootController.cancel(); this.trackRoot(); }
			else { this.tree.domFocus(); this.repaint(); }
			return true;
		}
		if (!this.canEdit) { return false; }
		this.rowElement(this.focus)?.querySelector('input')?.focus();
		this.repaint();
		return true;
	}
	override get hasContextMenu(): boolean {
		const element = this.tree.getFocus()[0];
		return !!element && !isSCMInput(element) && !isSCMActionButton(element);
	}
	override contextMenu(): IPaneContextMenu | undefined {
		this.rowElement(this.focus)?.querySelector('.monaco-tl-contents')?.dispatchEvent(new MouseEvent('contextmenu', {
			bubbles: true, cancelable: true, button: 2
		}));
		return undefined;
	}

	protected override paintTreeRow(node: ITreeNode<TreeElement, FuzzyScore>, contents: TerminalElement, style: IStyle): ILine {
		const element = node.element;
		const additional = isSCMInput(element) || isSCMActionButton(element) ? 'force-no-twistie' : undefined;
		const body = isSCMInput(element)
			? inputSpans(element.value, element.placeholder, this.editing && node === this.nodes[this.focus], {
				fg: style.fg, bg: style.bg, placeholderFg: this.themeService.getColorTheme().getColor(descriptionForeground)
			})
			: paint(contents, this.themeService.getColorTheme(), style);
		return [...this.twistie.render(node, style, additional), ...body];
	}
}
