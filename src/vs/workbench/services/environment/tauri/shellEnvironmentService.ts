/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { PTY_CHANNEL_NAME } from '../../../../platform/terminal/tauri/tauriTerminalProcess.js';

export const IShellEnvironmentService = createDecorator<IShellEnvironmentService>('shellEnvironmentService');

export interface IShellEnvironmentService {

	readonly _serviceBrand: undefined;

	getShellEnv(): Promise<IProcessEnvironment>;
}

/**
 * The login-shell environment, which on macOS and Linux is only knowable by running the user's
 * shell. Upstream's Electron service reads it from the sandbox `process` global, which is the
 * main process answering the same question; here it is the `pty` channel.
 */
export class TauriShellEnvironmentService implements IShellEnvironmentService {

	declare readonly _serviceBrand: undefined;

	private readonly _channel: IChannel;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService
	) {
		this._channel = mainProcessService.getChannel(PTY_CHANNEL_NAME);
	}

	getShellEnv(): Promise<IProcessEnvironment> {
		return this._channel.call<IProcessEnvironment>('getShellEnv');
	}
}

registerSingleton(IShellEnvironmentService, TauriShellEnvironmentService, InstantiationType.Delayed);
