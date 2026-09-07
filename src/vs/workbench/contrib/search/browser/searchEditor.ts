/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import type { URI } from '../../../../base/common/uri.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { FileMatchOrMatch, ISearchModel, ISearchTreeMatch, isSearchTreeMatch, isSearchTreeFileMatch } from './searchTreeModel/searchTreeCommon.js';

/** Open and highlight a result through the same editor service on every frontend. */
export async function openSearchEditor(editors: IEditorService, model: ISearchModel, element: FileMatchOrMatch,
	options: { preserveFocus?: boolean; pinned?: boolean; sideBySide?: boolean; resource?: URI } = {}) {
	const editor = await editors.openEditor({
		resource: options.resource ?? (isSearchTreeMatch(element) ? element.parent().resource : element.resource),
		options: { preserveFocus: options.preserveFocus, pinned: options.pinned,
			selection: getEditorSelectionFromMatch(element, model), revealIfVisible: true }
	}, options.sideBySide ? SIDE_GROUP : ACTIVE_GROUP);
	const control = editor?.getControl();
	const highlights = model.searchResult.getRangeHighlightDecorations();
	if (isSearchTreeMatch(element) && options.preserveFocus && isCodeEditor(control)) {
		highlights.highlightRange(control.getModel()!, element.range());
	} else {
		highlights.removeHighlightRange();
	}
	return editor;
}

export function getEditorSelectionFromMatch(element: FileMatchOrMatch, viewModel: ISearchModel) {
	let match: ISearchTreeMatch | null = null;
	if (isSearchTreeMatch(element)) {
		match = element;
	}
	if (isSearchTreeFileMatch(element) && element.count() > 0) {
		match = element.matches()[element.matches().length - 1];
	}
	if (match) {
		const range = match.range();
		if (viewModel.isReplaceActive() && !!viewModel.replaceString) {
			const replaceString = match.replaceString;
			return {
				startLineNumber: range.startLineNumber,
				startColumn: range.startColumn,
				endLineNumber: range.startLineNumber,
				endColumn: range.startColumn + replaceString.length
			};
		}
		return range;
	}
	return undefined;
}
