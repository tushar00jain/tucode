/*---------------------------------------------------------------------------------------------
 *  What this frontend lets a user press, declared as commands with keybinding rules.
 *
 *  Every key this fork answers beyond navigation goes through `KeybindingsRegistry`, so there is
 *  one declaration per action and everything else reads it: the resolver decides which rule a
 *  keystroke matches, `ICommandService` runs the handler, and the status line is built from the
 *  same rules rather than from a string a pane keeps in step by hand. A key that is bound is
 *  therefore visible, overridable from `keybindings.json`, and inspectable — none of which a
 *  `switch (key.char)` can be.
 *
 *  Three context keys decide when a rule applies, and two of the three are upstream's own so that
 *  upstream `when` clauses evaluate correctly here:
 *
 *  - `focusedView` (`FocusedViewContext`) — the id of the view the focused pane *is*, so a rule
 *    scoped to a pane is scoped the way tscode scopes one.
 *  - `inputFocus` (`InputFocusedContext`) — set while a pane's text input is being typed into.
 *    This is the modal split T08 left as a placeholder: with it, `q` types a `q` in the search
 *    box and still quits everywhere else, and the digits still switch panes.
 *  - `tscodeCanEditInput` — ours, because it has no upstream counterpart: whether the focused row
 *    (or the pane's own box) is an input at all, which is what decides whether `i` means anything.
 *
 *  Upstream counterpart: none — upstream declares each command beside the feature that owns it, so there is no single file this stands in for; the registration helper and the status-line hints have no upstream form at all.
 *--------------------------------------------------------------------------------------------*/

import { remove } from '../../vs/base/common/arrays.js';
import { KeyChord, KeyCode, KeyMod } from '../../vs/base/common/keyCodes.js';
import { combinedDisposable, IDisposable, toDisposable } from '../../vs/base/common/lifecycle.js';
import { localize } from '../../vs/nls.js';
import { ICommandHandler } from '../../vs/platform/commands/common/commands.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../vs/platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../vs/platform/contextkey/common/contextkeys.js';
import { IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../vs/platform/keybinding/common/keybindingsRegistry.js';
import { EditorAreaFocusContext, EditorsVisibleContext, FocusedViewContext, SideBarVisibleContext } from '../../vs/workbench/common/contextkeys.js';
import { inQuickPickContext } from '../../vs/workbench/browser/quickaccess.js';
import { registerTakeoverKeepCommand } from '../../vs/workbench/services/keybinding/tauri/keyboardTakeover.js';
import { commandTitle } from '../../vs/workbench/contrib/keybindings/tauri/commandTitle.js';
import { accessibilityHelpIsShown } from '../../vs/workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { CONTEXT_FIND_WIDGET_VISIBLE } from '../../vs/editor/contrib/find/browser/findModel.js';
import { VIEW_ID as SEARCH_VIEW_ID } from '../../vs/workbench/services/search/common/search.js';
import { VIEWLET_ID as SCM_VIEWLET_ID } from '../../vs/workbench/contrib/scm/common/scm.js';
import { namedKeybinding } from './keyboard.js';
export { CanEditInputContext, CanScrollHorizontallyContext, FilteringContext, HasContextMenuContext, MultipleViewsContext } from '../../workbench/paneContext.js';
import { CanEditInputContext, CanScrollHorizontallyContext, FilteringContext, HasContextMenuContext, MultipleViewsContext } from '../../workbench/paneContext.js';

/** Whether the focused row, or the pane's own box, is something the user can type into. */
/**
 * Whether the focused pane's view root filter box is the box being typed into, which `inputFocus`
 * cannot say: the source control pane has two boxes and a commit message has nothing to complete.
 * Ours for the same reason `tscodeCanEditInput` is — a status line that offers `Tab` over a commit
 * message would be naming a key that does nothing.
 */
/** The exact context under which Escape leaves a pane-owned input rather than a Quick Pick. */
export const StopEditingInputContext = ContextKeyExpr.and(
	InputFocusedContext,
	inQuickPickContext.negate(),
	accessibilityHelpIsShown.negate(),
	CONTEXT_FIND_WIDGET_VISIBLE.negate()
);

/** Whether the focused row has actions to offer, which is what decides `Shift+F10` means anything. */
/**
 * Whether the shown view container has more than one view in it, which is what decides whether
 * moving between them means anything. Ours, because upstream's answer is a click on a header and
 * there is no `when` clause for "there is a second one" — but a status line that offers a key
 * doing nothing is what sent a user looking for the gesture that moves between the *parts*.
 */
/**
 * Whether the focused pane has more content than the columns it was given. Ours, for the same
 * reason `tscodeMultipleViews` is: upstream keeps `WorkbenchListScrollAtTopContextKey` and its
 * sibling on `IListService` and scopes `list.scrollUp`/`list.scrollDown` out of a list that is
 * already at the edge, and there is no list service here to answer for a pane.
 */
/**
 * Upstream's own command for showing a user what the keys do. Named here because two other files
 * ask about it by id — the status line puts it last so it survives a row that has run out of room,
 * and the overlay it opens leaves itself out of its own list.
 */
export const SHOW_KEYS_ID = 'workbench.action.openGlobalKeybindings';

/**
 * Where a command belongs in the status line: a pane's own keys come first, the workbench's
 * follow, and `tabs` is for the keys the tab bar already declares by drawing them.
 */
export type TuiCommandScope = 'pane' | 'workbench' | 'tabs';

export interface ITuiCommand {
	readonly id: string;
	/** What the status line calls it, and what `keybindings.json` completion describes it as. */
	readonly title: string;
	readonly primary: number;
	readonly secondary?: number[];
	readonly when?: ContextKeyExpression;
	readonly args?: unknown;
	readonly scope: TuiCommandScope;
	readonly handler: ICommandHandler;
}

/** The commands declared here, in declaration order — the status line's table. */
const declared: { id: string; scope: TuiCommandScope }[] = [];

/**
 * Registers a command and the key that runs it, as one call: a command with no key would be
 * unreachable until quick input exists, and a key with no command is the `switch` this replaces.
 *
 * Registry changes invalidate WorkbenchKeybindingService's resolver, including registrations
 * made after upstream widgets first requested a key label and removals during teardown.
 *
 * **And every rule has to be named to the takeover.** `TauriKeybindingService` filters the default
 * set down to `keyboardTakeover.ts`'s keep-set, and a rule registered here is a stock default like
 * any other — nothing on a resolved item says which registration produced it. So the two calls
 * travel together, exactly as they do in `keymap.contribution.ts` for the surface with a window: a
 * rule registered without one is a key that silently does nothing.
 */
export function registerTuiCommand(command: ITuiCommand): IDisposable {
	const entry = { id: command.id, scope: command.scope };
	declared.push(entry);
	registerTakeoverKeepCommand(command.id);

	return combinedDisposable(
		KeybindingsRegistry.registerCommandAndKeybindingRule({
			id: command.id,
			weight: KeybindingWeight.WorkbenchContrib,
			when: command.when,
			primary: command.primary,
			secondary: command.secondary,
			args: command.args,
			metadata: { description: command.title, args: [] },
			handler: command.handler
		}),
		toDisposable(() => remove(declared, entry))
);

}

/**
 * A key for a command that is registered elsewhere — a second `when` clause or a second argument
 * for one of ours (`secondary` on the rule above can carry neither), or a key for a command that is
 * upstream's. `scope` puts it on the status line, which is what an upstream command wants: nothing
 * else would ever tell the user it is there.
 */
export function registerTuiKeybinding(id: string, primary: number, when?: ContextKeyExpression, args?: unknown, scope?: TuiCommandScope): IDisposable {
	const rule = KeybindingsRegistry.registerKeybindingRule({ id, weight: KeybindingWeight.WorkbenchContrib, when, primary, args });
	registerTakeoverKeepCommand(id);
	if (!scope) {
		return rule;
	}

	const entry = { id, scope };
	declared.push(entry);

	return combinedDisposable(rule, toDisposable(() => remove(declared, entry)));
}

/**
 * A key that belongs to one pane. The two conditions travel together on every one of them —
 * the pane has to be the focused view, and its text input must not be swallowing keys — so they
 * are applied here rather than repeated at each declaration.
 *
 * `whileEditing` drops the second condition, which is what a key carrying a modifier needs: a
 * `Ctrl+Down` cannot be mistaken for typing, and upstream's own rules for those keys are scoped to
 * the view being focused and nothing more.
 */
export function registerPaneCommand(viewId: string, command: Omit<ITuiCommand, 'scope'> & { scope?: TuiCommandScope; whileEditing?: boolean }): IDisposable {
	return registerTuiCommand({
		...command,
		scope: command.scope ?? 'pane',
		when: ContextKeyExpr.and(FocusedViewContext.isEqualTo(viewId), command.whileEditing ? undefined : InputFocusedContext.negate(), command.when)
	});
}

/**
 * A command whose key is declared somewhere else — an upstream `Action2` carrying its own
 * `keybinding`, which this fork neither adds to nor overrides. Declaring it puts it on the status
 * line and in the keys overlay, which is the only way a user would find out it is there: those are
 * built from this table, and an upstream rule is in `KeybindingsRegistry` and in no table of ours.
 */
export function declareTuiCommand(id: string, scope: TuiCommandScope): IDisposable {
	const entry = { id, scope };
	declared.push(entry);

	return toDisposable(() => remove(declared, entry));
}

/**
 * What a command is called, re-exported so a pane reads it beside the registration helpers here.
 * The rule is `commandTitle.ts`'s, which is where the terminal reads a title from.
 */
export { commandTitle };

/** A declared command that can be run right now: the key the resolver gave it, and what it does. */
export interface IKeyEntry {
	readonly id: string;
	readonly key: string;
	readonly title: string;
	readonly scope: TuiCommandScope;
}

/**
 * Every declared command whose key currently applies, labelled with the key the resolver resolved
 * and the title the command registry holds — in the scope order the status line reads them in.
 * Nothing here is a second copy of the vocabulary: a rule that does not apply in this context is
 * absent because `lookupKeybinding` says so, which is the same answer the dispatch would give.
 *
 * `reaches` is the second half of that answer, and only a pane hosting a child process supplies
 * one: a key the child swallows resolves to a command and never runs it.
 *
 * **Which of a command's keys is named is `namedKeybinding`'s answer**, and it is the primary
 * unless the frontend installed something else: a window carries every chord, so the key printed is
 * the key the dispatch runs; a terminal cannot send some of them, so it installs the first binding
 * it can (`terminalKeyboard.ts`). Either way the primary decides whether the command applies at
 * all, which is the part that needs the context check.
 */
export function keyEntries(keybindingService: IKeybindingService, reaches: (id: string) => boolean = () => true): IKeyEntry[] {
	const entries: IKeyEntry[] = [];

	for (const scope of ['pane', 'workbench', 'tabs'] as const) {
		for (const declaration of declared.filter(candidate => candidate.scope === scope)) {
			const keybinding = namedKeybinding(keybindingService, declaration.id,
				keybindingService.lookupKeybinding(declaration.id, undefined, true));
			const title = commandTitle(declaration.id);
			const key = keybinding?.getLabel();
			if (!key || !title || !reaches(declaration.id)) {
				continue;
			}

			entries.push({ id: declaration.id, key, title, scope });
		}
	}

	return entries;
}

/** An entry as one run of text, which is how both the status line and the keys overlay say it. */
export function keyLabel(entry: IKeyEntry): string {
	return `${entry.key} ${entry.title}`;
}

/** One rule's key: the chord, and the terms it applies under. */
export interface IWorkbenchKeyRule {
	readonly primary: number;
	readonly when?: ContextKeyExpression;
}

/**
 * The workbench keys that are supplied by the terminal surface rather than fixed by a command.
 */
export interface IWorkbenchKeys {
	/**
	 * `tscode.quit`'s chord.
	 *
	 * `Ctrl+C` is the interrupt, which is how a program reading a pty is stopped, and it carries no
	 * `when` clause so it works while a text input has focus. The bare `Q` fallback is registered below.
	 */
	readonly quit: number;
	/** The platform spelling of Source Control's shared Ctrl+Shift+G chord. */
	readonly sourceControl: number;
	/** The terminal's deliverable next/previous-view and next/previous-editor gestures. */
	readonly cycleForward: number;
	readonly cycleBackward: number;

	/**
	 * `workbench.action.focusSideBar`'s rules, the first of which the command is declared under and
	 * the **last of which the status line names** — `lookupKeybinding` answers with the last rule
	 * registered at a command's highest weight.
	 *
	 * A terminal has one: the bare `0` that continues the digits the activity bar draws, because it
	 * has no `Ctrl`+digit on the wire at all (`§6`). A window has two — upstream's own `⌘0`, which
	 * `sidebarActions.ts` declares for this command and which a terminal simply could not carry, and
	 * the bare key after it so that the activity bar's own digit is still the one named.
	 */
	readonly focusSideBar: readonly IWorkbenchKeyRule[];
}

/** What the workbench's own commands act on. `Workbench` is the implementation. */
export interface ITuiWorkbench {
	/** The keys only this frontend can decide. */
	readonly keys: IWorkbenchKeys;
	quit(): void;
	/** Shows the side bar's `index`th view container, which is what its activity bar number is. */
	showViewContainer(index: number): void;
	/** Shows a registered container by its stable shared identifier. */
	showViewContainerById(id: string): boolean;
	/** Puts the keyboard in the editor area. */
	focusEditorArea(): void;
	/** Puts the keyboard back in the side bar, showing it first if it is hidden. */
	focusSideBar(): void;
	/** Shows every key that currently applies, which the status line has no room for. */
	showKeys(): void;
	/** Moves `delta` views within the shown container, wrapping. */
	focusViewBy(delta: number): void;
	/** Moves `delta` tabs along the editor strip, wrapping. */
	focusEditorBy(delta: number): void;
	closeActiveEditor(): void;
	toggleSideBar(): void;
	/** Grows the part that has the keyboard by one increment, or shrinks it for a negative sign. */
	resizePart(change: number): void;
	/** Collapses or expands the focused view, which is `Pane.setExpanded`. */
	setViewExpanded(expanded: boolean): void;
	/** Starts or stops typing into the focused pane's input. */
	editInput(editing: boolean): void;
	/** Cycles the focused pane's `/` box through the rows it ranked, in the direction's sign. */
	completeFilter(delta: number): void;
	/** Scrolls the focused pane one step sideways, in the direction's sign. */
	scrollPaneBy(direction: number): void;
	/** Opens the focused row's context menu, anchored where that row is drawn. */
	showContextMenu(): void;
}

/**
 * The workbench's own keys — the four parts, and moving between and within them.
 *
 * **Three of these are upstream's command ids at upstream's own keys** (`Ctrl+W` closes an editor,
 * `Ctrl+B` toggles the side bar), and the rest are upstream's ids at a key of ours: a terminal
 * cannot deliver `Ctrl+PageDown`, which is what `workbench.action.nextEditor` is bound to there,
 * and tscode's own keymap answers that id on `Tab`.
 *
 * `Tab` therefore means "the next thing in the part that has the keyboard", and the two rules that
 * say so are told apart by `editorAreaFocus` against its own negation rather than by an arm of a
 * handler — the same pair `0` is split on below.
 *
 * **One key, one command, whatever order the rules were declared in.** `sideBarFocus` is the honest
 * name for the half of that pair the side bar answers, and `Workbench` publishes it — but it is a
 * second key set from the same `focus` field, so nothing in the *declarations* says the two cannot
 * hold at once and the resolver was left running whichever rule came last. Upstream states that
 * exclusion structurally instead: `editorAreaFocus` is bound to the editor part's own scoped context
 * key service and is simply invisible to a dispatch from anywhere else. A terminal's dispatch has no
 * element to scope to (`Workbench.NO_TARGET`), so here the exclusion has to be in the terms.
 */
export function registerWorkbenchCommands(workbench: ITuiWorkbench): IDisposable {
	const disposables: readonly IDisposable[] = [
		registerTuiCommand({
			id: 'tscode.quit',
			title: localize('tscode.quit', "Quit"),
			primary: workbench.keys.quit,
			scope: 'workbench',
			handler: () => workbench.quit()
		}),
		registerTuiKeybinding('tscode.quit', KeyCode.KeyQ, InputFocusedContext.negate()),

		// The digits are `tabs` scope: the activity bar declares them by drawing a numbered entry per
		// container, so repeating them on the status line would cost the room a pane's own keys need.
		//
		// One command for nine keys, each rule carrying the container it means as its argument — which
		// is how a command that needs a choice takes one without a picker to choose in. (`args` on a
		// rule is upstream's own mechanism; `KeybindingResolver` carries it into `executeCommand`.)
		// Written out rather than looped: each of the nine is a declaration, and the keybinding table
		// on `docs/keyboard/build.mjs` is read off these call sites.
		registerTuiCommand({
			id: 'tscode.showViewContainer',
			title: localize('tscode.showViewContainer', "Show View Container"),
			primary: KeyCode.Digit1,
			args: 0,
			when: InputFocusedContext.negate(),
			scope: 'tabs',
			handler: (_accessor, index) => workbench.showViewContainer(Number(index))
		}),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit2, InputFocusedContext.negate(), 1),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit3, InputFocusedContext.negate(), 2),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit4, InputFocusedContext.negate(), 3),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit5, InputFocusedContext.negate(), 4),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit6, InputFocusedContext.negate(), 5),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit7, InputFocusedContext.negate(), 6),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit8, InputFocusedContext.negate(), 7),
		registerTuiKeybinding('tscode.showViewContainer', KeyCode.Digit9, InputFocusedContext.negate(), 8),

		// The browser Search action is intentionally outside this frontend's contribution closure: it
		// constructs a DOM SearchView through IViewsService. Preserve its public command identifier and
		// chord at the shared workbench/controller boundary, where both projections can select the same
		// registered container and put its existing query input into editing mode.
		registerTuiCommand({
			id: 'workbench.action.findInFiles',
			title: localize('findInFiles', "Find in Files"),
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF,
			scope: 'workbench',
			handler: () => {
				if (workbench.showViewContainerById(SEARCH_VIEW_ID)) { workbench.editInput(true); }
			}
		}),

		// The browser contribution which normally registers the Source Control view action is outside
		// this frontend's non-DOM boot closure. Keep the canonical command id and platform chord at the
		// same shared container boundary as Find in Files; the native input gateway only normalizes the
		// event and the shared command remains the sole owner of container selection and focus.
		registerTuiCommand({
			id: SCM_VIEWLET_ID,
			title: localize('showSourceControl', "Source Control"),
			primary: workbench.keys.sourceControl,
			scope: 'workbench',
			handler: () => { workbench.showViewContainerById(SCM_VIEWLET_ID); }
		}),

		// `0` continues the digits the activity bar draws, and it is **one key for both directions**:
		// upstream's pair is `Ctrl+1` / `Ctrl+0`. Which of the two rules applies is `editorAreaFocus`,
		// exactly as it is for `Tab` below — so the status line always names the way out of the part
		// that has the keyboard, which is what the half of this pair that was built could not do.
		//
		// The way *in* to the editor area is the bare key on either frontend, because upstream has no
		// `Ctrl+1` for it — `Ctrl+1` focuses the first editor *group*, and there is one group here
		// (`§8`). The way back out has upstream's own chord where the frontend can carry it, which is
		// what `keys.focusSideBar` says.
		registerTuiCommand({
			id: 'tscode.focusEditorArea',
			title: localize('tscode.focusEditorArea', "Editor"),
			primary: KeyCode.Digit0,
			when: ContextKeyExpr.and(InputFocusedContext.negate(), EditorAreaFocusContext.negate()),
			scope: 'workbench',
			handler: () => workbench.focusEditorArea()
		}),
		registerTuiCommand({
			id: 'workbench.action.focusSideBar',
			title: localize('focusSideBar', "Side Bar"),
			primary: workbench.keys.focusSideBar[0].primary,
			when: workbench.keys.focusSideBar[0].when,
			scope: 'workbench',
			handler: () => workbench.focusSideBar()
		}),
		...workbench.keys.focusSideBar.slice(1)
			.map(rule => registerTuiKeybinding('workbench.action.focusSideBar', rule.primary, rule.when)),

		// **The `/` box's own `Tab`, declared once for all three panes that have one** — the completion
		// is one file (`viewRoot.ts`) and this is one rule, rather than a pair per pane. The two terms
		// are what tell it from the two rules below at the same key and the same weight, where a tie
		// is registration order: this fork states an exclusion in the terms, having no scoped context
		// key service to state it structurally (`§11.2`).
		registerTuiCommand({
			id: 'tscode.completeFilter',
			title: localize('tscode.completeFilter', "Complete"),
			primary: KeyCode.Tab,
			when: ContextKeyExpr.and(FilteringContext, EditorAreaFocusContext.negate()),
			scope: 'pane',
			handler: () => workbench.completeFilter(1)
		}),
		registerTuiCommand({
			id: 'tscode.completeFilterBack',
			title: localize('tscode.completeFilterBack', "Complete Back"),
			primary: KeyMod.Shift | KeyCode.Tab,
			when: ContextKeyExpr.and(FilteringContext, EditorAreaFocusContext.negate()),
			scope: 'pane',
			handler: () => workbench.completeFilter(-1)
		}),

		// `!tscodeFiltering` is what leaves `Tab` to that box. It is that key rather than
		// `!inputFocus` because only the box `Tab` means something in has to give the key up: a
		// commit message and a search query keep it.
		registerTuiCommand({
			id: 'tscode.focusNextView',
			title: localize('tscode.focusNextView', "Next View"),
			primary: workbench.keys.cycleForward,
			when: ContextKeyExpr.and(FilteringContext.negate(), EditorAreaFocusContext.negate(), MultipleViewsContext),
			scope: 'workbench',
			handler: () => workbench.focusViewBy(1)
		}),
		registerTuiCommand({
			id: 'tscode.focusPreviousView',
			title: localize('tscode.focusPreviousView', "Previous View"),
			primary: workbench.keys.cycleBackward,
			when: ContextKeyExpr.and(FilteringContext.negate(), EditorAreaFocusContext.negate(), MultipleViewsContext),
			scope: 'tabs',
			handler: () => workbench.focusViewBy(-1)
		}),

		registerTuiCommand({
			id: 'workbench.action.nextEditor',
			title: localize('openNextEditor', "Open Next Editor"),
			primary: workbench.keys.cycleForward,
			when: EditorAreaFocusContext,
			scope: 'workbench',
			handler: () => workbench.focusEditorBy(1)
		}),
		registerTuiCommand({
			id: 'workbench.action.previousEditor',
			title: localize('openPreviousEditor', "Open Previous Editor"),
			primary: workbench.keys.cycleBackward,
			when: EditorAreaFocusContext,
			scope: 'tabs',
			handler: () => workbench.focusEditorBy(-1)
		}),
		registerTuiCommand({
			id: 'workbench.action.closeActiveEditor',
			title: localize('closeEditor', "Close Editor"),
			primary: KeyMod.CtrlCmd | KeyCode.KeyW,
			when: ContextKeyExpr.and(EditorAreaFocusContext, EditorsVisibleContext),
			scope: 'workbench',
			handler: () => workbench.closeActiveEditor()
		}),
		registerTuiCommand({
			id: 'workbench.action.toggleSidebarVisibility',
			title: localize('toggleSidebar', "Toggle Primary Side Bar Visibility"),
			primary: KeyMod.CtrlCmd | KeyCode.KeyB,
			scope: 'tabs',
			handler: () => workbench.toggleSideBar()
		}),

		// `list.scrollLeft` and `list.scrollRight` are upstream's own ids, and upstream leaves both
		// **unbound**: a GUI list is scrolled sideways with a scrollbar or a wheel, so the commands
		// exist for a `keybindings.json` to reach and nothing else. Their vertical siblings there are
		// `Ctrl+Up` and `Ctrl+Down`, so this is that pair one axis over — and an arrow carries its
		// modifiers in the CSI parameter, which is what makes it deliverable at all.
		//
		// Only the forward one is on the status line; `Shift+Tab` and `Ctrl+Left` are both the other
		// half of a pair the row already names, and the keys overlay is where a pair is spelled out.
		registerTuiCommand({
			id: 'list.scrollRight',
			title: localize('list.scrollRight', "Scroll Right"),
			primary: KeyMod.CtrlCmd | KeyCode.RightArrow,
			when: CanScrollHorizontallyContext,
			scope: 'pane',
			handler: () => workbench.scrollPaneBy(1)
		}),
		registerTuiCommand({
			id: 'list.scrollLeft',
			title: localize('list.scrollLeft', "Scroll Left"),
			primary: KeyMod.CtrlCmd | KeyCode.LeftArrow,
			when: CanScrollHorizontallyContext,
			scope: 'tabs',
			handler: () => workbench.scrollPaneBy(-1)
		}),

		// **The layout's own two keyboard commands, at upstream's ids.** `BaseResizeViewAction`
		// resizes whichever part has focus through `layout.ts`'s `resizePart` — so the sash is the
		// *gesture* for a thing that was already a command, and only the key had to be chosen. Upstream
		// binds none, and its nearest neighbour by meaning, `workbench.action.zoomIn`/`zoomOut`, is
		// `Ctrl+=`/`Ctrl+-`, which a terminal has no control byte for: `Ctrl` reaches a letter and
		// nothing else. So the two characters that pair carries arrive on their own.
		registerTuiCommand({
			id: 'workbench.action.increaseViewSize',
			title: localize('increaseViewSize', "Increase Current View Size"),
			primary: KeyCode.Equal,
			when: ContextKeyExpr.and(InputFocusedContext.negate(), SideBarVisibleContext),
			scope: 'workbench',
			handler: () => workbench.resizePart(1)
		}),
		registerTuiCommand({
			id: 'workbench.action.decreaseViewSize',
			title: localize('decreaseViewSize', "Decrease Current View Size"),
			primary: KeyCode.Minus,
			when: ContextKeyExpr.and(InputFocusedContext.negate(), SideBarVisibleContext),
			scope: 'tabs',
			handler: () => workbench.resizePart(-1)
		}),

		// `paneview.ts:307–309` binds `LeftArrow` and `RightArrow` on a focused header to collapsing
		// and expanding, idempotently rather than as a toggle. A terminal's focus is the view rather
		// than its header — there is nothing else a header could be focused *for* here — so the pair
		// arrives shifted, because the bare arrows are the tree's own inside the pane below.
		//
		// `tscodeMultipleViews` is the condition exactly: `updateViewHeaders` makes a view collapsible
		// only where a container has a second one to give the rows to.
		registerTuiCommand({
			id: 'tscode.collapseView',
			title: localize('tscode.collapseView', "Collapse View"),
			primary: KeyMod.Shift | KeyCode.LeftArrow,
			when: ContextKeyExpr.and(InputFocusedContext.negate(), EditorAreaFocusContext.negate(), MultipleViewsContext),
			scope: 'tabs',
			handler: () => workbench.setViewExpanded(false)
		}),
		registerTuiCommand({
			id: 'tscode.expandView',
			title: localize('tscode.expandView', "Expand View"),
			primary: KeyMod.Shift | KeyCode.RightArrow,
			when: ContextKeyExpr.and(InputFocusedContext.negate(), EditorAreaFocusContext.negate(), MultipleViewsContext),
			scope: 'workbench',
			handler: () => workbench.setViewExpanded(true)
		}),

		registerTuiCommand({
			id: 'tscode.editInput',
			title: localize('tscode.editInput', "Edit"),
			primary: KeyCode.KeyI,
			when: ContextKeyExpr.and(CanEditInputContext, InputFocusedContext.negate()),
			scope: 'workbench',
			handler: () => workbench.editInput(true)
		}),
		// `Shift+F10` is upstream's own keyboard route to a context menu, and it reaches a terminal:
		// xterm spells it `\x1b[21;2~`, which `input.ts` decodes since the CSI modifier parameter
		// went in. The `when` clause keeps it off the status line of a pane whose rows have none.
		registerTuiCommand({
			id: 'tscode.showContextMenu',
			title: localize('tscode.showContextMenu', "Actions"),
			primary: KeyMod.Shift | KeyCode.F10,
			when: ContextKeyExpr.and(HasContextMenuContext, InputFocusedContext.negate()),
			scope: 'pane',
			handler: () => workbench.showContextMenu()
		}),

		// Upstream's own id for "show me what the keys do". Its surface there is an editor and here it
		// is the floating layer, because this fork has no settings editor — and the key is `?`, which
		// reaches a terminal as the character `Shift+/` produces (`keyboard.ts`). Upstream's own
		// `Ctrl+K Ctrl+S` is deliverable too and is the second binding, as it is there.
		registerTuiCommand({
			id: SHOW_KEYS_ID,
			title: localize('showKeys', "Keys"),
			primary: KeyMod.Shift | KeyCode.Slash,
			secondary: [KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyS)],
			when: InputFocusedContext.negate(),
			scope: 'workbench',
			handler: () => workbench.showKeys()
		}),

		// A box on the floating layer sets `inputFocus` too — that is what keeps every
		// single-character rule out of a picker — so this rule and upstream's
		// `workbench.action.closeQuickOpen` are both on `Escape` under conditions that hold together.
		// `inQuickOpen` is the key upstream tells them apart with, and `TerminalQuickInputService`
		// binds it from the same `onShow`/`onHide` pair `WorkbenchQuickInputService` does. Accessible
		// Help is also an `NSText` owner on macOS; its upstream context leaves Escape with that modal
		// surface instead of this pane-only command.
		registerTuiCommand({
			id: 'tscode.stopEditingInput',
			title: localize('tscode.stopEditingInput', "Stop Editing"),
			primary: KeyCode.Escape,
			when: StopEditingInputContext,
			scope: 'workbench',
			handler: () => workbench.editInput(false)
		})
	];

	return combinedDisposable(...disposables);
}
