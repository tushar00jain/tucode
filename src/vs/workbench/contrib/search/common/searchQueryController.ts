/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../base/common/async.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

/** SearchView's query scheduling and cancellation, shared with model-to-native adapters. */
export class SearchQueryController extends Disposable {
	private readonly delayer = this._register(new Delayer<void>(0));
	private queryWork: Promise<void> = Promise.resolve();
	private searchWork: Promise<void> = Promise.resolve();
	private version = 0;

	constructor(private readonly cancelSearch: (newSearch?: boolean) => unknown,
		private readonly onError: (error: unknown) => void = onUnexpectedError) { super(); }

	get currentVersion(): number { return this.version; }
	isCurrent(version: number): boolean { return version === this.version && !this._store.isDisposed; }

	trigger(delay: number, prepare: (version: number) => Promise<void>): void {
		if (this._store.isDisposed) { return; }
		const version = ++this.version;
		this.queryWork = this.delayer.trigger(() => this.isCurrent(version) ? prepare(version) : Promise.resolve(), delay)
			.catch(error => { if (!isCancellationError(error) && this.isCurrent(version)) { this.onError(error); } });
	}

	/** Cancel the previous model request and serialize searches after query validation. */
	enqueue(version: number, search: () => PromiseLike<void>): Promise<void> {
		if (!this.isCurrent(version)) { return Promise.resolve(); }
		this.cancelSearch(true);
		return this.searchWork = this.searchWork
			.then(() => this.isCurrent(version) ? search() : undefined)
			.catch(error => { if (!isCancellationError(error) && this.isCurrent(version)) { this.onError(error); } });
	}

	cancel(): void {
		this.version++;
		this.delayer.cancel();
		this.cancelSearch();
	}

	async whenSettled(): Promise<void> {
		let query: Promise<void>, search: Promise<void>;
		do {
			query = this.queryWork; await query;
			search = this.searchWork; await search;
		} while (query !== this.queryWork || search !== this.searchWork);
	}

	override dispose(): void { this.cancel(); super.dispose(); }
}
