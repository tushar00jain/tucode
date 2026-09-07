/*---------------------------------------------------------------------------------------------
 *  The `/` box, as one widget for every pane that has one — the GUI half of what
 *  `viewRoot.ts` holds the grammar for, made of the DOM upstream already has.
 *
 *  **The antecedent is `FilterViewPane`** (`browser/parts/views/viewPane.ts:758`), which is how
 *  upstream itself puts a filter box on a pane: an input box in a `.viewpane-filter-container`
 *  at the top of the pane body, with `layoutBody` handing the body's remaining height to what is
 *  underneath it. What is *not* taken from it is `FilterWidget`, its badge and its "More Filters"
 *  toolbar — that toolbar swallows `Tab` at the input element (`viewFilter.ts:286`), which is the
 *  one key this box has to let through to the keymap.
 *
 *  **The keyboard contract**: `Enter` and `Escape` are answered here, at the input element, before
 *  the window-level resolver sees them — the same precedence upstream's own filter box takes. `Tab`
 *  and `Shift+Tab` are *not*: they are keymap rows guarded on `keymap.ts`'s `FilteringContext`,
 *  which this box is the only thing that publishes, and they arrive as the two commands below.
 *
 *  **Losing the keyboard is the third key.** Because `Enter` and `Escape` are answered at the input
 *  element, a click anywhere else — a tab, the activity bar, another pane — leaves a box no key can
 *  reach, over a filtered tree, still publishing `FilteringContext`: `Tab` then completes in a box
 *  the user has walked away from instead of switching editors, everywhere. So a blur is `Escape`.
 *
 *  Upstream counterpart: `FilterViewPane`/`FilterWidget` — the mounting is theirs, the contract is not.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../base/browser/dom.js';
import { IKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { InputBox } from '../../../base/browser/ui/inputbox/inputBox.js';
import { KeyCode } from '../../../base/common/keyCodes.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { defaultInputBoxStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { FilteringContext } from './keymap.js';
import { IViewRoot, IViewRootBox } from './viewRootController.js';

/** The panes that have a `/`, by view id — what the per-pane `/` command resolves through. */
const viewRoots = new Map<string, IViewRoot>();

/**
 * Register `root` as the pane's, until something else is. **The deregistration is identity-checked**,
 * which is `SequencerByKey`'s own rule at `async.ts:348` and is not optional here: a view moved
 * between containers is disposed *after* its replacement has been constructed, so a bare `delete`
 * would unregister the live root and leave `/` doing nothing at all in that pane for the rest of the
 * session. `openBox` below is guarded the same way for the same reason.
 */
function registerViewRoot(viewId: string, root: IViewRoot): IDisposable {
	viewRoots.set(viewId, root);

	return toDisposable(() => {
		if (viewRoots.get(viewId) === root) {
			viewRoots.delete(viewId);
		}
	});
}

/** The one box that is open, which is what `Tab` completes in. Only ever one: opening focuses it. */
let openBox: ViewRootBox | undefined;

/**
 * The `/` command for one pane: `/` is guarded on that pane being focused, so the command has only
 * to find the pane's own view root. G3b and G3c each add one call.
 *
 * **The title is not decoration.** `?` lists a row only where `commandTitle(id)` answers, and a bare
 * `CommandsRegistry.registerCommand(id, handler)` carries no metadata for it to read — so a landed
 * `/` key was dropped from the list that offers it as "a command no phase has registered".
 * `metadata.description` is what this port's own commands answer with
 * (`keymap.contribution.ts:308`), and one word covers all three panes.
 */
export function registerViewRootCommand(commandId: string, viewId: string, title: string): void {
	CommandsRegistry.registerCommand({
		id: commandId,
		handler: () => viewRoots.get(viewId)?.open(),
		metadata: { description: title, args: [] }
	});
}

CommandsRegistry.registerCommand('tscode.completeFilter', () => openBox?.root.complete(1));
CommandsRegistry.registerCommand('tscode.completeFilterBack', () => openBox?.root.complete(-1));

export class ViewRootBox extends Disposable implements IViewRootBox {

	/**
	 * What the box costs the pane below it — the input box's own 24px and the margin around it,
	 * which is what `layoutBody` takes off the tree's height while the box is open. It is a
	 * constant rather than a measurement because `layoutBody` asks for it before a layout has run.
	 */
	static readonly HEIGHT = 32;

	readonly element: HTMLElement;

	private readonly input: InputBox;
	private readonly filtering: IContextKey<boolean>;

	/** Whether the value being written is the box's own completion rather than something typed. */
	private writing = false;

	private _isOpen = false;

	constructor(
		viewId: string,
		readonly root: IViewRoot,
		placeholder: string,
		@IContextViewService contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super();

		this.filtering = FilteringContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.filtering.reset()));

		this._register(registerViewRoot(viewId, root));

		// `.viewpane-filter-container > .viewpane-filter` is what `views.css:292` styles a pane's
		// filter box by, so the box looks like upstream's own without a rule of ours.
		this.element = DOM.$('.viewpane-filter-container');
		this.element.style.display = 'none';
		this.element.style.margin = '4px 8px';
		this.element.style.height = `${ViewRootBox.HEIGHT - 8}px`;

		const filter = DOM.append(this.element, DOM.$('.viewpane-filter'));
		this.input = this._register(new InputBox(filter, contextViewService, {
			placeholder,
			ariaLabel: placeholder,
			inputBoxStyles: defaultInputBoxStyles
		}));

		this._register(this.input.onDidChange(value => {
			if (!this.writing) {
				this.root.apply(value);
			}
		}));

		this._register(DOM.addStandardDisposableListener(this.input.inputElement, DOM.EventType.KEY_DOWN, event => this.onKeyDown(event)));
		this._register(DOM.addDisposableListener(this.input.inputElement, DOM.EventType.BLUR, () => this.onBlur()));
	}

	/** Where the box sits: immediately above the pane's own content, inside the pane body. */
	mount(before: HTMLElement): void {
		before.parentElement?.insertBefore(this.element, before);
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	/** What the box costs the rows below it, which is nothing at all while it is closed. */
	get height(): number {
		return this._isOpen ? ViewRootBox.HEIGHT : 0;
	}

	/** What the box reads. Writing it is a completion, so it does not run as a query. */
	get value(): string {
		return this.input.value;
	}

	set value(value: string) {
		this.writing = true;
		try {
			this.input.value = value;
		} finally {
			this.writing = false;
		}
	}

	open(query: string): void {
		// One box at a time, because one context key answers for all of them: a second pane's `/`
		// puts the first pane's root back rather than leaving a query nothing can now reach.
		if (openBox && openBox !== this) {
			openBox.root.cancel();
		}

		this._isOpen = true;
		openBox = this;
		this.element.style.display = '';
		this.value = query;
		this.filtering.set(true);
		this.input.focus();
	}

	/**
	 * The box goes, and `FilteringContext` with it. **It answers whether the box still had the
	 * keyboard**, which is what tells an `Escape` from a blur: the pane takes the keyboard back after
	 * the first and must not after the second, where it is already wherever the user has just clicked.
	 */
	close(): boolean {
		const hadKeyboard = this.input.hasFocus();

		this._isOpen = false;
		if (openBox === this) {
			openBox = undefined;
		}
		this.filtering.reset();
		this.element.style.display = 'none';

		return hadKeyboard;
	}

	/**
	 * `Enter` and `Escape`, answered here rather than as keymap rows: a widget-local handler runs
	 * before the window-level resolver, which is what keeps `Escape` from reaching this port's own
	 * `tscode.stopEditingInput` — that command leaves a box, and this one has a root to put back.
	 */
	private onKeyDown(event: IKeyboardEvent): void {
		if (event.equals(KeyCode.Enter)) {
			this.root.commit();
		} else if (event.equals(KeyCode.Escape)) {
			this.root.cancel();
		} else {
			return;
		}

		event.stopPropagation();
		event.preventDefault();
	}

	/**
	 * Focus leaving the box, which is `Escape`. **Cancel rather than commit**, because commit is the
	 * arm that acts: it re-roots the pane on the row the ranking happened to land on and, in the
	 * explorer, *opens a file* — a stray click on a tab may not do that. Cancel puts back the root the
	 * box opened on, which is the state the pane was already in, so nothing the user made is lost.
	 *
	 * `close()` clears `_isOpen` before it hides the element, so the blur that hiding produces is not
	 * a second cancel.
	 */
	private onBlur(): void {
		if (this._isOpen) {
			this.root.cancel();
		}
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}
}
