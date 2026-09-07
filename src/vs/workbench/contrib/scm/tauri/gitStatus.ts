/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ColorIdentifier, registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { GitStatus } from './scmIpc.js';

/**
 * The per-status tables of `Resource` in `extensions/git/src/repository.ts`, and the
 * `gitDecoration.*` colours that extension contributes from its `package.json`. Both live
 * here because this port has no extension host to contribute either: the colour ids and
 * their four theme values are upstream's, so a theme that styles VS Code's git decorations
 * styles ours.
 *
 * The status *letter* is deliberately absent — `tscode_git` already ports
 * `Resource.getStatusLetter` and puts the result on the wire, so there is one table, in Rust.
 */

const gitDecorationAddedResourceForeground = registerColor('gitDecoration.addedResourceForeground',
	{ light: '#587c0c', dark: '#81b88b', hcDark: '#a1e3ad', hcLight: '#374e06' },
	localize('gitDecoration.addedResourceForeground', "Color for added Git resources. Used for file labels and the SCM viewlet."));

const gitDecorationModifiedResourceForeground = registerColor('gitDecoration.modifiedResourceForeground',
	{ light: '#895503', dark: '#E2C08D', hcDark: '#E2C08D', hcLight: '#895503' },
	localize('gitDecoration.modifiedResourceForeground', "Color for modified Git resources. Used for file labels and the SCM viewlet."));

const gitDecorationDeletedResourceForeground = registerColor('gitDecoration.deletedResourceForeground',
	{ light: '#ad0707', dark: '#c74e39', hcDark: '#c74e39', hcLight: '#ad0707' },
	localize('gitDecoration.deletedResourceForeground', "Color for deleted Git resources. Used for file labels and the SCM viewlet."));

const gitDecorationRenamedResourceForeground = registerColor('gitDecoration.renamedResourceForeground',
	{ light: '#007100', dark: '#73C991', hcDark: '#73C991', hcLight: '#007100' },
	localize('gitDecoration.renamedResourceForeground', "Color for renamed or copied Git resources. Used for file labels and the SCM viewlet."));

const gitDecorationUntrackedResourceForeground = registerColor('gitDecoration.untrackedResourceForeground',
	{ light: '#007100', dark: '#73C991', hcDark: '#73C991', hcLight: '#007100' },
	localize('gitDecoration.untrackedResourceForeground', "Color for untracked Git resources. Used for file labels and the SCM viewlet."));

const gitDecorationIgnoredResourceForeground = registerColor('gitDecoration.ignoredResourceForeground',
	{ light: '#8E8E90', dark: '#8C8C8C', hcDark: '#A7A8A9', hcLight: '#8e8e90' },
	localize('gitDecoration.ignoredResourceForeground', "Color for ignored Git resources. Used for file labels and the SCM viewlet."));

const gitDecorationStageModifiedResourceForeground = registerColor('gitDecoration.stageModifiedResourceForeground',
	{ light: '#895503', dark: '#E2C08D', hcDark: '#E2C08D', hcLight: '#895503' },
	localize('gitDecoration.stageModifiedResourceForeground', "Color for modified resources which have been staged. Used for file labels and the SCM viewlet."));

const gitDecorationStageDeletedResourceForeground = registerColor('gitDecoration.stageDeletedResourceForeground',
	{ light: '#ad0707', dark: '#c74e39', hcDark: '#c74e39', hcLight: '#ad0707' },
	localize('gitDecoration.stageDeletedResourceForeground', "Color for deleted resources which have been staged. Used for file labels and the SCM viewlet."));

const gitDecorationConflictingResourceForeground = registerColor('gitDecoration.conflictingResourceForeground',
	{ light: '#ad0707', dark: '#e4676b', hcDark: '#c74e39', hcLight: '#ad0707' },
	localize('gitDecoration.conflictingResourceForeground', "Color for resources with conflicts. Used for file labels and the SCM viewlet."));

registerColor('gitDecoration.submoduleResourceForeground',
	{ light: '#1258a7', dark: '#8db9e2', hcDark: '#8db9e2', hcLight: '#1258a7' },
	localize('gitDecoration.submoduleResourceForeground', "Color for submodule resources."));

/** Port of `Resource.getStatusText`. */
export function getStatusText(status: GitStatus): string {
	switch (status) {
		case GitStatus.IndexModified: return localize('git.status.indexModified', "Index Modified");
		case GitStatus.Modified: return localize('git.status.modified', "Modified");
		case GitStatus.IndexAdded: return localize('git.status.indexAdded', "Index Added");
		case GitStatus.IndexDeleted: return localize('git.status.indexDeleted', "Index Deleted");
		case GitStatus.Deleted: return localize('git.status.deleted', "Deleted");
		case GitStatus.IndexRenamed: return localize('git.status.indexRenamed', "Index Renamed");
		case GitStatus.IndexCopied: return localize('git.status.indexCopied', "Index Copied");
		case GitStatus.Untracked: return localize('git.status.untracked', "Untracked");
		case GitStatus.Ignored: return localize('git.status.ignored', "Ignored");
		case GitStatus.IntentToAdd: return localize('git.status.intentToAdd', "Intent to Add");
		case GitStatus.IntentToRename: return localize('git.status.intentToRename', "Intent to Rename");
		case GitStatus.TypeChanged: return localize('git.status.typeChanged', "Type Changed");
		case GitStatus.BothDeleted: return localize('git.status.bothDeleted', "Conflict: Both Deleted");
		case GitStatus.AddedByUs: return localize('git.status.addedByUs', "Conflict: Added By Us");
		case GitStatus.DeletedByThem: return localize('git.status.deletedByThem', "Conflict: Deleted By Them");
		case GitStatus.AddedByThem: return localize('git.status.addedByThem', "Conflict: Added By Them");
		case GitStatus.DeletedByUs: return localize('git.status.deletedByUs', "Conflict: Deleted By Us");
		case GitStatus.BothAdded: return localize('git.status.bothAdded', "Conflict: Both Added");
		case GitStatus.BothModified: return localize('git.status.bothModified', "Conflict: Both Modified");
	}
}

/** Port of `Resource.getStatusColor`. */
export function getStatusColor(status: GitStatus): ColorIdentifier {
	switch (status) {
		case GitStatus.IndexModified:
			return gitDecorationStageModifiedResourceForeground;
		case GitStatus.Modified:
		case GitStatus.TypeChanged:
			return gitDecorationModifiedResourceForeground;
		case GitStatus.IndexDeleted:
			return gitDecorationStageDeletedResourceForeground;
		case GitStatus.Deleted:
			return gitDecorationDeletedResourceForeground;
		case GitStatus.IndexAdded:
		case GitStatus.IntentToAdd:
			return gitDecorationAddedResourceForeground;
		case GitStatus.IndexCopied:
		case GitStatus.IndexRenamed:
		case GitStatus.IntentToRename:
			return gitDecorationRenamedResourceForeground;
		case GitStatus.Untracked:
			return gitDecorationUntrackedResourceForeground;
		case GitStatus.Ignored:
			return gitDecorationIgnoredResourceForeground;
		case GitStatus.BothDeleted:
		case GitStatus.AddedByUs:
		case GitStatus.DeletedByThem:
		case GitStatus.AddedByThem:
		case GitStatus.DeletedByUs:
		case GitStatus.BothAdded:
		case GitStatus.BothModified:
			return gitDecorationConflictingResourceForeground;
	}
}

/**
 * The shape of `Resource.getIconPath`, resolved to codicons. Upstream ships one SVG per
 * status per theme inside the git extension; this port has no extension to carry them, so
 * each maps to the closest `diff-*` codicon, which themes style through the icon font.
 */
export function getStatusIcon(status: GitStatus): ThemeIcon {
	switch (status) {
		case GitStatus.IndexModified:
		case GitStatus.Modified:
		case GitStatus.TypeChanged:
			return ThemeIcon.fromId('diff-modified');
		case GitStatus.IndexAdded:
		case GitStatus.IntentToAdd:
			return ThemeIcon.fromId('diff-added');
		case GitStatus.IndexDeleted:
		case GitStatus.Deleted:
			return ThemeIcon.fromId('diff-removed');
		case GitStatus.IndexRenamed:
		case GitStatus.IndexCopied:
		case GitStatus.IntentToRename:
			return ThemeIcon.fromId('diff-renamed');
		case GitStatus.Untracked:
			return ThemeIcon.fromId('diff-added');
		case GitStatus.Ignored:
			return ThemeIcon.fromId('diff-ignored');
		case GitStatus.BothDeleted:
		case GitStatus.AddedByUs:
		case GitStatus.DeletedByThem:
		case GitStatus.AddedByThem:
		case GitStatus.DeletedByUs:
		case GitStatus.BothAdded:
		case GitStatus.BothModified:
			return ThemeIcon.fromId('warning');
	}
}

/** Port of `Resource.strikeThrough`. */
export function isStrikeThrough(status: GitStatus): boolean {
	switch (status) {
		case GitStatus.Deleted:
		case GitStatus.BothDeleted:
		case GitStatus.DeletedByThem:
		case GitStatus.DeletedByUs:
		case GitStatus.IndexDeleted:
			return true;
		default:
			return false;
	}
}

/**
 * Port of `Resource.resourceDecoration`'s `propagate`: a deleted file's badge must not
 * bubble up to its parent folders, because the folder itself is not deleted.
 */
export function propagatesToParents(status: GitStatus): boolean {
	return status !== GitStatus.Deleted && status !== GitStatus.IndexDeleted;
}
