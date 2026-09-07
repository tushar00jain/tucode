/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DEFAULT_BOLD_FONT_WEIGHT, DEFAULT_COMMANDS_TO_SKIP_SHELL, DEFAULT_FONT_WEIGHT, FontWeight, ITerminalConfiguration, MAXIMUM_FONT_WEIGHT, MINIMUM_FONT_WEIGHT, TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { TerminalLocation, TerminalLocationConfigValue } from '../../../../platform/terminal/common/terminal.js';
import { isString } from '../../../../base/common/types.js';
import { clamp } from '../../../../base/common/numbers.js';

// #region TerminalConfigurationService

export class TerminalConfigurationService extends Disposable {
	declare _serviceBrand: undefined;

	private _skipTerminalCommands: ReadonlySet<string> = new Set(DEFAULT_COMMANDS_TO_SKIP_SHELL);

	protected _config!: Readonly<ITerminalConfiguration>;
	get config() { return this._config; }

	get defaultLocation(): TerminalLocation {
		if (this.config.defaultLocation === TerminalLocationConfigValue.Editor) {
			return TerminalLocation.Editor;
		}
		return TerminalLocation.Panel;
	}

	private readonly _onConfigChanged = this._register(new Emitter<void>());
	get onConfigChanged(): Event<void> { return this._onConfigChanged.event; }

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._register(Event.runAndSubscribe(this._configurationService.onDidChangeConfiguration, e => {
			if (!e || e.affectsConfiguration(TERMINAL_CONFIG_SECTION)) {
				this._updateConfig();
			}
		}));
	}

	shouldCommandSkipShell(commandId: string): boolean { return this._skipTerminalCommands.has(commandId); }

	private _updateConfig(): void {
		const configValues = { ...this._configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION) };
		configValues.fontWeight = this._normalizeFontWeight(configValues.fontWeight, DEFAULT_FONT_WEIGHT);
		configValues.fontWeightBold = this._normalizeFontWeight(configValues.fontWeightBold, DEFAULT_BOLD_FONT_WEIGHT);
		this._config = configValues;
		const skipTerminalCommands = new Set(DEFAULT_COMMANDS_TO_SKIP_SHELL);
		const commandsToSkipShell = configValues.commandsToSkipShell ?? [];
		for (let i = 0; i < commandsToSkipShell.length; i++) {
			const command = commandsToSkipShell[i];
			if (command[0] === '-') {
				skipTerminalCommands.delete(command.slice(1));
				continue;
			}
			skipTerminalCommands.add(command);
		}
		this._skipTerminalCommands = skipTerminalCommands;
		this._onConfigChanged.fire();
	}

	private _normalizeFontWeight(input: FontWeight, defaultWeight: FontWeight): FontWeight {
		if (input === 'normal' || input === 'bold') {
			return input;
		}
		return clampInt(input, MINIMUM_FONT_WEIGHT, MAXIMUM_FONT_WEIGHT, defaultWeight);
	}
}

// #endregion TerminalConfigurationService

// #region Utils

function clampInt<T>(source: string | number, minimum: number, maximum: number, fallback: T): number | T {
	if (source === null || source === undefined) {
		return fallback;
	}
	const r = isString(source) ? parseInt(source, 10) : source;
	if (isNaN(r)) {
		return fallback;
	}
	return clamp(r, minimum, maximum);
}
// #endregion Utils
