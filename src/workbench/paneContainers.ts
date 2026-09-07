/*---------------------------------------------------------------------------------------------
 *  Side-bar container composition and the context keys its panes publish.
 *
 *  Container membership, order, descriptors and `when` clauses come directly from
 *  `IViewContainersRegistry` and `IViewsRegistry`. Active sections and focus remain here
 *  because this boot does not mount the browser `IViewsService` / `IViewDescriptorService` stack.
 *  The coverage audit records that concrete service-graph blocker.
 *
 *  **What is left to the terminal workbench is frame-specific state:**
 *
 *  | hook | why |
 *  | --- | --- |
 *  | `changed()` | restates the active selector and sections |
 *  | `sideBarFocused` | reports whether the side bar owns focus |
 *  | `watch()` | observes panes installed in the section stack |
 *  | `inputTaken` | reports whether a pane input owns the keyboard |
 *
 *  **The editor's keys are not here**, because a side bar does not own an editor area.
 *
 *  Upstream counterpart: src/vs/workbench/browser/parts/views/viewPaneContainer.ts
 *--------------------------------------------------------------------------------------------*/

import type { IViewDescriptor } from '../vs/workbench/common/views.js';

import { Event } from '../vs/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../vs/base/common/lifecycle.js';
import type { URI } from '../vs/base/common/uri.js';
import { ContextKeyExpression, IContextKey, IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../vs/platform/contextkey/common/contextkeys.js';
import { Registry } from '../vs/platform/registry/common/platform.js';
import {
	ActiveViewletContext, EditorAreaFocusContext, EditorsVisibleContext, FocusedViewContext, SidebarFocusContext
} from '../vs/workbench/common/contextkeys.js';
import { TEXT_FILE_EDITOR_ID } from '../vs/workbench/contrib/files/common/files.js';
import {
	Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation
} from '../vs/workbench/common/views.js';
import {
	CanEditInputContext, CanScrollHorizontallyContext, FilteringContext, HasContextMenuContext, MultipleViewsContext
} from './paneContext.js';
import { InteractionSessionOwner } from '../interactionSession.js';
import type { IPaneChromeProjectionSource } from './paneChromeProjection.js';
import { NavigatorChromeGateway, navigatorContainerRecords } from './navigatorChromeProjection.js';

const containersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

/**
 * What the side bar needs of a pane: an id to find a descriptor by, an open operation, a change to
 * listen to, and the states a `when` clause is written against.
 */
export interface IContainedPane extends IDisposable {

	/** The view id every `when` clause and `focusedView` is about. */
	readonly viewId: string;

	/** Fires whenever anything the pane shows changed — the rows, the header, the cursor. */
	readonly onDidChange: Event<void>;
	readonly paneChromeProjection: IPaneChromeProjectionSource;

	readonly canEdit: boolean;
	readonly editing: boolean;
	readonly filtering: boolean;
	readonly canScrollHorizontally: boolean;
	readonly hasContextMenu: boolean;

	open(): Promise<void>;
}

/** One view container of the side bar: the panes its views are, and which of them has focus. */
export interface IPaneContainer<P> {
	readonly container: ViewContainer;
	readonly panes: P[];
	view: number;
}

/** The descriptor `views.ts` registered a pane's view id with, or none for a pane with no view. */
export function descriptorOf(pane: { readonly viewId: string }): IViewDescriptor | undefined {
	return viewsRegistry.getView(pane.viewId) ?? undefined;
}

export interface IPaneInputFocusPublisher { publish(focused: boolean): void }
export interface INavigatorEditorContext {
	readonly count: number;
	readonly isFocused: boolean;
	readonly focusedViewId?: string;
	readonly activeResource?: URI;
	readonly editing?: boolean;
	readonly onDidChange?: Event<void>;
}

export interface INavigatorResourceContext { set(resource: URI | null | undefined): void }

export abstract class PaneContainers<P extends IContainedPane> extends Disposable {

	protected readonly containers: IPaneContainer<P>[] = [];
	private readonly containerSessions = this._register(new InteractionSessionOwner<{ readonly active: number }>('PaneContainers.container'));
	private readonly additions = this._register(new InteractionSessionOwner<{ readonly panes: readonly P[] }>('PaneContainers.add'));

	private readonly focusedView: IContextKey<string>;
	private readonly canEditInput: IContextKey<boolean>;
	private readonly filtering: IContextKey<boolean>;
	private readonly canScrollHorizontally: IContextKey<boolean>;
	private readonly hasContextMenu: IContextKey<boolean>;
	private readonly multipleViews: IContextKey<boolean>;
	private readonly sideBarFocus: IContextKey<boolean>;
	private readonly activeViewlet: IContextKey<string>;
	private readonly inputFocused: IContextKey<boolean> | undefined;
	private readonly navigatorEditorAreaFocus: IContextKey<boolean>;
	private readonly navigatorEditorsVisible: IContextKey<boolean>;
	protected readonly navigatorChromeProjection: NavigatorChromeGateway;

	constructor(protected readonly contextKeyService: IContextKeyService,
		private readonly inputFocus?: IPaneInputFocusPublisher,
		private readonly editorContext?: INavigatorEditorContext,
		private readonly resourceContext?: INavigatorResourceContext) {
		super();
		this.containerSessions.begin({ active: 0 });

		this.focusedView = FocusedViewContext.bindTo(contextKeyService);
		this.canEditInput = CanEditInputContext.bindTo(contextKeyService);
		this.filtering = FilteringContext.bindTo(contextKeyService);
		this.canScrollHorizontally = CanScrollHorizontallyContext.bindTo(contextKeyService);
		this.hasContextMenu = HasContextMenuContext.bindTo(contextKeyService);
		this.multipleViews = MultipleViewsContext.bindTo(contextKeyService);
		this.sideBarFocus = SidebarFocusContext.bindTo(contextKeyService);
		this.activeViewlet = ActiveViewletContext.bindTo(contextKeyService);
		this.inputFocused = inputFocus ? undefined : InputFocusedContext.bindTo(contextKeyService);
		this.navigatorEditorAreaFocus = EditorAreaFocusContext.bindTo(contextKeyService);
		this.navigatorEditorsVisible = EditorsVisibleContext.bindTo(contextKeyService);
		if (editorContext?.onDidChange) { this._register(editorContext.onDidChange(() => this.contextChanged())); }
		this.navigatorChromeProjection = this._register(new NavigatorChromeGateway(event => {
			if (event.kind === 'select-container') {
				const active = this.containers.findIndex(entry => entry.container.id === event.id);
				if (active < 0) { return false; }
				if (active !== this.active) { this.setActive(active); }
				const container = this.containers[active];
				return this.focusPane(this.shown(container)[Math.min(container.view, this.shown(container).length - 1)]);
			}
			const pane = this.containers.flatMap(entry => entry.panes).find(candidate => candidate.viewId === event.id);
			return this.focusPane(pane);
		}));
	}

	/** A container/section identity gesture selects its active pane and transfers semantic focus once. */
	private focusPane(pane: P | undefined): boolean {
		if (!pane) { return false; }
		// `ViewPaneContainer.openView` expands before it focuses. Keep that ordering at the
		// frontend-neutral boundary too: a collapsed native section has no visible body to receive
		// first responder, and the browser counterpart likewise cannot focus a body it has not
		// rendered. The pane remains the only owner of its expanded state; this is the same semantic
		// input its header and the shared collapse/expand commands dispatch.
		const target = pane.paneChromeProjection;
		if (!target.snapshot.expanded) {
			if (!target.dispatch({ generation: target.snapshot.generation, kind: 'set-expanded', expanded: true })) {
				return false;
			}
		}
		this.navigatorChromeProjection.publish({ focusedSectionId: pane.viewId });
		for (const candidate of this.containers.flatMap(entry => entry.panes)) {
			const source = candidate.paneChromeProjection;
			source.dispatch({ generation: source.snapshot.generation, kind: 'focus', focused: candidate === pane });
		}
		this.changed();
		return true;
	}

	protected get container(): IPaneContainer<P> | undefined {
		return this.containers[this.active];
	}
	protected paneById(id: string | undefined): P | undefined {
		return id ? this.containers.flatMap(entry => entry.panes).find(pane => pane.viewId === id) : undefined;
	}

	protected get active(): number {
		return this.containerSessions.current?.value.active ?? 0;
	}
	protected set active(active: number) { this.setActive(active); }

	protected setActive(active: number): void {
		this.containerSessions.begin({ active });
		this.publishNavigatorProjection();
	}

	private publishNavigatorProjection(): void {
		const container = this.container;
		const panes = container ? this.shown(container) : [];
		const focused = this.navigatorChromeProjection.snapshot.focusedSectionId;
		const containers = navigatorContainerRecords(this.containers.map(entry => entry.container));
		const sections = panes.map((pane, order) => {
			const chrome = pane.paneChromeProjection.snapshot;
			return { id: chrome.identity, title: chrome.title, order, expanded: chrome.expanded };
		});
		const activeContainerId = container?.container.id;
		const focusedSectionId = focused && panes.some(pane => pane.viewId === focused) ? focused : undefined;
		const current = this.navigatorChromeProjection.snapshot;
		if (current.activeContainerId === activeContainerId && current.focusedSectionId === focusedSectionId
			&& JSON.stringify(current.containers) === JSON.stringify(containers)
			&& JSON.stringify(current.sections) === JSON.stringify(sections)) { return; }
		this.navigatorChromeProjection.publish({
			containers,
			activeContainerId: container?.container.id,
			sections,
			focusedSectionId
		});
	}

	/**
	 * Adds panes to the side bar, opens them and restates the view. Which container each one lands
	 * in, and in what order the containers and their views sit, is read off the registries rather
	 * than off the order this is called in — `IViewsRegistry.getViewContainer` answers for the
	 * pane's view id, and the descriptor's `order` is what the views are sorted by.
	 */
	protected async addPanes(panes: readonly P[]): Promise<void> {
		const addition = this.additions.begin({ panes });
		let committed = false;
		for (const pane of panes) {
			addition.add(toDisposable(() => { if (!committed) { pane.dispose(); } }));
		}

		let targets: { readonly pane: P; readonly container: ViewContainer }[];
		try {
			targets = panes.map(pane => {
				const container = viewsRegistry.getViewContainer(pane.viewId);
				if (!container || containersRegistry.getViewContainerLocation(container) !== ViewContainerLocation.Sidebar) {
					throw new Error(`${pane.viewId} is not a view of a side bar container, so there is nowhere to put it.`);
				}
				return { pane, container };
			});
		} catch (error) {
			this.additions.end(addition, 'failed');
			throw error;
		}

		try {
			for (const { pane } of targets) {
				await pane.open();
				if (!this.additions.isCurrent(addition)) { return; }
			}
		} catch (error) {
			this.additions.end(addition, 'failed');
			throw error;
		}

		if (!this.additions.isCurrent(addition)) { return; }
		committed = true;
		for (const { pane, container } of targets) {
			// Registered as it is added, because adding a pane is taking ownership of it.
			this.entryFor(container).panes.push(this._register(pane));
			this.watch(pane);
			this._register(pane.paneChromeProjection.onDidSnapshot(() => this.publishNavigatorProjection()));
		}

		for (const entry of this.containers) {
			entry.panes.sort((a, b) => (descriptorOf(a)?.order ?? 0) - (descriptorOf(b)?.order ?? 0));
		}

		addition.run(() => { this.publishNavigatorProjection(); this.changed(); });
	}

	/** The container's entry, inserted in the order the registry gives its containers. */
	private entryFor(container: ViewContainer): IPaneContainer<P> {
		const existing = this.containers.find(entry => entry.container === container);
		if (existing) {
			return existing;
		}

		const entry: IPaneContainer<P> = { container, panes: [], view: 0 };
		this.containers.push(entry);
		this.containers.sort((a, b) => (a.container.order ?? 0) - (b.container.order ?? 0));

		return entry;
	}

	/**
	 * The panes of a container that are on screen right now. A view whose `when` clause does not
	 * hold is not on screen at all, which is the answer `IViewDescriptorService` gives it in tscode.
	 */
	protected shown(container: IPaneContainer<P>): P[] {
		return container.panes.filter(pane => this.applies(descriptorOf(pane)?.when));
	}

	/** Whether a `when` clause holds, over the one context service this fork has. */
	protected applies(when: ContextKeyExpression | undefined): boolean {
		return !when || this.contextKeyService.contextMatchesRules(when);
	}

	/**
	 * The nine keys a side bar answers, read off whichever pane has the keyboard.
	 *
	 * `inputFocus` is what every single-character rule is already scoped out of, as it is upstream
	 * where a focused box owns the DOM focus. `canScrollHorizontally` was measured by the last
	 * layout, which is the frame the user is looking at when they reach for the key. `multipleViews`
	 * is passed in rather than derived, because what counts as a second view on screen is the
	 * frame's own list of the views it laid out.
	 */
	protected publishPaneContext(
		pane: P | undefined,
		multipleViews: boolean,
		inputTaken = this.inputTaken,
		focusedView = pane?.viewId ?? ''
	): void {
		this.focusedView.set(focusedView);
		const focused = inputTaken || !!pane?.editing;
		this.inputFocus?.publish(focused);
		this.inputFocused?.set(focused);
		this.canEditInput.set(!!pane?.canEdit);
		this.filtering.set(!!pane?.filtering);
		this.canScrollHorizontally.set(!!pane?.canScrollHorizontally);
		this.hasContextMenu.set(!!pane?.hasContextMenu);
		this.multipleViews.set(multipleViews);
		this.sideBarFocus.set(this.sideBarFocused);
		this.activeViewlet.set(this.container?.container.id ?? '');
	}

	/** One editor/pane context decision for the terminal projection. */
	protected publishWorkbenchContext(pane: P | undefined, multipleViews: boolean): void {
		const editorFocused = this.editorContext?.isFocused ?? false;
		this.publishPaneContext(editorFocused ? undefined : pane, editorFocused ? false : multipleViews,
			editorFocused && !!this.editorContext?.editing,
			editorFocused ? this.editorContext?.focusedViewId ?? TEXT_FILE_EDITOR_ID : undefined);
		this.navigatorEditorAreaFocus.set(editorFocused);
		this.navigatorEditorsVisible.set((this.editorContext?.count ?? 0) > 0);
		// The active resource is workbench state, not renderer state. Upstream keeps these keys
		// current even while the side bar has focus so a canonical editor command guarded on
		// `resourceLangId` resolves when focus returns there.
		this.resourceContext?.set(this.editorContext?.activeResource ?? null);
	}

	protected contextChanged(): void { this.publishNavigatorProjection(); this.changed(); }

	//#region --- what a frame decides

	/** The view, restated from the containers. `addPanes` ends here. */
	protected abstract changed(): void;

	/** Whether the keyboard is in the side bar at all, which only the frame knows. */
	protected abstract get sideBarFocused(): boolean;

	/** A pane the side bar has taken ownership of. */
	protected watch(pane: P): void { }

	/** Whether something other than a pane has the keyboard — a terminal's floating layer. */
	protected get inputTaken(): boolean {
		return false;
	}

	//#endregion
}
