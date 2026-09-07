/*---------------------------------------------------------------------------------------------
 *  The editor the vendored adapter was written against, over the editor a workbench has.
 *
 *  `cm_adapter.ts` was co-developed with **standalone** Monaco, so it reaches for members that
 *  live on `IStandaloneCodeEditor` and not on the workbench's `ICodeEditor`. Enumerated over the
 *  vendored file, there is exactly one: `createContextKey`, called from the adapter's own
 *  constructor — which is why binding vim threw before any key reached it.
 *
 *  This is the same class of gap as `monacoEditorApi.ts` and it is answered the same way: our
 *  decision, in our file, backed by the workbench service the standalone editor is itself backed
 *  by. `StandaloneCodeEditor.createContextKey` is `this._contextKeyService.createKey`, and the
 *  editor-scoped `IContextKeyService` is what `invokeWithinContext` hands out — so the key lands
 *  in the same scope on both surfaces rather than in the window's.
 *
 *  The wrapper forwards through a `Proxy` rather than a written-out list of members: the adapter
 *  reaches about thirty of them, and a list would be a second thing to keep in step with a
 *  vendored file.
 *
 *  Upstream counterpart: `editor/standalone/browser/standaloneCodeEditor.ts`, whose
 *  `createContextKey` this is.
 *--------------------------------------------------------------------------------------------*/

import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ContextKeyValue, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';

/** `ICodeEditor` plus the standalone-only member the vendored adapter constructs itself with. */
export interface IVimCodeEditor extends ICodeEditor {
	createContextKey<T extends ContextKeyValue = ContextKeyValue>(key: string, defaultValue: T): IContextKey<T>;
}

/**
 * `editor`, answering `createContextKey` as the standalone editor does.
 *
 * Only the adapter ever holds the result — the contribution, the session and the policy all keep
 * the editor itself — so nothing in this port compares one against the other.
 */
export function asVimCodeEditor(editor: ICodeEditor): IVimCodeEditor {
	const createContextKey = <T extends ContextKeyValue>(key: string, defaultValue: T): IContextKey<T> =>
		editor.invokeWithinContext(accessor => accessor.get(IContextKeyService).createKey(key, defaultValue));

	return new Proxy(editor, {
		get(target, property) {
			if (property === 'createContextKey') {
				return createContextKey;
			}

			const value = Reflect.get(target, property, target);

			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as IVimCodeEditor;
}
