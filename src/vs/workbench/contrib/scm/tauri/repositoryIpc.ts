/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';

/**
 * The repository-lifecycle half of a source-control channel — the five commands `channels/scm.rs`
 * and `channels/sl.rs` both answer, over the `PathParams` and `DiscoverParams` the two of them
 * already share on the Rust side. `ScmChannelClient` and `SlChannelClient` mirror each other
 * because the channels do, and this is the one place that mirroring is written down: a wire name
 * or an argument shape that changed in only one client would be a bug neither type would catch.
 *
 * `TInfo` is the per-backend descriptor a repository is identified by — `IGitRepositoryInfo` or
 * `ISlRepositoryInfo`. Everything past the lifecycle is the backend's own and stays on its client.
 */
export abstract class RepositoryChannelClient<TInfo> {

	constructor(protected readonly channel: IChannel) { }

	open(path: string): Promise<TInfo> {
		return this.channel.call('open', { path });
	}

	discover(path: string, maxDepth?: number): Promise<TInfo[]> {
		return this.channel.call('discover', { path, maxDepth });
	}

	repositories(): Promise<TInfo[]> {
		return this.channel.call('repositories');
	}

	close(path: string): Promise<void> {
		return this.channel.call('close', { path });
	}

	epoch(): Promise<number> {
		return this.channel.call('epoch');
	}
}
