import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Emitter } from '../../src/vs/base/common/event.js';
import { Disposable } from '../../src/vs/base/common/lifecycle.js';
import { ITerminalEditorBackend } from '../../src/terminal/terminalEditorController.js';
import { TerminalCollectionController } from '../../src/terminal/terminalCollectionController.js';
import { ITerminalFindSnapshot } from '../../src/terminal/terminalProjection.js';

class Backend extends Disposable implements ITerminalEditorBackend {
	private readonly changed = new Emitter<void>(); readonly onDidChange = this.changed.event;
	private readonly didExit = new Emitter<number | undefined>(); readonly onDidExit = this.didExit.event;
	readonly title: string; exited = false; exitCode: number | undefined; cursor = { column: 2, row: 0 };
	logicalText = { value: '界🙂', cursorOffset: 3 }; scrollTop = 0; bracketedPasteMode = false; alternateBufferActive = false; disposed = false;
	readonly commandDecorations = Object.freeze([]);
	find: Readonly<ITerminalFindSnapshot> = Object.freeze({ visible: false, query: '', resultIndex: -1, resultCount: 0, decorations: Object.freeze([]) });
	onDispose: (() => void) | undefined;
	readonly writes: string[] = []; readonly pastes: string[] = [];
	constructor(readonly id: string) { super(); this.title = id; }
	async start() { this.changed.fire(); }
	resize() { }
	scroll(lines: number) { this.scrollTop = Math.max(0, this.scrollTop + lines); }
	scrollPage(pages: -1 | 1) { this.scrollTop = Math.max(0, this.scrollTop + pages * 23); this.changed.fire(); }
	findAction(action: 'open' | 'query' | 'next' | 'previous' | 'close', query?: string) {
		this.find = Object.freeze({ visible: action !== 'close', query: query ?? this.find.query,
			resultIndex: -1, resultCount: 0, decorations: Object.freeze([]) }); this.changed.fire();
	}
	write(value: string) { this.writes.push(value); }
	paste(value: string) { this.pastes.push(value); }
	projectRows() { return Object.freeze([{ id: `${this.id}:0`, wrapped: false, runs: Object.freeze([{ text: '界🙂', cells: 4 }]) }]); }
	async whenSettled() { }
	override dispose() { this.disposed = true; this.onDispose?.(); this.changed.dispose(); this.didExit.dispose(); super.dispose(); }
	exit(code: number) { this.exited = true; this.exitCode = code; this.didExit.fire(code); }
}

function dispatch(controller: TerminalCollectionController, event: any) {
	const snapshot = controller.projection.snapshot;
	return controller.projection.dispatch({ ...event, collectionId: snapshot.collectionId, generation: snapshot.generation });
}

describe('terminal collection projection controller', () => {
	it('owns terminal groups and splits one group into two independent pane sessions', async () => {
		const created: Array<{ id: string; profileId: string | undefined; parentTerminalId: string | undefined; backend: Backend }> = [];
		const controller = new TerminalCollectionController('split', { create: async (id, profileId, parentTerminalId) => {
			const backend = new Backend(id); created.push({ id, profileId, parentTerminalId, backend }); return backend;
		} });
		try {
			dispatch(controller, { kind: 'create' });
			await controller.whenSettled();
			const first = controller.projection.snapshot.sessions[0];
			assert.deepEqual(controller.projection.snapshot.groups.map(group => group.terminalIds), [[first.terminalId]]);

			assert.equal(dispatch(controller, { kind: 'split' }), true);
			await controller.whenSettled();
			let snapshot = controller.projection.snapshot;
			assert.equal(snapshot.groups.length, 1);
			assert.equal(snapshot.groups[0].terminalIds.length, 2);
			assert.equal(snapshot.groups[0].activeTerminalId, snapshot.sessions[1].terminalId);
			assert.equal(snapshot.activeTerminalId, snapshot.sessions[1].terminalId);
			assert.equal(created[1].parentTerminalId, first.terminalId);
			created[1].backend.write('pane-two');
			assert.deepEqual(created[0].backend.writes, []);
			assert.deepEqual(created[1].backend.writes, ['pane-two']);

			const firstCurrent = snapshot.sessions[0];
			dispatch(controller, { kind: 'terminal', event: { kind: 'focus', focused: true,
				terminalId: firstCurrent.terminalId, generation: firstCurrent.generation } });
			snapshot = controller.projection.snapshot;
			assert.equal(snapshot.activeTerminalId, first.terminalId);
			assert.equal(snapshot.groups[0].activeTerminalId, first.terminalId);

			dispatch(controller, { kind: 'create' });
			await controller.whenSettled();
			snapshot = controller.projection.snapshot;
			assert.equal(snapshot.groups.length, 2, 'New Terminal must create a group, not a split pane');
			assert.deepEqual(snapshot.groups.map(group => group.terminalIds.length), [2, 1]);
			dispatch(controller, { kind: 'step', delta: -1 });
			assert.equal(controller.projection.snapshot.activeTerminalId, first.terminalId,
				'group traversal must restore that group\'s active pane');
		} finally { controller.dispose(); }
	});

	it('owns create/select/input/exit/close as immutable generation-tagged records', async () => {
		const backends: Backend[] = [];
		const controller = new TerminalCollectionController('terminals', { create: async id => {
			const backend = new Backend(id); backends.push(backend); return backend;
		}, preparePaste: async text => text.toUpperCase() });
		try {
			assert.equal(dispatch(controller, { kind: 'create' }), true);
			await controller.whenSettled();
			let snapshot = controller.projection.snapshot;
			assert.equal(snapshot.sessions.length, 1);
			assert.equal(snapshot.status, undefined, 'healthy collection projected generic status chrome');
			assert.equal(snapshot.sessions[0].logicalText, '界🙂');
			assert.equal(snapshot.sessions[0].cursorOffset, 3);
			assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.sessions));
			const first = snapshot.sessions[0];
			assert.equal(dispatch(controller, { kind: 'terminal', event: {
				kind: 'key', sequence: 'a', terminalId: first.terminalId, generation: first.generation } }), true);
			assert.deepEqual(backends[0].writes, ['a']);
			assert.equal(dispatch(controller, { kind: 'terminal', event: {
				kind: 'paste', text: 'paste', terminalId: first.terminalId, generation: first.generation } }), true);
			await controller.whenSettled();
			assert.deepEqual(backends[0].pastes, ['PASTE']);
			const currentFirst = controller.projection.snapshot.sessions[0];
			assert.equal(dispatch(controller, { kind: 'terminal', event: {
				kind: 'focus', focused: true, terminalId: currentFirst.terminalId, generation: currentFirst.generation } }), true);
			assert.equal(controller.projection.snapshot.focusedTerminalId, first.terminalId);
			assert.equal(dispatch(controller, { kind: 'terminal', event: {
				kind: 'key', sequence: 'stale', terminalId: first.terminalId, generation: first.generation } }), false);

			assert.equal(dispatch(controller, { kind: 'create' }), true);
			await controller.whenSettled();
			snapshot = controller.projection.snapshot;
			assert.equal(snapshot.sessions.length, 2);
			assert.equal(dispatch(controller, { kind: 'select', terminalId: first.terminalId }), true);
			assert.equal(controller.projection.snapshot.activeTerminalId, first.terminalId);
			backends[0].exit(7);
			assert.equal(controller.projection.snapshot.status, 'process exited (7)');
			assert.equal(dispatch(controller, { kind: 'close', terminalId: first.terminalId }), true);
			await controller.whenSettled();
			assert.equal(backends[0].disposed, true);
			assert.equal(controller.projection.snapshot.sessions.length, 1);
		} finally { controller.dispose(); }
		assert.equal(backends.every(backend => backend.disposed), true);
	});

	it('publishes failure and prevents stale opening completion after teardown', async () => {
		let resolve!: (backend: Backend) => void;
		const pending = new Promise<Backend>(done => resolve = done);
		const controller = new TerminalCollectionController('terminals', { create: async () => pending });
		dispatch(controller, { kind: 'create' });
		controller.dispose();
		const backend = new Backend('late');
		const backendDisposed = new Promise<void>(resolveDisposed => { backend.onDispose = resolveDisposed; });
		resolve(backend);
		await backendDisposed;
		assert.equal(backend.disposed, true);

		const failure = new TerminalCollectionController('failure', { create: async () => { throw new Error('spawn failed'); } });
		dispatch(failure, { kind: 'create' });
		await failure.whenSettled();
		assert.equal(failure.projection.snapshot.opening, false);
		assert.equal(failure.projection.snapshot.error, 'spawn failed');
		assert.equal(failure.projection.snapshot.status, 'terminal failed: spawn failed');
		assert.equal(failure.projection.snapshot.sessions.length, 0);
		failure.dispose();
	});

	it('owns detected profiles and profile-addressed creation in immutable semantic state', async () => {
		const selected: Array<string | undefined> = [];
		const controller = new TerminalCollectionController('profiles', {
			profiles: async () => [{ id: 'configured-shell', label: 'Configured Shell' }],
			create: async (id, profileId) => { selected.push(profileId); return new Backend(id); }
		});
		try {
			let snapshot = controller.projection.snapshot;
			assert.equal(snapshot.profilesLoading, false);
			assert.deepEqual(snapshot.profiles, [], 'profile discovery must not precede the first requested process');
			assert.equal(dispatch(controller, { kind: 'create' }), true);
			await controller.whenSettled();
			snapshot = controller.projection.snapshot;
			assert.deepEqual(snapshot.profiles, [{ id: 'configured-shell', label: 'Configured Shell' }]);
			assert.equal(snapshot.profilesLoading, false);
			assert.ok(Object.isFrozen(snapshot.profiles)); assert.ok(Object.isFrozen(snapshot.profiles[0]));
			assert.equal(dispatch(controller, { kind: 'create', profileId: 'missing' }), true);
			assert.equal(controller.projection.snapshot.sessions.length, 1);
			assert.equal(dispatch(controller, { kind: 'create', profileId: 'configured-shell' }), true);
			await controller.whenSettled();
			assert.deepEqual(selected, [undefined, 'configured-shell']);
			assert.equal(controller.projection.snapshot.sessions[1].title, 'profiles:terminal:2');
		} finally { controller.dispose(); }
	});

	it('does not republish an identical native focus assertion back into reconciliation', async () => {
		const controller = new TerminalCollectionController('focus', { create: async id => new Backend(id) });
		try {
			dispatch(controller, { kind: 'create' });
			await controller.whenSettled();
			let session = controller.projection.snapshot.sessions[0];
			assert.equal(dispatch(controller, { kind: 'terminal', event: {
				kind: 'focus', focused: true, terminalId: session.terminalId, generation: session.generation
			} }), true);
			const focused = controller.projection.snapshot;
			assert.equal(focused.focusedTerminalId, session.terminalId);

			session = focused.sessions[0];
			assert.equal(dispatch(controller, { kind: 'terminal', event: {
				kind: 'focus', focused: true, terminalId: session.terminalId, generation: session.generation
			} }), true);
			assert.equal(controller.projection.snapshot, focused,
				'identical native focus must not create another collection generation');
		} finally { controller.dispose(); }
	});

	it('releases every backend and session across repeated complete create-close cycles', async () => {
		let created = 0;
		let disposed = 0;
		const controller = new TerminalCollectionController('terminals', { create: async id => {
			created++;
			const backend = new Backend(id);
			const release = backend.dispose.bind(backend);
			backend.dispose = () => { if (!backend.disposed) { disposed++; } release(); };
			return backend;
		} });
		try {
			for (let index = 0; index < 20; index++) {
				dispatch(controller, { kind: 'create' });
				await controller.whenSettled();
				const id = controller.projection.snapshot.activeTerminalId;
				assert.ok(id);
				dispatch(controller, { kind: 'close', terminalId: id });
				await controller.whenSettled();
				assert.equal(controller.projection.snapshot.sessions.length, 0);
				assert.equal(controller.diagnostics().length, 0);
			}
			assert.equal(controller.projection.snapshot.sessions.length, 0);
			assert.equal(controller.diagnostics().length, 0);
			assert.equal(created, 20);
			assert.equal(disposed, 20);
		} finally { controller.dispose(); }
	});
});
