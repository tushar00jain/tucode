/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * The scheme the diff editor's left-hand side and the quick diff baseline are addressed by.
 * A port of `extensions/git/src/uri.ts`, minus the submodule options this port does not use:
 * the ref spellings, the `.git` extension replacement and the JSON-in-`query` encoding are
 * upstream's, because upstream's `scm/change/title` menu matches on that exact encoding.
 */
export const GIT_SCHEME = 'git';

export interface IGitUriParams {
	readonly path: string;
	readonly ref: string;
}

export interface IGitUriOptions {
	/**
	 * Change the file extension to `.git`. Upstream does this so extensions that lint by
	 * file extension leave the read-only baseline alone.
	 */
	readonly replaceFileExtension?: boolean;
}

export function isGitUri(uri: URI): boolean {
	return uri.scheme === GIT_SCHEME;
}

export function fromGitUri(uri: URI): IGitUriParams {
	return JSON.parse(uri.query);
}

export function toGitUri(uri: URI, ref: string, options: IGitUriOptions = {}): URI {
	const params: IGitUriParams = { path: uri.fsPath, ref };
	const path = options.replaceFileExtension ? `${uri.path}.git` : uri.path;

	return uri.with({ scheme: GIT_SCHEME, path, query: JSON.stringify(params) });
}
