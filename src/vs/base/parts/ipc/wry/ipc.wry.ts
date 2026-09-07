/* Wry transport for the same request/reply/event protocol used by ipc.host.ts. */
export type UnlistenFn = () => void;
interface HostEvent<T> { readonly event: string; readonly payload: T; }
interface Reply { id?: number; result?: unknown; error?: string; event?: string; payload?: unknown; fatal?: string; }
const pending = new Map<number, { resolve(value: unknown): void; reject(error: string): void }>();
const listeners = new Map<string, Set<(event: HostEvent<unknown>) => void>>();
let nextId = 0;
let failure: string | undefined;

export function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	if (failure) { return Promise.reject(failure); }
	const id = ++nextId;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: value => resolve(value as T), reject });
		try {
			(window as unknown as { ipc: { postMessage(frame: string): void } }).ipc.postMessage(JSON.stringify({ id, cmd, args }));
		} catch (error) { pending.delete(id); reject(error); }
	});
}

export function listen<T>(event: string, callback: (event: HostEvent<T>) => void): Promise<UnlistenFn> {
	let callbacks = listeners.get(event);
	if (!callbacks) { callbacks = new Set(); listeners.set(event, callbacks); }
	const handler = callback as (event: HostEvent<unknown>) => void;
	callbacks.add(handler);
	return Promise.resolve(() => {
		callbacks.delete(handler);
		if (!callbacks.size) { listeners.delete(event); }
	});
}

Object.defineProperty(globalThis, '__tucodeBackendMessage', {
	value(message: Reply): void {
		if (message.fatal) {
			failure = message.fatal;
			for (const request of pending.values()) { request.reject(failure); }
			pending.clear();
			throw new Error(failure);
		}
		if (message.event !== undefined) {
			for (const callback of [...listeners.get(message.event) ?? []]) {
				try { callback({ event: message.event, payload: message.payload }); }
				catch (error) { queueMicrotask(() => { throw error; }); }
			}
		} else if (message.id !== undefined) {
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (message.error !== undefined) { request?.reject(message.error); }
			else { request?.resolve(message.result); }
		}
	}
});
