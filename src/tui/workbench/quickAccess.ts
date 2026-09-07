/*---------------------------------------------------------------------------------------------
 *  Quick access: which provider a typed prefix reaches, and how a user finds out either exists.
 *
 *  Two of the three providers are registered by upstream's own contribution files, imported for
 *  their side effects by `main.ts` — `quickAccess.contribution.ts` for the help (`?`) and the
 *  commands (`>`) providers and the two actions behind them, and `quickAccessActions.ts` for
 *  `workbench.action.quickOpen` and the navigation commands. **Both keys are upstream's own**:
 *  `ShowAllCommandsAction` declares `Ctrl+Shift+P` with `F1` as its secondary, and only `F1`
 *  reaches a terminal — shift+ctrl+letter is byte-identical to ctrl+letter, the third instance of
 *  that wall after `Ctrl`+digit and `Alt`+letter — while `QuickAccessAction` declares `Ctrl+P`,
 *  which is a real control byte and arrives. So neither key is invented here, and neither
 *  registration is ours.
 *
 *  What is left for this file is the *default* provider, which upstream registers in
 *  `searchQuickAccess.contribution.ts` beside two symbol providers this fork cannot build — see
 *  `filesQuickAccess.ts` for what that costs — and the two declarations that put the keys on the
 *  status line, since a rule upstream registered is in no table of ours to read back.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/search/browser/searchQuickAccess.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { combinedDisposable, IDisposable } from '../../vs/base/common/lifecycle.js';
import { localize } from '../../vs/nls.js';
import { Extensions, IQuickAccessRegistry } from '../../vs/platform/quickinput/common/quickAccess.js';
import { Registry } from '../../vs/platform/registry/common/platform.js';
import { declareTuiCommand } from './commands.js';
import { FilesQuickAccessProvider } from './filesQuickAccess.js';

/** `ShowAllCommandsAction.ID`, named here because the status line asks for it by id. */
const SHOW_COMMANDS_ID = 'workbench.action.showCommands';

/** `QuickAccessAction`'s id in `quickAccessActions.ts`, for the same reason. */
const QUICK_OPEN_ID = 'workbench.action.quickOpen';

export function registerQuickAccess(): IDisposable {
	const registry = Registry.as<IQuickAccessRegistry>(Extensions.Quickaccess);

	return combinedDisposable(
		registry.registerQuickAccessProvider({
			ctor: FilesQuickAccessProvider,
			prefix: FilesQuickAccessProvider.PREFIX,
			placeholder: localize('anythingQuickAccessPlaceholder', "Search files by name"),
			helpEntries: [{ description: localize('anythingQuickAccess', "Go to File"), commandId: QUICK_OPEN_ID, commandCenterOrder: 10 }]
		}),
		declareTuiCommand(SHOW_COMMANDS_ID, 'workbench'),
		declareTuiCommand(QUICK_OPEN_ID, 'workbench')
	);
}
