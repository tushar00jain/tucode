/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingResolver } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { IKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { IHostService } from '../../host/browser/host.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { WorkbenchKeybindingService } from '../browser/keybindingService.js';
import { filterForTakeover, printEffectiveKeybindings, takeoverSettingKey } from './keyboardTakeover.js';

/**
 * The keyboard takeover, at the resolver. Stock assembles its default set from
 * `KeybindingsRegistry.getDefaultKeybindings()`; this subclass keeps the assembly and filters
 * the result to the keep-set of `keyboardTakeover.ts`, so this port's keymap is the only thing
 * answering a bare letter. User `keybindings.json` is untouched — it is not a default, so it
 * passes the filter whole and still overrides everything.
 *
 * This is the only registration of `IKeybindingService` in the boot closure: stock's own, at the
 * end of `browser/keybindingService.ts`, is deleted, because the registry is last-one-wins and
 * leaving both made the takeover a race that one reordered import would have reverted with
 * nothing failing. `test/unit/bootClosure.test.ts` holds it to one.
 */
export class TauriKeybindingService extends WorkbenchKeybindingService {

	private _takeoverResolver: KeybindingResolver | null = null;
	private readonly terminalKeyboard: boolean;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotificationService notificationService: INotificationService,
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
		@IHostService hostService: IHostService,
		@IExtensionService extensionService: IExtensionService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ILogService logService: ILogService,
		@IKeyboardLayoutService keyboardLayoutService: IKeyboardLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(contextKeyService, commandService, telemetryService, notificationService, userDataProfileService, hostService, extensionService, fileService, uriIdentityService, logService, keyboardLayoutService);
		this.terminalKeyboard = (keyboardLayoutService as IKeyboardLayoutService & { terminalWire?: boolean }).terminalWire === true;

		// Stock clears its own cached resolver and then fires this, so the filtered one built on
		// top of it goes stale at exactly the same moments.
		this._register(this.onDidUpdateKeybindings(() => {
			this._takeoverResolver = null;
		}));

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(takeoverSettingKey)) {
				this._takeoverResolver = null;
				this._onDidUpdateKeybindings.fire();
			}
		}));
	}

	protected override _getDefaultKeybindings() {
		return this.terminalKeyboard
			? KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Linux)
			: super._getDefaultKeybindings();
	}

	/**
	 * The rule set this window actually resolves with — the review surface for the takeover, which
	 * exists nowhere else: the unit test can only classify a corpus, and stock's own
	 * "Inspect Key Mappings" reads the registry rather than the resolver, so it disagrees with this
	 * by exactly the rules the filter dropped.
	 */
	dumpEffectiveKeybindings(): string {
		return printEffectiveKeybindings(this._getResolver().getKeybindings().map(item => ({
			chord: item.resolvedKeybinding?.getLabel() ?? '',
			command: item.command,
			when: item.when,
			isDefault: item.isDefault
		})));
	}

	protected override _getResolver(): KeybindingResolver {
		const stock = super._getResolver();
		// The takeover exists for a terminal wire, where ordinary printable keys have already
		// been claimed by the terminal keymap. A browser/WK editor has VS Code's native keyboard
		// event surface and must retain the complete platform resolver (Undo, Redo, Save, editor
		// navigation, and user-facing extension keybindings included).
		if (!this.terminalKeyboard || !this.configurationService.getValue<boolean>(takeoverSettingKey)) {
			return stock;
		}

		if (!this._takeoverResolver) {
			this._takeoverResolver = new KeybindingResolver(filterForTakeover(stock.getKeybindings()), [], (str) => this._log(str));
		}

		return this._takeoverResolver;
	}
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'tscode',
	order: 100,
	title: localize('tscodeConfigurationTitle', "tscode"),
	type: 'object',
	properties: {
		[takeoverSettingKey]: {
			type: 'boolean',
			default: true,
			description: localize('tscode.keyboard.takeover', "Controls whether this port's keymap is the only keyboard consumer. When on, the default keybindings are filtered to list and tree navigation, quick input, text-input editing and the chords the keymap shares with stock. Turn it off to restore the stock keybindings exactly, including Tab traversal between widgets and list type-ahead."),
			scope: ConfigurationScope.APPLICATION
		}
	}
});

registerSingleton(IKeybindingService, TauriKeybindingService, InstantiationType.Eager);

/**
 * What the print is prefixed with, so a reader — and the end-to-end suite, which drives this action
 * from the command palette and reads the console — can find it in whatever else the window logs.
 */
export const effectiveKeybindingsMarker = 'tscode: effective keybindings';

/**
 * "Developer: Print Effective Keybindings", the sibling of upstream's own "Inspect Key Mappings"
 * (`contrib/codeEditor/browser/inspectKeybindings.ts`) and the one that reads the *resolver*: with
 * the takeover on, stock's inspector lists rules the resolver no longer holds.
 *
 * It prints rather than opening an editor because the print is a diff surface — a build's rule set
 * against the previous build's — and an editor over a few hundred virtualised lines is neither
 * copyable whole nor readable by the suite that asserts on it.
 */
class PrintEffectiveKeybindings extends Action2 {

	constructor() {
		super({
			id: 'tscode.keyboard.printEffectiveKeybindings',
			title: localize2('tscode.printEffectiveKeybindings', "Print Effective Keybindings"),
			category: Categories.Developer,
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): void {
		const service = accessor.get(IKeybindingService);
		const print = service instanceof TauriKeybindingService
			? service.dumpEffectiveKeybindings()
			: printEffectiveKeybindings([]);

		console.log(`${effectiveKeybindingsMarker}\n${print}`);
	}
}

registerAction2(PrintEffectiveKeybindings);
