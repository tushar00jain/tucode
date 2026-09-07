/*---------------------------------------------------------------------------------------------
 *  What a command is called, from wherever it happens to be declared.
 *
 *  Split out of `keysPolicy.ts` and not out of the policy: the rule below is a decision both
 *  frontends make the same way, but `MenuRegistry` and `CommandsRegistry` reach a class with
 *  parameter decorators in their closure, so a module that imports them cannot be loaded by a
 *  type-stripping `node` — and the policy's unit test needs to load. Two import paths are not two
 *  copies, which is the same answer the shared `/` grammar's DOM-free half was given.
 *
 *  Upstream counterpart: none — upstream reads a command's title at each place that shows one
 *  (`keybindingsEditorModel.ts`, `commandsQuickAccess.ts`), which this port's cut table removes
 *  the first of; a single accessor over the three places a title can live has no upstream form.
 *--------------------------------------------------------------------------------------------*/

import { isLocalizedString } from '../../../../platform/action/common/action.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

/**
 * The `title` on its `ICommandAction`, which is what every `registerAction2` puts in the menu
 * registry and what upstream labels a command with everywhere; the metadata its `CommandsRegistry`
 * registration carries, which is what this port's own have; or — with `menu` — the title on the
 * item it has in that menu. The last is how the `git.*` commands answer, because
 * `git.contribution.ts` puts `localize('git.command.stage', "Stage Changes")` on the menu item
 * rather than on the command. So a key that runs one is labelled with this tree's own words
 * instead of a second copy of them.
 *
 * `undefined` is the answer for a command nothing in this build registers, which is what keeps a
 * key for a command that has not landed yet off the list that offers it.
 */
export function commandTitle(id: string, menu?: MenuId): string | undefined {
	const item = menu === undefined
		? undefined
		: MenuRegistry.getMenuItems(menu).find(candidate => isIMenuItem(candidate) && candidate.command.id === id);
	const title = MenuRegistry.getCommand(id)?.title
		?? CommandsRegistry.getCommand(id)?.metadata?.description
		?? (item && isIMenuItem(item) ? item.command.title : undefined);

	return title === undefined ? undefined : isLocalizedString(title) ? title.value : title;
}
