/*---------------------------------------------------------------------------------------------
 *  Which keys a user is shown, in what order — the policy behind `?`, with none of the paint.
 *
 *  **It is the same list, not a second one.** The rows are `keymap.ts`'s, and whether a row is on
 *  the list at all is two questions asked of the live tree rather than of a table: does the
 *  resolver currently give this command a key, and does anything in this build register the
 *  command at all. A row that fails either is absent for the reason the dispatch would refuse it.
 *
 *  Both questions are asked through `IKeysSource`, which is the one part the paint supplies: here
 *  it hands a `ResolvedKeybinding` to a widget that draws it. **Which rows, in which order, under
 *  which group is decided here, once**, and the widget keeps only the drawing.
 *
 *  This module loads under a plain type-stripping `node`, which is why the two lookups arrive as a
 *  parameter: `IKeybindingService`, `CommandsRegistry` and `MenuRegistry` all reach a class with
 *  parameter decorators in their closure and none of the three can be imported here. The title
 *  *rule* that reads those registries is `commandTitle.ts`, beside this file and equally free of
 *  the DOM — the same split the `/` grammar has, for the same reason.
 *
 *  Upstream counterpart: none — upstream shows a user their keys in the Keyboard Shortcuts
 *  *editor* (`contrib/preferences/browser/keybindingsEditor.ts`), which this port's cut table
 *  removes, and which is a table of every rule rather than of the ones that currently apply.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { editorIdOf, viewIdOf } from '../../../browser/tauri/keymap.js';
import type { IKeymapRow } from '../../../browser/tauri/keymap.js';

/**
 * Where an entry belongs in the list. The keymap's `scope` is the only thing that says so, and the
 * split it makes is the one a reader wants: the keys of the thing that has the keyboard come
 * first, and the ones that work anywhere follow.
 *
 * There is no third group for the activity bar's containers. It declares its keys by drawing a
 * number on each one, and those rows are `global` — a list with room for every row does not need
 * the distinction.
 */
export type KeyGroup = 'focused' | 'workbench';

/** The groups in the order they are listed: nearest the keyboard first. */
export const KEY_GROUPS: readonly KeyGroup[] = ['focused', 'workbench'];

/** The group a row belongs to: a `view:`/`editor:` row is the focused thing's, `global` is not. */
export function keyGroupOf(row: IKeymapRow): KeyGroup {
	return row.scope === 'global' ? 'workbench' : 'focused';
}

/** What a group is called where the surface has room to say so. */
export function keyGroupTitle(group: KeyGroup): string {
	return group === 'focused'
		? localize('tscode.keys.focused', "Here")
		: localize('tscode.keys.workbench', "Anywhere");
}

/**
 * A row that can be run right now: the key the resolver gave it, and what it does.
 *
 * **Accepting an entry runs it**, which is why the entry carries what a dispatch of its key would
 * have carried and not only what to draw. `command` is the id the frontend's own rule for the row
 * binds rather than `id`: a forwarding row whose wrapper this frontend does not implement has no
 * command at its own id, so running `id` would find nothing. `args` is that rule's, which is how
 * one command takes nine keys — an entry is one row and runs with that row's argument, the first,
 * which is the primary the resolver would have named anyway.
 */
export interface IKeyEntry<K = string> {
	readonly id: string;
	/** The command accepting this entry runs — `IKeysSource.command`'s answer for its row. */
	readonly command: string;
	/** What the row's rule carries into that command, or `undefined` where it carries nothing. */
	readonly args: unknown;
	readonly key: K;
	readonly title: string;
	readonly group: KeyGroup;
}

/**
 * What has the keyboard right now, in the keymap's own symbolic terms — the one fact the policy
 * cannot read for itself, because it loads with no service to ask.
 */
export interface IKeyFocus {
	/** The id of the view that has the keyboard, or `undefined` where no view does. */
	readonly viewId: string | undefined;
	/** The id of the editor pane that has the keyboard, or `undefined` where none does. */
	readonly editorId: string | undefined;
}

/**
 * Whether a row's scope is where the keyboard is: the focused view's, the focused editor's, or
 * anywhere. **This is what makes the list the active panel's**, and it is asked of the row's own
 * scope rather than of the resolver, because the resolver answers about a *command* and a row's
 * command is not always the row's alone — `tscode.file.toggleWordWrap` forwards to
 * `editor.action.toggleWordWrap`, whose stock rule carries no `when` at all and so reports a key
 * from every pane in the window.
 */
export function rowInFocus(row: IKeymapRow, focus: IKeyFocus): boolean {
	const viewId = viewIdOf(row.scope);
	if (viewId !== undefined) {
		return viewId === focus.viewId;
	}

	const editorId = editorIdOf(row.scope);

	return editorId === undefined || editorId === focus.editorId;
}

/**
 * The two answers a frontend has to supply, both about the live tree rather than about the table.
 * A source that answers `undefined` to either leaves the row off the list.
 */
export interface IKeysSource<K = string> {
	/**
	 * The command this frontend's rule for the row binds, which is the id a dispatch of the row's
	 * key runs — and the id the other two answers are about. A frontend that implements the row's
	 * own wrapper answers `row.id`; one that does not answers what the row forwards to.
	 */
	command(row: IKeymapRow): string;
	/**
	 * The key the resolver currently gives this row's command, or `undefined` where no rule of it
	 * applies in this context — which is the same answer the dispatch would give.
	 */
	key(row: IKeymapRow): K | undefined;
	/** What the command is called, or `undefined` where nothing in this build registers it. */
	title(row: IKeymapRow): string | undefined;
}

/**
 * Every row whose key currently applies, in group order and then in declaration order.
 *
 * **Only the focused thing's rows and the ones that work anywhere.** A row scoped to a view or an
 * editor that does not have the keyboard is not a key the user can press, so it is not on the
 * list.
 *
 * **A command appears once however many rows it has.** `tscode.showViewContainer` is nine rows
 * carrying nine arguments and one command with one primary key, and a table of rows has no
 * declaration half to hide the other eight behind. First row wins, which is the primary the
 * resolver would name anyway.
 */
export function keyEntries<K>(rows: readonly IKeymapRow[], source: IKeysSource<K>, focus: IKeyFocus): IKeyEntry<K>[] {
	const entries: IKeyEntry<K>[] = [];
	const seen = new Set<string>();

	for (const group of KEY_GROUPS) {
		for (const row of rows.filter(candidate => keyGroupOf(candidate) === group)) {
			if (seen.has(row.id) || !rowInFocus(row, focus)) {
				continue;
			}

			const key = source.key(row);
			const title = source.title(row);
			if (key === undefined || title === undefined) {
				continue;
			}

			seen.add(row.id);
			entries.push({ id: row.id, command: source.command(row), args: row.args, key, title, group });
		}
	}

	return entries;
}
