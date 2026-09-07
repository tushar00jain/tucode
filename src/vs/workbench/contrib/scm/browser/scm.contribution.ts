/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ModesRegistry } from '../../../../editor/common/languages/modesRegistry.js';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ISCMService, ISCMViewService } from '../common/scm.js';
import { RepositoryPicker } from './scmViewService.js';

ModesRegistry.registerLanguage({
	id: 'scminput',
	extensions: [],
	aliases: [], // hide from language selector
	mimetypes: ['text/x-scm-input']
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'scm',
	order: 5,
	title: localize('scmConfigurationTitle', "Source Control"),
	type: 'object',
	scope: ConfigurationScope.RESOURCE,
	properties: {
		'scm.diffDecorations': {
			type: 'string',
			enum: ['all', 'gutter', 'overview', 'minimap', 'none'],
			enumDescriptions: [
				localize('scm.diffDecorations.all', "Show the diff decorations in all available locations."),
				localize('scm.diffDecorations.gutter', "Show the diff decorations only in the editor gutter."),
				localize('scm.diffDecorations.overviewRuler', "Show the diff decorations only in the overview ruler."),
				localize('scm.diffDecorations.minimap', "Show the diff decorations only in the minimap."),
				localize('scm.diffDecorations.none', "Do not show the diff decorations.")
			],
			default: 'all',
			description: localize('diffDecorations', "Controls diff decorations in the editor.")
		},
		'scm.diffDecorationsGutterWidth': {
			type: 'number',
			enum: [1, 2, 3, 4, 5],
			default: 3,
			description: localize('diffGutterWidth', "Controls the width(px) of diff decorations in gutter (added & modified).")
		},
		'scm.diffDecorationsGutterVisibility': {
			type: 'string',
			enum: ['always', 'hover'],
			enumDescriptions: [
				localize('scm.diffDecorationsGutterVisibility.always', "Show the diff decorator in the gutter at all times."),
				localize('scm.diffDecorationsGutterVisibility.hover', "Show the diff decorator in the gutter only on hover.")
			],
			description: localize('scm.diffDecorationsGutterVisibility', "Controls the visibility of the Source Control diff decorator in the gutter."),
			default: 'always'
		},
		'scm.diffDecorationsGutterAction': {
			type: 'string',
			enum: ['diff', 'none'],
			enumDescriptions: [
				localize('scm.diffDecorationsGutterAction.diff', "Show the inline diff Peek view on click."),
				localize('scm.diffDecorationsGutterAction.none', "Do nothing.")
			],
			description: localize('scm.diffDecorationsGutterAction', "Controls the behavior of Source Control diff gutter decorations."),
			default: 'diff'
		},
		'scm.diffDecorationsGutterPattern': {
			type: 'object',
			description: localize('diffGutterPattern', "Controls whether a pattern is used for the diff decorations in gutter."),
			additionalProperties: false,
			properties: {
				'added': {
					type: 'boolean',
					description: localize('diffGutterPatternAdded', "Use pattern for the diff decorations in gutter for added lines."),
				},
				'modified': {
					type: 'boolean',
					description: localize('diffGutterPatternModifed', "Use pattern for the diff decorations in gutter for modified lines."),
				},
			},
			default: {
				'added': false,
				'modified': true
			}
		},
		'scm.diffDecorationsIgnoreTrimWhitespace': {
			type: 'string',
			enum: ['true', 'false', 'inherit'],
			enumDescriptions: [
				localize('scm.diffDecorationsIgnoreTrimWhitespace.true', "Ignore leading and trailing whitespace."),
				localize('scm.diffDecorationsIgnoreTrimWhitespace.false', "Do not ignore leading and trailing whitespace."),
				localize('scm.diffDecorationsIgnoreTrimWhitespace.inherit', "Inherit from `diffEditor.ignoreTrimWhitespace`.")
			],
			description: localize('diffDecorationsIgnoreTrimWhitespace', "Controls whether leading and trailing whitespace is ignored in Source Control diff gutter decorations."),
			default: 'false'
		},
		'scm.alwaysShowActions': {
			type: 'boolean',
			description: localize('alwaysShowActions', "Controls whether inline actions are always visible in the Source Control view."),
			default: false
		},
		'scm.countBadge': {
			type: 'string',
			enum: ['all', 'focused', 'off'],
			enumDescriptions: [
				localize('scm.countBadge.all', "Show the sum of all Source Control Provider count badges."),
				localize('scm.countBadge.focused', "Show the count badge of the focused Source Control Provider."),
				localize('scm.countBadge.off', "Disable the Source Control count badge.")
			],
			description: localize('scm.countBadge', "Controls the count badge on the Source Control icon on the Activity Bar."),
			default: 'all'
		},
		'scm.providerCountBadge': {
			type: 'string',
			enum: ['hidden', 'auto', 'visible'],
			enumDescriptions: [
				localize('scm.providerCountBadge.hidden', "Hide Source Control Provider count badges."),
				localize('scm.providerCountBadge.auto', "Only show count badge for Source Control Provider when non-zero."),
				localize('scm.providerCountBadge.visible', "Show Source Control Provider count badges.")
			],
			markdownDescription: localize('scm.providerCountBadge', "Controls the count badges on Source Control Provider headers. These headers appear in the Source Control view when there is more than one provider or when the {0} setting is enabled, and in the Source Control Repositories view.", '\`#scm.alwaysShowRepositories#\`'),
			default: 'hidden'
		},
		'scm.defaultViewMode': {
			type: 'string',
			enum: ['tree', 'list'],
			enumDescriptions: [
				localize('scm.defaultViewMode.tree', "Show the repository changes as a tree."),
				localize('scm.defaultViewMode.list', "Show the repository changes as a list.")
			],
			description: localize('scm.defaultViewMode', "Controls the default Source Control repository view mode."),
			default: 'list'
		},
		'scm.defaultViewSortKey': {
			type: 'string',
			enum: ['name', 'path', 'status'],
			enumDescriptions: [
				localize('scm.defaultViewSortKey.name', "Sort the repository changes by file name."),
				localize('scm.defaultViewSortKey.path', "Sort the repository changes by path."),
				localize('scm.defaultViewSortKey.status', "Sort the repository changes by Source Control status.")
			],
			description: localize('scm.defaultViewSortKey', "Controls the default Source Control repository changes sort order when viewed as a list."),
			default: 'path'
		},
		'scm.autoReveal': {
			type: 'boolean',
			description: localize('autoReveal', "Controls whether the Source Control view should automatically reveal and select files when opening them."),
			default: true
		},
		'scm.inputFontFamily': {
			type: 'string',
			markdownDescription: localize('inputFontFamily', "Controls the font for the input message. Use `default` for the workbench user interface font family, `editor` for the `#editor.fontFamily#`'s value, or a custom font family."),
			default: 'default'
		},
		'scm.inputFontSize': {
			type: 'number',
			markdownDescription: localize('inputFontSize', "Controls the font size for the input message in pixels."),
			default: 13
		},
		'scm.inputMaxLineCount': {
			type: 'number',
			markdownDescription: localize('inputMaxLines', "Controls the maximum number of lines that the input will auto-grow to."),
			minimum: 1,
			maximum: 50,
			default: 10
		},
		'scm.inputMinLineCount': {
			type: 'number',
			markdownDescription: localize('inputMinLines', "Controls the minimum number of lines that the input will auto-grow from."),
			minimum: 1,
			maximum: 50,
			default: 1
		},
		'scm.alwaysShowRepositories': {
			type: 'boolean',
			markdownDescription: localize('alwaysShowRepository', "Controls whether repositories should always be visible in the Source Control view."),
			default: false
		},
		'scm.repositories.sortOrder': {
			type: 'string',
			enum: ['discovery time', 'name', 'path'],
			enumDescriptions: [
				localize('scm.repositoriesSortOrder.discoveryTime', "Repositories in the Source Control Repositories view are sorted by discovery time. Repositories in the Source Control view are sorted in the order that they were selected."),
				localize('scm.repositoriesSortOrder.name', "Repositories in the Source Control Repositories and Source Control views are sorted by repository name."),
				localize('scm.repositoriesSortOrder.path', "Repositories in the Source Control Repositories and Source Control views are sorted by repository path.")
			],
			description: localize('repositoriesSortOrder', "Controls the sort order of the repositories in the source control repositories view."),
			default: 'discovery time'
		},
		'scm.repositories.visible': {
			type: 'number',
			description: localize('providersVisible', "Controls how many repositories are visible in the Source Control Repositories section. Set to 0, to be able to manually resize the view."),
			default: 10
		},
		'scm.repositories.selectionMode': {
			type: 'string',
			enum: ['multiple', 'single'],
			enumDescriptions: [
				localize('scm.repositories.selectionMode.multiple', "Multiple repositories can be selected at the same time."),
				localize('scm.repositories.selectionMode.single', "Only one repository can be selected at a time.")
			],
			description: localize('scm.repositories.selectionMode', "Controls the selection mode of the repositories in the Source Control Repositories view."),
			default: 'multiple'
		},
		'scm.repositories.explorer': {
			type: 'boolean',
			markdownDescription: localize('scm.repositories.explorer', "Controls whether to show repository artifacts in the Source Control Repositories view. This feature is experimental and only works when {0} is set to `{1}`.", '\`#scm.repositories.selectionMode#\`', 'single'),
			default: false,
			tags: ['experimental']
		},
		'scm.showActionButton': {
			type: 'boolean',
			markdownDescription: localize('showActionButton', "Controls whether an action button can be shown in the Source Control view."),
			default: true
		},
		'scm.showInputActionButton': {
			type: 'boolean',
			markdownDescription: localize('showInputActionButton', "Controls whether an action button can be shown in the Source Control input."),
			default: true
		},
		'scm.workingSets.enabled': {
			type: 'boolean',
			description: localize('scm.workingSets.enabled', "Controls whether to store editor working sets when switching between source control history item groups."),
			default: false
		},
		'scm.workingSets.default': {
			type: 'string',
			enum: ['empty', 'current'],
			enumDescriptions: [
				localize('scm.workingSets.default.empty', "Use an empty working set when switching to a source control history item group that does not have a working set."),
				localize('scm.workingSets.default.current', "Use the current working set when switching to a source control history item group that does not have a working set.")
			],
			description: localize('scm.workingSets.default', "Controls the default working set to use when switching to a source control history item group that does not have a working set."),
			default: 'current'
		},
		'scm.compactFolders': {
			type: 'boolean',
			description: localize('scm.compactFolders', "Controls whether the Source Control view should render folders in a compact form. In such a form, single child folders will be compressed in a combined tree element."),
			default: true
		},
		'scm.graph.pageOnScroll': {
			type: 'boolean',
			description: localize('scm.graph.pageOnScroll', "Controls whether the Source Control Graph view will load the next page of items when you scroll to the end of the list."),
			default: true
		},
		'scm.graph.pageSize': {
			type: 'number',
			description: localize('scm.graph.pageSize', "The number of items to show in the Source Control Graph view by default and when loading more items."),
			minimum: 1,
			maximum: 1000,
			default: 50
		},
		'scm.graph.badges': {
			type: 'string',
			enum: ['all', 'filter'],
			enumDescriptions: [
				localize('scm.graph.badges.all', "Show badges of all history item groups in the Source Control Graph view."),
				localize('scm.graph.badges.filter', "Show only the badges of history item groups used as a filter in the Source Control Graph view.")
			],
			description: localize('scm.graph.badges', "Controls which badges are shown in the Source Control Graph view. The badges are shown on the right side of the graph indicating the names of history item groups."),
			default: 'filter'
		},
		'scm.graph.showIncomingChanges': {
			type: 'boolean',
			description: localize('scm.graph.showIncomingChanges', "Controls whether to show incoming changes in the Source Control Graph view."),
			default: true
		},
		'scm.graph.showOutgoingChanges': {
			type: 'boolean',
			description: localize('scm.graph.showOutgoingChanges', "Controls whether to show outgoing changes in the Source Control Graph view."),
			default: true
		}
	}
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'scm.acceptInput',
	metadata: { description: localize('scm accept', "Source Control: Accept Input"), args: [] },
	weight: KeybindingWeight.WorkbenchContrib,
	when: ContextKeyExpr.has('scmRepository'),
	primary: KeyMod.CtrlCmd | KeyCode.Enter,
	handler: accessor => {
		const contextKeyService = accessor.get(IContextKeyService);
		const context = contextKeyService.getContext(getActiveElement());
		const repositoryId = context.getValue<string | undefined>('scmRepository');

		if (!repositoryId) {
			return Promise.resolve(null);
		}

		const scmService = accessor.get(ISCMService);
		const repository = scmService.getRepository(repositoryId);

		if (!repository?.provider.acceptInputCommand) {
			return Promise.resolve(null);
		}

		const id = repository.provider.acceptInputCommand.id;
		const args = repository.provider.acceptInputCommand.arguments;
		const commandService = accessor.get(ICommandService);

		return commandService.executeCommand(id, ...(args || []));
	}
});

CommandsRegistry.registerCommand('scm.setActiveProvider', async (accessor) => {
	const instantiationService = accessor.get(IInstantiationService);
	const scmViewService = accessor.get(ISCMViewService);

	const placeHolder = localize('scmActiveRepositoryPlaceHolder', "Select the active repository, type to filter all repositories");
	const autoQuickItemDescription = localize('scmActiveRepositoryAutoDescription', "The active repository is updated based on active editor");
	const repositoryPicker = instantiationService.createInstance(RepositoryPicker, placeHolder, autoQuickItemDescription);

	const result = await repositoryPicker.pickRepository();
	if (result?.repository) {
		const repository = result.repository !== 'auto' ? result.repository : undefined;
		scmViewService.pinActiveRepository(repository);
	}
});
