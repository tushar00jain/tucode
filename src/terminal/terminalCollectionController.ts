/*---------------------------------------------------------------------------------------------
 * Shared semantic owner for an ordered collection of terminal processes.
 *--------------------------------------------------------------------------------------------*/
import { Disposable, DisposableStore } from '../vs/base/common/lifecycle.js';
import { PendingWork } from '../vs/workbench/browser/tauri/pendingWork.js';
import { ITerminalEditorBackend, TerminalEditorController } from './terminalEditorController.js';
import {
	ITerminalCollectionProjectionSnapshot, TerminalCollectionInputEvent,
	TerminalCollectionProjectionGateway, TerminalEditorInputEvent, terminalCollectionSnapshot
} from './terminalProjection.js';

export interface ITerminalCollectionBackendFactory {
	create(terminalId: string, profileId?: string, parentTerminalId?: string): Promise<ITerminalEditorBackend>;
	profiles?(): Promise<readonly Readonly<{ readonly id: string; readonly label: string }>[] >;
	preparePaste?(text: string, bracketed: boolean): Promise<string | undefined>;
}

interface ITerminalEntry {
	readonly controller: TerminalEditorController;
	readonly store: DisposableStore;
	readonly groupId: string;
	readonly profileId: string | undefined;
}

export class TerminalCollectionController extends Disposable {
	readonly projection: TerminalCollectionProjectionGateway;
	private readonly entries: ITerminalEntry[] = [];
	private readonly pending = this._register(new PendingWork('terminal-collection'));
	private readonly settling = new Map<string, Promise<void>>();
	private revision = 1;
	private nextTerminal = 1;
	private nextGroup = 1;
	private readonly groupActive = new Map<string, string>();
	private openingGeneration = 0;
	private activeTerminalId: string | undefined;
	private focusedTerminalId: string | undefined;
	private opening = false;
	private error: string | undefined;
	private profiles: readonly Readonly<{ readonly id: string; readonly label: string }>[] = Object.freeze([]);
	private profilesLoading = false;
	private profileError: string | undefined;
	private profilesRequested = false;
	private live = true;

	constructor(readonly collectionId: string, private readonly factory: ITerminalCollectionBackendFactory) {
		super();
		this.projection = this._register(new TerminalCollectionProjectionGateway(this.snapshot(), event => this.handle(event)));
	}

	get idle(): boolean { return this.pending.idle; }
	whenSettled(): Promise<void> { return this.pending.whenSettled(); }
	diagnostics(): readonly object[] { return this.entries.map(entry => ({ terminalId: entry.controller.terminalId, ...entry.controller.diagnostics() })); }

	private snapshot(): ITerminalCollectionProjectionSnapshot {
		const active = this.entries.find(entry => entry.controller.terminalId === this.activeTerminalId)?.controller.projection.snapshot;
		const groups = [...new Set(this.entries.map(entry => entry.groupId))].map(groupId => {
			const terminalIds = this.entries.filter(entry => entry.groupId === groupId).map(entry => entry.controller.terminalId);
			const activeTerminalId = this.groupActive.get(groupId) && terminalIds.includes(this.groupActive.get(groupId)!)
				? this.groupActive.get(groupId)! : terminalIds[0];
			return { groupId, terminalIds, activeTerminalId };
		});
		return terminalCollectionSnapshot({ kind: 'terminal-collection', collectionId: this.collectionId, generation: this.revision++,
			sessions: this.entries.map(entry => entry.controller.projection.snapshot), groups, activeTerminalId: this.activeTerminalId,
			focusedTerminalId: this.focusedTerminalId, opening: this.opening, error: this.error,
			status: this.error ? `terminal failed: ${this.error}` : this.profileError ? `terminal profile failed: ${this.profileError}` :
				active?.exited ? `process exited (${active.exitCode ?? 0})` : undefined,
			profiles: this.profiles, profilesLoading: this.profilesLoading, profileError: this.profileError });
	}

	private requestProfiles(): void {
		if (!this.factory.profiles || this.profilesRequested || !this.live) { return; }
		this.profilesRequested = true; this.profilesLoading = true; this.publish();
		this.pending.track(this.loadProfiles(), 'profiles').catch(() => undefined);
	}

	private async loadProfiles(): Promise<void> {
		try {
			const profiles = await this.factory.profiles?.() ?? [];
			if (!this.live) { return; }
			this.profiles = Object.freeze(profiles.map(profile => Object.freeze({ ...profile })));
		} catch (error) {
			if (this.live) { this.profileError = error instanceof Error ? error.message : String(error); }
		} finally {
			if (this.live) { this.profilesLoading = false; this.publish(); }
		}
	}

	private publish(): void { if (this.live) { this.projection.publish(this.snapshot()); } }

	private handle(event: TerminalCollectionInputEvent): void {
		switch (event.kind) {
			case 'create': this.create(event.profileId); return;
			case 'split': this.split(); return;
			case 'select': this.select(event.terminalId); return;
			case 'close': this.close(event.terminalId); return;
			case 'step': this.step(event.delta); return;
			case 'terminal': this.dispatchTerminal(event.event); return;
		}
	}

	create(profileId?: string): void {
		if (!this.live || this.opening) { return; }
		if (profileId && !this.profiles.some(profile => profile.id === profileId)) { return; }
		const generation = ++this.openingGeneration;
		const terminalId = `${this.collectionId}:terminal:${this.nextTerminal++}`;
		const groupId = `${this.collectionId}:group:${this.nextGroup++}`;
		this.opening = true; this.error = undefined; this.publish();
		const work = this.open(terminalId, generation, groupId, profileId);
		this.pending.track(work, `open:${terminalId}`).catch(() => undefined);
	}

	split(): void {
		if (!this.live || this.opening || !this.activeTerminalId) { return; }
		const parent = this.entries.find(entry => entry.controller.terminalId === this.activeTerminalId);
		if (!parent) { return; }
		const generation = ++this.openingGeneration;
		const terminalId = `${this.collectionId}:terminal:${this.nextTerminal++}`;
		this.opening = true; this.error = undefined; this.publish();
		const work = this.open(terminalId, generation, parent.groupId, parent.profileId, parent.controller.terminalId);
		this.pending.track(work, `split:${terminalId}`).catch(() => undefined);
	}

	private async open(terminalId: string, generation: number, groupId: string, profileId?: string, parentTerminalId?: string): Promise<void> {
		let backend: ITerminalEditorBackend | undefined;
		try {
			backend = await this.factory.create(terminalId, profileId, parentTerminalId);
			if (!this.live || generation !== this.openingGeneration) { backend.dispose(); return; }
			const store = new DisposableStore();
			const controller = store.add(new TerminalEditorController(terminalId, backend, 80, 24,
				(text, bracketed) => this.factory.preparePaste?.(text, bracketed) ?? Promise.resolve(text)));
			backend = undefined;
			const entry = { controller, store, groupId, profileId };
			store.add(controller.projection.onDidSnapshot(() => {
				if (this.entries.includes(entry)) { this.publish(); }
			}));
			const parentIndex = parentTerminalId ? this.entries.findIndex(candidate => candidate.controller.terminalId === parentTerminalId) : -1;
			this.entries.splice(parentIndex >= 0 ? parentIndex + 1 : this.entries.length, 0, entry);
			this.groupActive.set(groupId, terminalId); this.activeTerminalId = terminalId; this.opening = false; this.publish();
			// Profile discovery may inspect several executables through the same PTY channel. Start it
			// only after the requested terminal owns a backend, so launch can never queue behind menu data.
			this.requestProfiles();
			await controller.open();
			if (!this.live || generation !== this.openingGeneration || !this.entries.includes(entry)) { return; }
			this.publish();
		} catch (error) {
			backend?.dispose();
			if (!this.live || generation !== this.openingGeneration) { return; }
			const index = this.entries.findIndex(entry => entry.controller.terminalId === terminalId);
			if (index >= 0) { this.entries.splice(index, 1)[0].store.dispose(); }
			this.opening = false; this.error = error instanceof Error ? error.message : String(error);
			if (this.activeTerminalId === terminalId) { this.activeTerminalId = this.entries.at(-1)?.controller.terminalId; }
			this.publish();
			throw error;
		}
	}

	select(terminalId: string): boolean {
		const entry = this.entries.find(entry => entry.controller.terminalId === terminalId);
		if (!entry) { return false; }
		this.activeTerminalId = terminalId; this.groupActive.set(entry.groupId, terminalId); this.publish(); return true;
	}

	step(delta: -1 | 1): void {
		const groupIds = [...new Set(this.entries.map(entry => entry.groupId))];
		if (groupIds.length < 2) { return; }
		const activeGroupId = this.entries.find(entry => entry.controller.terminalId === this.activeTerminalId)?.groupId;
		const index = groupIds.indexOf(activeGroupId ?? groupIds[0]);
		const groupId = groupIds[(index + delta + groupIds.length) % groupIds.length];
		this.select(this.groupActive.get(groupId) ?? this.entries.find(entry => entry.groupId === groupId)!.controller.terminalId);
	}

	close(terminalId: string): boolean {
		const index = this.entries.findIndex(entry => entry.controller.terminalId === terminalId);
		if (index < 0) { return false; }
		const entry = this.entries.splice(index, 1)[0];
		this.pending.track(entry.controller.shutdown().finally(() => entry.store.dispose()), `close:${terminalId}`).catch(() => undefined);
		const siblings = this.entries.filter(candidate => candidate.groupId === entry.groupId);
		if (siblings.length === 0) { this.groupActive.delete(entry.groupId); }
		else if (this.groupActive.get(entry.groupId) === terminalId) {
			this.groupActive.set(entry.groupId, siblings[Math.min(index, siblings.length - 1)]?.controller.terminalId ?? siblings.at(-1)!.controller.terminalId);
		}
		if (this.activeTerminalId === terminalId) {
			const sibling = siblings[0] ? this.groupActive.get(entry.groupId) : undefined;
			const adjacent = this.entries[Math.min(index, this.entries.length - 1)] ?? this.entries.at(-1);
			this.activeTerminalId = sibling ?? (adjacent ? this.groupActive.get(adjacent.groupId) ?? adjacent.controller.terminalId : undefined);
		}
		if (this.focusedTerminalId === terminalId) { this.focusedTerminalId = undefined; }
		this.publish(); return true;
	}

	private dispatchTerminal(event: TerminalEditorInputEvent): void {
		const entry = this.entries.find(value => value.controller.terminalId === event.terminalId);
		if (!entry || !entry.controller.projection.dispatch(event)) { return; }
		if (event.kind === 'focus') {
			const focusedTerminalId = event.focused ? event.terminalId
				: this.focusedTerminalId === event.terminalId ? undefined : this.focusedTerminalId;
			// Native reconciliation may reassert the current first responder while applying a newer
			// terminal snapshot. Identical semantic focus is not a state transition and must not
			// publish another generation back into that same reconciler.
			const activeChanged = event.focused && event.terminalId !== this.activeTerminalId;
			if (activeChanged) {
				this.activeTerminalId = event.terminalId;
				this.groupActive.set(entry.groupId, event.terminalId);
			}
			if (focusedTerminalId !== this.focusedTerminalId || activeChanged) {
				this.focusedTerminalId = focusedTerminalId;
				this.publish();
			}
		}
		if (!this.settling.has(event.terminalId)) {
			const work = entry.controller.whenSettled().finally(() => this.settling.delete(event.terminalId));
			this.settling.set(event.terminalId, work);
			this.pending.track(work, `settle:${event.terminalId}`).catch(() => undefined);
		}
	}

	override dispose(): void {
		if (!this.live) { return; }
		this.live = false; this.openingGeneration++; this.opening = false;
		for (const entry of this.entries.splice(0)) { entry.store.dispose(); }
		this.settling.clear();
		this.groupActive.clear();
		this.activeTerminalId = undefined; this.focusedTerminalId = undefined;
		super.dispose();
	}
}
