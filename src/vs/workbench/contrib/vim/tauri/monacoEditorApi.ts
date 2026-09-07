/*---------------------------------------------------------------------------------------------
 *  The slice of `monaco-editor/esm/vs/editor/editor.api` that `cm_adapter.ts` imports, sourced
 *  from the modules those symbols actually live in.
 *
 *  **`editor.api.ts` cannot be imported into a workbench.** It builds the standalone editor's
 *  public API, which pulls in `standalone/browser/standaloneServices.ts` — 37 eager
 *  `registerSingleton` calls, including `IEnvironmentService`. `workbench.ts` copies every
 *  registry singleton into the service collection with no guard and the registry is
 *  last-one-wins, so importing that file replaces the services `main.ts` set. It did: the
 *  standalone environment service answers `monaco://userRoamingDataHome` — an authority with no
 *  path — and `joinPath` on it threw inside `Workbench.initLayout` before the window drew.
 *
 *  Nothing `cm_adapter.ts` takes from that module is standalone-only except `setTheme`, so this
 *  re-exports the rest from where `editor/common/services/editorBaseApi.ts` gets them and answers
 *  `setTheme` below. It is the whole of the vendored file's dependency on Monaco's public API, so
 *  the `main`-side patch to `src/vendor/**` stays the two rewritten import lines it already was.
 *
 *  The enums come from `common/standalone/standaloneEnums.ts` — a generated leaf module with no
 *  imports and no side effects, and the same source `editorBaseApi.ts` uses. They are real enums
 *  rather than the `const enum`s in `keyCodes.ts` / `editorOptions.ts` / `model.ts`, which cannot
 *  be re-exported as runtime values under Node's type stripping.
 *
 *  Upstream counterpart: `src/vs/editor/common/services/editorBaseApi.ts`, which does exactly
 *  this for the standalone API's own non-standalone half.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { EditorOption, KeyCode, SelectionDirection, TrackedRangeStickiness } from '../../../../editor/common/standalone/standaloneEnums.js';

export { KeyCode, Position, Range, Selection, SelectionDirection };

/**
 * The `monaco.editor` namespace, to the three members the adapter reaches: `EditorOption` in
 * `getConfiguration`, `TrackedRangeStickiness` in `markText`, and `setTheme` in `setOption`.
 */
export const editor = {
	EditorOption,
	TrackedRangeStickiness,

	/**
	 * `:colorscheme <name>`, which is the only path to here.
	 *
	 * A workbench has no per-editor theme to set: the colour theme is `IWorkbenchThemeService`'s,
	 * it is one setting for the whole window, and its ids are VS Code's rather than vim's — so
	 * there is no name to hand on. This throws vim's own answer for a colour scheme it cannot
	 * find, which the engine catches and prints to the mode line.
	 */
	setTheme(theme: string): never {
		throw new Error(`E185: Cannot find color scheme '${theme}'`);
	}
};
