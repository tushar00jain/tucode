/*---------------------------------------------------------------------------------------------
 * The supported branch of upstream's Join Terminals action.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../vs/base/common/lifecycle.js';
import { localize, localize2 } from '../vs/nls.js';
import { Action2, registerAction2 } from '../vs/platform/actions/common/actions.js';
import { ContextKeyExpr } from '../vs/platform/contextkey/common/contextkey.js';
import { INotificationService } from '../vs/platform/notification/common/notification.js';
import { ServicesAccessor } from '../vs/platform/instantiation/common/instantiation.js';
import { TerminalCommandId } from '../vs/workbench/contrib/terminal/common/terminal.js';
import { TerminalContextKeys } from '../vs/workbench/contrib/terminal/common/terminalContextKey.js';

/**
 * Terminal tabs do not yet expose split groups, but the exact insufficient-terminal branch
 * is complete and useful with zero or one terminal. Keep that production action available without
 * pretending that the unsupported multi-terminal join UI exists.
 */
export function registerInsufficientTerminalJoinAction(count: () => number): IDisposable {
	const title = localize2('workbench.action.terminal.join', 'Join Terminals...');
	return registerAction2(class extends Action2 {
		constructor() { super({ id: TerminalCommandId.Join, title, f1: true,
			precondition: ContextKeyExpr.smallerEquals(TerminalContextKeys.count.key, 1) }); }
		run(accessor: ServicesAccessor): void {
			if (count() <= 1) {
				accessor.get(INotificationService).warn(localize('workbench.action.terminal.join.insufficientTerminals',
					'Insufficient terminals for the join action'));
			}
		}
	});
}
