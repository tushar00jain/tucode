import type { ViewContainer } from '../vs/workbench/common/views.js';
import { ThemeIcon } from '../vs/base/common/themables.js';
import { URI } from '../vs/base/common/uri.js';
import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { nextInputTraceEventId, recordInputStage } from '../input/inputTrace.js';
import { IContextKeyService } from '../vs/platform/contextkey/common/contextkey.js';
import { Registry } from '../vs/platform/registry/common/platform.js';
import {
	Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation
} from '../vs/workbench/common/views.js';

const containersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

export interface INavigatorSelectorRecord {
	readonly id: string;
	readonly title: string;
	readonly icon: { readonly kind: 'theme'; readonly id: string } | { readonly kind: 'file'; readonly path: string } | undefined;
}
export interface INavigatorSectionRecord { readonly id: string; readonly title: string; readonly order: number; readonly expanded: boolean }
export interface INavigatorChromeSnapshot {
	readonly generation: number;
	readonly activeContainerId: string | undefined;
	readonly focusedSectionId: string | undefined;
	readonly containers: readonly INavigatorSelectorRecord[];
	readonly sections: readonly INavigatorSectionRecord[];
}
export type NavigatorChromeInputEvent =
	| { readonly generation: number; readonly kind: 'select-container'; readonly id: string }
	| { readonly generation: number; readonly kind: 'focus-section'; readonly id: string };
export interface INavigatorChromeSource {
	readonly snapshot: INavigatorChromeSnapshot;
	readonly onDidSnapshot: Event<INavigatorChromeSnapshot>;
	dispatch(event: NavigatorChromeInputEvent): boolean;
}

export function navigatorContainerRecords(containers: readonly ViewContainer[]): readonly INavigatorSelectorRecord[] {
	return Object.freeze(containers.map(container => {
		const title = typeof container.title === 'string' ? container.title : container.title.value;
		const icon = ThemeIcon.isThemeIcon(container.icon) ? { kind: 'theme' as const, id: container.icon.id }
			: URI.isUri(container.icon) ? { kind: 'file' as const, path: container.icon.fsPath } : undefined;
		return Object.freeze({ id: container.id, title, icon });
	}));
}

export function navigatorChromeSnapshot(value: INavigatorChromeSnapshot): INavigatorChromeSnapshot {
	for (const records of [value.containers, value.sections]) {
		const ids = new Set<string>();
		for (const record of records) {
			if (!record.id || ids.has(record.id)) { throw new Error(`duplicate navigator chrome identity ${record.id}`); }
			ids.add(record.id);
		}
	}
	if (value.activeContainerId !== undefined && !value.containers.some(record => record.id === value.activeContainerId)) { throw new Error('orphan active navigator container'); }
	if (value.focusedSectionId !== undefined && !value.sections.some(record => record.id === value.focusedSectionId)) { throw new Error('orphan focused navigator section'); }
	return Object.freeze({ ...value, containers: Object.freeze(value.containers.map(record => Object.freeze({ ...record }))),
		sections: Object.freeze([...value.sections].sort((a, b) => a.order - b.order).map(record => Object.freeze({ ...record }))) });
}

export class NavigatorChromeGateway extends Disposable implements INavigatorChromeSource {
	private current = navigatorChromeSnapshot({ generation: 1, activeContainerId: undefined, focusedSectionId: undefined,
		containers: [], sections: [] });
	private readonly _onDidSnapshot = this._register(new Emitter<INavigatorChromeSnapshot>());
	readonly onDidSnapshot = this._onDidSnapshot.event;
	constructor(private readonly handle: (event: NavigatorChromeInputEvent) => boolean) { super(); }
	get snapshot(): INavigatorChromeSnapshot { return this.current; }
	publish(update: Partial<Omit<INavigatorChromeSnapshot, 'generation'>>): void {
		this.current = navigatorChromeSnapshot({ ...this.current, ...update, generation: this.current.generation + 1 });
		this._onDidSnapshot.fire(this.current);
	}
	dispatch(event: NavigatorChromeInputEvent): boolean {
		const eventId = nextInputTraceEventId();
		if (event.generation !== this.current.generation) {
			recordInputStage(eventId, 'navigator.gateway.rejected-generation', { eventGeneration: event.generation, currentGeneration: this.current.generation, kind: event.kind, id: event.id, activeContainerId: this.current.activeContainerId ?? 'none' });
			return false;
		}
		const exists = event.kind === 'select-container' ? this.current.containers.some(record => record.id === event.id)
			: this.current.sections.some(record => record.id === event.id);
		const accepted = exists && this.handle(event);
		recordInputStage(eventId, accepted ? 'navigator.gateway.accepted' : 'navigator.gateway.rejected', { currentGeneration: this.current.generation, kind: event.kind, id: event.id, exists, activeContainerId: this.current.activeContainerId ?? 'none' });
		return accepted;
	}
}

/** Registry-backed navigator chrome for a frontend that has not mounted pane bodies yet. */
export class RegistryNavigatorChromeController extends Disposable implements INavigatorChromeSource {
	private readonly gateway = this._register(new NavigatorChromeGateway(event => this.handle(event)));
	private activeContainerId: string | undefined;
	private focusedSectionId: string | undefined;

	readonly onDidSnapshot = this.gateway.onDidSnapshot;

	constructor(private readonly contextKeyService: IContextKeyService) {
		super();
		this._register(containersRegistry.onDidRegister(() => this.refresh()));
		this._register(containersRegistry.onDidDeregister(() => this.refresh()));
		this._register(viewsRegistry.onViewsRegistered(() => this.refresh()));
		this._register(viewsRegistry.onViewsDeregistered(() => this.refresh()));
		this._register(viewsRegistry.onDidChangeContainer(() => this.refresh()));
		this._register(contextKeyService.onDidChangeContext(() => this.refresh()));
		this.refresh();
	}

	get snapshot(): INavigatorChromeSnapshot { return this.gateway.snapshot; }
	dispatch(event: NavigatorChromeInputEvent): boolean { return this.gateway.dispatch(event); }

	private handle(event: NavigatorChromeInputEvent): boolean {
		if (event.kind === 'select-container') {
			this.activeContainerId = event.id;
			this.focusedSectionId = this.sections(event.id)[0]?.id;
		} else {
			this.focusedSectionId = event.id;
		}
		this.refresh();
		return true;
	}

	private sections(containerId: string | undefined): readonly INavigatorSectionRecord[] {
		const container = containerId ? containersRegistry.get(containerId) : undefined;
		if (!container) { return []; }
		return viewsRegistry.getViews(container)
			.filter(view => !view.when || this.contextKeyService.contextMatchesRules(view.when))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
			.map((view, order) => ({
				id: view.id,
				title: typeof view.name === 'string' ? view.name : view.name.value,
				order,
				expanded: true
			}));
	}

	private refresh(): void {
		const containers = containersRegistry.getViewContainers(ViewContainerLocation.Sidebar)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		if (!this.activeContainerId || !containers.some(container => container.id === this.activeContainerId)) {
			this.activeContainerId = containers[0]?.id;
		}
		const sections = this.sections(this.activeContainerId);
		if (!this.focusedSectionId || !sections.some(section => section.id === this.focusedSectionId)) {
			this.focusedSectionId = sections[0]?.id;
		}
		const next = {
			containers: navigatorContainerRecords(containers),
			activeContainerId: this.activeContainerId,
			sections,
			focusedSectionId: this.focusedSectionId
		};
		const current = this.gateway.snapshot;
		if (current.activeContainerId === next.activeContainerId && current.focusedSectionId === next.focusedSectionId
			&& JSON.stringify(current.containers) === JSON.stringify(next.containers)
			&& JSON.stringify(current.sections) === JSON.stringify(next.sections)) { return; }
		this.gateway.publish(next);
	}
}
