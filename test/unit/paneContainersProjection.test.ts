import assert from 'node:assert/strict';
import { Event } from '../../src/vs/base/common/event.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { Registry } from '../../src/vs/platform/registry/common/platform.js';
import { SyncDescriptor } from '../../src/vs/platform/instantiation/common/descriptors.js';
import { localize2 } from '../../src/vs/nls.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../src/vs/workbench/common/views.js';
import { INavigatorEditorContext, INavigatorResourceContext, PaneContainers } from '../../src/workbench/paneContainers.js';
import { PaneChromeProjectionGateway } from '../../src/workbench/paneChromeProjection.js';
import { describe, it } from 'node:test';

const context = () => ({
	createKey: (_key: string, value: unknown) => ({ set(next: unknown) { value = next; }, reset() { }, get: () => value }),
	contextMatchesRules: () => true
}) as never;

class Pane {
	readonly onDidChange = Event.None;
	readonly chrome: PaneChromeProjectionGateway;
	readonly paneChromeProjection: PaneChromeProjectionGateway;
	readonly canEdit = false; readonly editing = false; readonly filtering = false;
	readonly canScrollHorizontally = false; readonly hasContextMenu = false;
	opened = 0; disposed = false;
	constructor(readonly viewId: string, private readonly fail = false, private readonly gate?: Promise<void>) {
		this.chrome = new PaneChromeProjectionGateway({ generation: 1, identity: viewId, title: viewId,
			header: [], textInputValue: undefined, canEdit: false, editing: false, filtering: false, expanded: true, focused: false }, event => {
				if (event.kind === 'set-expanded') {
					const snapshot = this.chrome.snapshot;
					this.chrome.publish({ identity: snapshot.identity, title: snapshot.title, header: snapshot.header,
						textInputValue: snapshot.textInputValue, canEdit: snapshot.canEdit, editing: snapshot.editing,
						filtering: snapshot.filtering, expanded: event.expanded });
				}
				return true;
			});
		this.paneChromeProjection = this.chrome;
	}
	setExpanded(expanded: boolean) {
		return this.chrome.dispatch({ generation: this.chrome.snapshot.generation, kind: 'set-expanded', expanded });
	}
	async open() { this.opened++; await this.gate; if (this.fail) throw new Error('open failed'); }
	dispose() { this.disposed = true; this.chrome.dispose(); }
}

class Controller extends PaneContainers<Pane> {
	changes = 0;
	constructor(contextKeyService: never, editorContext?: INavigatorEditorContext,
		resourceContext?: INavigatorResourceContext) {
		super(contextKeyService, undefined, editorContext, resourceContext);
	}
	protected changed(): void { this.changes++; }
	protected get sideBarFocused(): boolean { return true; }
	async add(...panes: Pane[]) { await this.addPanes(panes); }
	get snapshot() { return this.navigatorChromeProjection.snapshot; }
	dispatch(event: Parameters<typeof this.navigatorChromeProjection.dispatch>[0]) { return this.navigatorChromeProjection.dispatch(event); }
	publishEditorContext() { this.publishWorkbenchContext(undefined, false); }
}

describe('neutral navigator container projection', () => {
	it('publishes the active editor resource through the shared workbench context owner', () => {
		const published: Array<URI | null | undefined> = [];
		const activeResource = URI.file('/workspace/README.md');
		const controller = new Controller(context(), {
			count: 1, isFocused: true, focusedViewId: 'workbench.editors.files.textFileEditor', activeResource
		}, { set: value => published.push(value) });
		controller.publishEditorContext();
		assert.deepEqual(published, [activeResource]);
		controller.dispose();
	});

	it('owns registry order, open failure, ID input, replacement and repeated snapshots', async () => {
		const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
		const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
		const token = `${Date.now()}-${Math.random()}`;
		const ctor = new SyncDescriptor(class { });
		const left = containers.registerViewContainer({ id: `left-${token}`, title: localize2('left', 'Left'), ctorDescriptor: ctor, order: 2 }, ViewContainerLocation.Sidebar);
		const right = containers.registerViewContainer({ id: `right-${token}`, title: localize2('right', 'Right'), ctorDescriptor: ctor, order: 1 }, ViewContainerLocation.Sidebar);
		const leftView = { id: `left.view-${token}`, name: localize2('leftView', 'Left view'), ctorDescriptor: ctor, order: 0 };
		const rightView = { id: `right.view-${token}`, name: localize2('rightView', 'Right view'), ctorDescriptor: ctor, order: 0 };
		views.registerViews([leftView], left); views.registerViews([rightView], right);
		try {
			const failed = new Controller(context());
			const bad = new Pane(leftView.id, true);
			await assert.rejects(failed.add(bad), /open failed/);
			assert.equal(bad.disposed, true);
			failed.dispose();

			let release!: () => void;
			const delayed = new Promise<void>(resolve => { release = resolve; });
			const replacing = new Controller(context());
			const stale = new Pane(leftView.id, false, delayed);
			const staleOpen = replacing.add(stale);
			await replacing.add(new Pane(rightView.id));
			release(); await staleOpen;
			assert.equal(stale.disposed, true, 'replaced async pane survived its generation');
			assert.deepEqual(replacing.snapshot.sections.map(record => record.id), [rightView.id]);
			replacing.dispose();

			const controller = new Controller(context());
			const a = new Pane(leftView.id); const b = new Pane(rightView.id);
			await controller.add(a, b);
			assert.equal(a.setExpanded(false), true);
			assert.equal(a.chrome.snapshot.expanded, false);
			assert.deepEqual(controller.snapshot.containers.map(record => record.id), [right.id, left.id]);
			assert.equal(controller.snapshot.activeContainerId, right.id);
			assert.deepEqual(controller.snapshot.sections.map(record => record.id), [rightView.id]);
			const generation = controller.snapshot.generation;
			assert.equal(controller.dispatch({ generation, kind: 'select-container', id: left.id }), true);
			assert.equal(controller.snapshot.activeContainerId, left.id);
			assert.equal(controller.snapshot.focusedSectionId, leftView.id);
			assert.equal(a.chrome.snapshot.expanded, true, 'focusing a collapsed view did not expand it first');
			assert.equal(a.chrome.snapshot.focused, true);
			assert.equal(b.chrome.snapshot.focused, false);
			assert.equal(controller.dispatch({ generation, kind: 'select-container', id: right.id }), false, 'stale input acted');
			assert.equal(controller.dispatch({ generation: controller.snapshot.generation, kind: 'select-container', id: left.id }), true,
				'same-selected container did not retain the general focus gesture');
			assert.equal(controller.dispatch({ generation: controller.snapshot.generation, kind: 'focus-section', id: leftView.id }), true);
			assert.equal(controller.snapshot.focusedSectionId, leftView.id);
			const equivalentGeneration = controller.snapshot.generation;
			a.chrome.publish({ identity: leftView.id, title: leftView.id, header: [], textInputValue: undefined,
				canEdit: false, editing: false, filtering: false, expanded: true });
			assert.equal(controller.snapshot.generation, equivalentGeneration, 'equivalent pane repaint replaced navigator layout');
			const beforeRepeatedPublication = controller.snapshot.generation;
			for (let index = 0; index < 20; index++) {
				a.chrome.publish({ identity: leftView.id, title: leftView.id, header: [], textInputValue: undefined,
					canEdit: false, editing: false, filtering: false, expanded: !!(index & 1) });
			}
			assert.equal(controller.snapshot.generation, beforeRepeatedPublication + 20);
			assert.equal(controller.snapshot.sections[0].expanded, true);
			controller.dispose();
			assert.equal(a.disposed && b.disposed, true);
		} finally {
			views.deregisterViews([leftView], left); views.deregisterViews([rightView], right);
			containers.deregisterViewContainer(left); containers.deregisterViewContainer(right);
		}
	});
});
