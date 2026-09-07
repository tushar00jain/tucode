/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLinux } from '../../../../base/common/platform.js';
import type { IPatternInfo, ISearchConfigurationProperties } from '../../../services/search/common/search.js';
import type { ITextQueryBuilderOptions } from '../../../services/search/common/queryBuilder.js';

/** SearchView's query defaults. Widget-only filters remain explicit caller options. */
export function searchQueryOptions(content: IPatternInfo, config: ISearchConfigurationProperties,
	includePattern: ITextQueryBuilderOptions['includePattern'], excludePattern: ITextQueryBuilderOptions['excludePattern'],
	options: ITextQueryBuilderOptions = {}): ITextQueryBuilderOptions {
	return {
		_reason: 'searchView', maxResults: config.maxResults ?? undefined,
		ignoreGlobCase: !isLinux || undefined,
		// Regex replacements need the full match line to resolve capture groups (VS Code #58374).
		previewOptions: { matchLines: 1, charsPerLine: content.isRegExp ? 10000 : 1000 },
		isSmartCase: config.smartCase, includePattern, excludePattern, expandPatterns: true, ...options
	};
}
