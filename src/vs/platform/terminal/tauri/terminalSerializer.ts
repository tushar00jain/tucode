/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPtyHostProcessReplayEvent } from '../common/capabilities/capabilities.js';
import type { ITerminalSerializer } from './ptyService.js';

/**
 * The serializer `PersistentTerminalProcess` builds per terminal, without the headless xterm
 * behind it.
 *
 * Upstream's `XtermSerializer` constructs a second, headless `Terminal` for every persistent
 * process and writes every byte of output into it, so a renderer reload can reconnect to a live
 * shell with its scrollback intact. `PtyService` runs *in* the renderer here, so a reload loses
 * the shells whatever this class does — and the second buffer would sit beside the visible one,
 * doubling per-terminal memory in the app that exists to use less of it. So nothing is recorded:
 * replay events carry no data, and terminals do not survive a reload.
 *
 * The one empty event is kept rather than an empty list because `ptyService.ts` indexes
 * `replayEvent.events[0]` when reviving, so a revived terminal is a fresh shell rather than a
 * crash.
 */
export class TerminalSerializer implements ITerminalSerializer {

	constructor(
		private _cols: number,
		private _rows: number
	) {
	}

	handleData(data: string): void {
		// Nothing records it
	}

	freeRawReviveBuffer(): void {
		// There is no buffer to free
	}

	handleResize(cols: number, rows: number): void {
		this._cols = cols;
		this._rows = rows;
	}

	clearBuffer(): void {
		// Nothing records it
	}

	async generateReplayEvent(): Promise<IPtyHostProcessReplayEvent> {
		return {
			events: [{ cols: this._cols, rows: this._rows, data: '' }],
			commands: {
				isWindowsPty: false,
				hasRichCommandDetection: false,
				commands: [],
				promptInputModel: undefined
			}
		};
	}
}
