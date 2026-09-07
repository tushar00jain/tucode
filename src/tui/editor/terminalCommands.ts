/*---------------------------------------------------------------------------------------------
 *  The two ways a child process gets a rectangle: a shell, and the user's `$EDITOR` on a file.
 *
 *  **This is the answer to editing.** Suspending tucode and spawning the editor over it was
 *  rejected — it throws away the chrome, the project state and the tabs, and a diff produced by
 *  another tool would come from a different algorithm than tscode's — so the editor runs *inside*
 *  the editor area instead, as one more tab, with everything around it still tucode's.
 *
 *  **What is deliberately not here is a terminal panel.** Whether there is an integrated terminal
 *  pane at all is the user's decision, not an agent's (§9.5). It does not fall out of this either:
 *  upstream's panel is `TerminalViewPane` in a *panel part*, and
 *  `workbench.ts` has an activity bar, a side bar and an editor area and no panel region at all —
 *  so a panel is a layout that does not exist yet rather than a registration held back. What does
 *  exist is upstream's other container, the terminal editor, which is the one this frontend uses.
 *
 *  Upstream counterpart: src/vs/workbench/contrib/terminal/browser/terminalActions.ts
 *--------------------------------------------------------------------------------------------*/

import { KeyCode } from '../../vs/base/common/keyCodes.js';
import { combinedDisposable, IDisposable } from '../../vs/base/common/lifecycle.js';
import { IProcessEnvironment } from '../../vs/base/common/platform.js';
import { dirname } from '../../vs/base/common/resources.js';
import { URI } from '../../vs/base/common/uri.js';
import { localize } from '../../vs/nls.js';
import { InputFocusedContext } from '../../vs/platform/contextkey/common/contextkeys.js';
import { IDialogService } from '../../vs/platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../vs/platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../vs/platform/terminal/common/terminal.js';
import { TEXT_FILE_EDITOR_ID } from '../../vs/workbench/contrib/files/common/files.js';
import { registerPaneCommand, registerTuiCommand } from '../workbench/commands.js';
import { defaultRegionLaunch, IRegionLaunchServices, regionEnvironment, regionLaunchServices } from '../terminal/launch.js';
import { EditorArea } from './editorArea.js';

/**
 * The services a launch needs, taken in one synchronous read.
 *
 * A `ServicesAccessor` is only valid while the invocation that was handed it is on the stack, so
 * everything below the first `await` reads off this instead — the pairing `ICommandHandler`
 * enforces and an async handler is otherwise free to get wrong.
 */
interface ILaunchServices extends IRegionLaunchServices {
	readonly dialogService: IDialogService;
}

function launchServices(accessor: ServicesAccessor): ILaunchServices {
	return {
		...regionLaunchServices(accessor),
		dialogService: accessor.get(IDialogService),
	};
}

/**
 * `$VISUAL` or `$EDITOR`, split on whitespace into an executable and its arguments.
 *
 * A shell splits its own `$EDITOR` with the whole of its word-splitting and quoting, and this does
 * not — `EDITOR="code -w"` works and an editor path with a space in it does not. Putting a shell
 * in between would buy the quoting at the price of a second process in the rectangle, and there is
 * no upstream implementation of either to port: nothing in VS Code ever reads `$EDITOR`.
 */
function editorCommand(env: IProcessEnvironment): { executable: string; args: string[] } | undefined {
	const configured = (env['VISUAL'] || env['EDITOR'] || '').trim();
	if (!configured) {
		return undefined;
	}

	const [executable, ...args] = configured.split(/\s+/);

	return { executable, args };
}

/**
 * The two commands, registered against the editor area that hosts them.
 *
 * `reveal` moves the keyboard into the editor area, exactly as `registerEditorCommands` uses it:
 * a child that has the rectangle and not the keyboard would swallow nothing and answer nothing.
 */
export function registerTerminalCommands(editors: EditorArea, reveal: () => void): IDisposable {
	return combinedDisposable(
		// Upstream's own id for a terminal opened as an editor rather than in the panel. Its key
		// there is `Ctrl+Shift+\``, which a terminal cannot deliver — the same wall `Ctrl+PageDown`
		// hit in phase G.
		registerTuiCommand({
			id: 'workbench.action.createTerminalEditor',
			title: localize('createTerminalEditor', "Terminal"),
			primary: KeyCode.KeyT,
			// Every single-character rule in this fork carries this, and the suite is what said so: a
			// `t` typed into the search box opened a shell, and the run drifted from there. A region
			// that has the keyboard publishes `inputFocus` too, so `t` inside a child is the child's.
			when: InputFocusedContext.negate(),
			scope: 'workbench',
			handler: accessor => {
				const services = launchServices(accessor);

				return open(editors, reveal, () => defaultRegionLaunch(services));
			}
		}),

		// Editing, on the file the reader is showing. There is no upstream command to name it after:
		// upstream edits in Monaco and never asks the OS who the user's editor is.
		registerPaneCommand(TEXT_FILE_EDITOR_ID, {
			id: 'tscode.editFile',
			title: localize('tscode.editFile', "Edit"),
			primary: KeyCode.KeyE,
			handler: accessor => {
				const services = launchServices(accessor);
				const resource = editors.activeKind === 'text' ? editors.activeResource : undefined;

				return resource && open(editors, reveal, () => editorLaunch(services, resource));
			}
		})
	);
}

/** A launch, or nothing when the caller decided there was none to make. */
type ILaunch = { config: IShellLaunchConfig; cwd: string; env: IProcessEnvironment; label: string } | undefined;

/**
 * Resolves a launch and gives it the editor area, in that order — the keyboard is moved only once
 * there is something to move it to, so a command that answers "no editor is configured" leaves the
 * focus where the user left it.
 */
function open(editors: EditorArea, reveal: () => void, resolve: () => Promise<ILaunch>): Promise<void> {
	const opening = (async () => {
		const launch = await resolve();
		if (!launch) {
			return;
		}

		reveal();
		await editors.openTerminal(launch.config, launch.cwd, launch.env, launch.label);
	})();

	// The keybinding path drops what a handler returns, so the area is where this is left: a launch
	// still resolving its shell when the run ends would otherwise paint after the frontend is gone.
	editors.track(opening);

	return opening;
}

/** `$EDITOR` on `resource`, or nothing — with the reason said out loud, not swallowed. */
async function editorLaunch(services: ILaunchServices, resource: URI): Promise<ILaunch> {
	const command = editorCommand(await services.channel.call<IProcessEnvironment>('getEnvironment'));
	if (!command) {
		await services.dialogService.info(
			localize('tscode.editFile.unset', "No editor is configured."),
			localize('tscode.editFile.unset.detail', "Set VISUAL or EDITOR in the environment tucode was started from, and it will open the file in the editor area."));

		return undefined;
	}

	const config: IShellLaunchConfig = { executable: command.executable, args: [...command.args, resource.fsPath] };

	return { config, cwd: dirname(resource).fsPath, env: await regionEnvironment(services, config), label: command.executable };
}
