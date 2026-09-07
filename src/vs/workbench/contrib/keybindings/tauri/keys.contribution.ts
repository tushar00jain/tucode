/*---------------------------------------------------------------------------------------------
 *  `?` — every key that works right now, as a quick pick.
 *
 *  Upstream's own id for "show me what the keys do" is `workbench.action.openGlobalKeybindings`,
 *  and **this vendored tree registers it nowhere**: its surface upstream is the keybindings
 *  editor, which the cut table removes. So the id was free, and the keymap binds it to `?` — the
 *  character `Shift+/` produces — with upstream's usual `Ctrl+K Ctrl+S` behind it.
 *
 *  What fills the list is `keysPolicy.ts`.
 *  This file is the paint, the four facts the policy asks of this frontend — `guiRuleId` for the
 *  command a row's rule binds here, `lookupKeybinding(id, context, true)` against the live
 *  resolver at the focused editor's own context, where a dispatch would resolve, `commandTitle`
 *  against the command registries, and which view or editor pane has the keyboard — and the
 *  `ICommandService` that runs what the user picks. Nothing here is a table —
 *  a row whose rule the takeover dropped, whose `when` does not hold in this context, whose
 *  command no phase has written yet, or which belongs to a panel that is not the focused one is
 *  absent because one of those facts said so.
 *
 *  Upstream counterpart: none — see `keysPolicy.ts`.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ActiveEditorContext, EditorAreaFocusContext, FocusedViewContext } from '../../../common/contextkeys.js';
import { guiRuleId, rowsFor, SHOW_KEYS_ID } from '../../../browser/tauri/keymap.js';
import { IMPLEMENTED_COMMAND_IDS } from '../../../browser/tauri/keymap.contribution.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { commandTitle } from './commandTitle.js';
import { IKeyEntry, IKeyFocus, IKeysSource, KeyGroup, keyEntries, keyGroupTitle } from './keysPolicy.js';

/** A row of the list, carrying the entry it was drawn from so accepting it can run that entry. */
interface IKeyPick extends IQuickPickItem {
	readonly entry: IKeyEntry<ResolvedKeybinding>;
}

/**
 * What has the keyboard, in this frontend's terms — the same expansion `keymap.ts`'s header table
 * gives the two scoped forms, read off the live context rather than compiled into a `when` clause.
 * `activeEditor` on its own names the editor that is *open*, so it is paired with `editorAreaFocus`
 * for the same reason a `view:` row is guarded on `focusedView` and not on the view being visible.
 */
function keyFocus(contextKeyService: IContextKeyService): IKeyFocus {
	return {
		viewId: contextKeyService.getContextKeyValue<string>(FocusedViewContext.key) || undefined,
		editorId: contextKeyService.getContextKeyValue<boolean>(EditorAreaFocusContext.key)
			? contextKeyService.getContextKeyValue<string>(ActiveEditorContext.key) || undefined
			: undefined
	};
}

/**
 * The context the keys are resolved against — the focused editor's own, where there is one.
 *
 * A dispatch resolves at the element the key arrived on (`_dispatch` reads the context off the
 * event target), and half of every `editor:` row's guard is `editorTextFocus`, which the editor
 * widget binds on a service scoped to its own DOM node (`codeEditorWidget.ts:317`, bound at `:327`,
 * put in the widget's instantiation service at `:330`). The root service is not on that node, so a
 * lookup through it answers `undefined` for every key of the pane the user is typing in. A scoped
 * service answers for everything the root has as well, which is what makes it right for the rest of
 * the list and not only for the editor's own rows.
 */
function lookupContext(accessor: ServicesAccessor): IContextKeyService | undefined {
	const control = accessor.get(IEditorService).activeTextEditorControl;

	return isCodeEditor(control) ? control.invokeWithinContext(editor => editor.get(IContextKeyService)) : undefined;
}

/**
 * The list is picked from as well as read: accepting a row runs it, and what it runs is the
 * `command`/`args` pair `keysPolicy.ts` put on the entry.
 *
 * **Run from the command palette it lists almost nothing, and that is the honest answer.** Every
 * row is filtered by what the resolver says *now*, and by then the palette holds the keyboard:
 * `inputFocus` is set, `focusedView` has been reset, and a key scoped to a pane is genuinely not a
 * key the user can press. Answering for the focus the palette took would mean snapshotting the
 * whole context on every `focusin` and resolving against an overlay of it — a window-wide history
 * mechanism, for one list, in a build that has none. `?` and `Ctrl+K Ctrl+S` reach this from the
 * focus it is about; the palette entry is the one route that cannot.
 *
 * The pick closes before the command runs — `pick` resolves and hides in the same turn, and
 * `QuickInputController.hide` puts the keyboard back where it was **synchronously**, so the
 * command runs at the focus its row was listed for and does what the key would have done. What it
 * must not do is read a service afterwards: `invokeFunction` invalidates the accessor when `run`
 * returns its promise, so everything it needs is taken before the `await`.
 */
class ShowKeysAction extends Action2 {

	constructor() {
		super({
			id: SHOW_KEYS_ID,
			title: localize2('tscode.showKeys', "Keyboard Shortcuts"),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const keybindingService = accessor.get(IKeybindingService);
		const quickInputService = accessor.get(IQuickInputService);
		const context = lookupContext(accessor);

		// All three answers are about the rule that was actually registered, which for a forwarding
		// row is the command it stands in for wherever this frontend has no wrapper of its own.
		const source: IKeysSource<ResolvedKeybinding> = {
			command: row => guiRuleId(row, IMPLEMENTED_COMMAND_IDS),
			key: row => keybindingService.lookupKeybinding(source.command(row), context, true),
			title: row => commandTitle(source.command(row))
		};

		// Every key but the one that opened this, which is on screen by being obeyed.
		const entries = keyEntries(rowsFor('gui'), source, keyFocus(accessor.get(IContextKeyService)))
			.filter(entry => entry.id !== SHOW_KEYS_ID);

		const picks: (IKeyPick | IQuickPickSeparator)[] = [];
		let group: KeyGroup | undefined;
		for (const entry of entries) {
			if (entry.group !== group) {
				group = entry.group;
				picks.push({ type: 'separator', label: keyGroupTitle(group) });
			}

			picks.push({ id: entry.id, label: entry.title, keybinding: entry.key, entry });
		}

		const picked = await quickInputService.pick(picks, {
			placeHolder: localize('tscode.showKeys.placeholder', "Keys that work right now")
		});
		if (!picked) {
			return;
		}

		// `_doDispatch`'s own split (`abstractKeybindingService.ts:366`): a rule carrying no argument
		// runs the command with none, rather than with one that is `undefined`.
		await (picked.entry.args === undefined
			? commandService.executeCommand(picked.entry.command)
			: commandService.executeCommand(picked.entry.command, picked.entry.args));
	}
}

registerAction2(ShowKeysAction);
