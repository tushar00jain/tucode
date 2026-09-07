/*---------------------------------------------------------------------------------------------
 *  Generation-owned interaction sessions shared by model and native interaction adapters.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable } from './vs/base/common/lifecycle.js';

export type InteractionSessionEnd = 'completed' | 'cancelled' | 'failed' | 'replaced' | 'disposed';
export type InteractionSessionState = 'active' | InteractionSessionEnd;

export class InteractionSession<T> implements IDisposable {
	private readonly resources = new DisposableStore();
	private _state: InteractionSessionState = 'active';

	constructor(readonly generation: number, readonly value: T,
		private readonly release: (session: InteractionSession<T>) => void) { }

	get state(): InteractionSessionState { return this._state; }
	get active(): boolean { return this._state === 'active'; }

	add<D extends IDisposable>(resource: D): D { return this.resources.add(resource); }

	run<R>(callback: (value: T) => R): R | undefined {
		return this.active ? callback(this.value) : undefined;
	}

	end(outcome: InteractionSessionEnd): boolean {
		if (!this.active) { return false; }
		this._state = outcome;
		this.resources.dispose();
		this.release(this);
		return true;
	}

	dispose(): void { this.end('cancelled'); }
}

export class InteractionSessionOwner<T> extends Disposable {
	private generation = 0;
	private _current: InteractionSession<T> | undefined;
	private disposed = false;

	constructor(readonly protocol: string) { super(); }

	get current(): InteractionSession<T> | undefined { return this._current; }

	begin(value: T): InteractionSession<T> {
		if (this.disposed) { throw new Error(`${this.protocol} cannot begin after disposal`); }
		this._current?.end('replaced');
		const session = new InteractionSession(++this.generation, value, released => {
			if (this._current === released) { this._current = undefined; }
		});
		this._current = session;
		return session;
	}

	isCurrent(session: InteractionSession<T> | undefined): session is InteractionSession<T> {
		return Boolean(session?.active && this._current === session);
	}

	end(session: InteractionSession<T>, outcome: InteractionSessionEnd): boolean {
		return this.isCurrent(session) && session.end(outcome);
	}

	override dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this._current?.end('disposed');
		super.dispose();
	}
}
