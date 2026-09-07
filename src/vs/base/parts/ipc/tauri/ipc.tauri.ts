/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen as listenToTauriEvent } from '@tauri-apps/api/event';
import { raceCancellationError } from '../../../common/async.js';
import { VSBuffer } from '../../../common/buffer.js';
import { CancellationToken } from '../../../common/cancellation.js';
import { CancellationError, onUnexpectedError } from '../../../common/errors.js';
import { Emitter, Event } from '../../../common/event.js';
import { IDisposable, toDisposable } from '../../../common/lifecycle.js';
import { generateUuid } from '../../../common/uuid.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IChannel, IChannelClient, IServerChannel } from '../common/ipc.js';

/**
 * Mirrors `subscription_event_name` in `src-tauri/crates/tscode-app/src/channel.rs`. Both sides
 * derive the Tauri event name from the subscription id, so there is one formula.
 */
function subscriptionEventName(subscriptionId: string): string {
	return `tscode:sub:${subscriptionId}`;
}

/** The JSON `ChannelError::to_wire` produces. */
interface ISerializedChannelError {
	readonly $type: string;
	readonly code: string;
	readonly message: string;
}

/**
 * Tauri hands errors back as plain strings, so the backend encodes them as JSON.
 * `code` is the `FileSystemProviderErrorCode` *member* name (`FileNotFound`), not
 * its value (`EntryNotFound`), which is what makes the lookup a plain index.
 */
function toChannelError(error: unknown): Error {
	const raw = typeof error === 'string' ? error : String(error);

	let serialized: ISerializedChannelError | undefined;
	try {
		serialized = JSON.parse(raw);
	} catch {
		return new Error(raw);
	}

	if (serialized?.$type === 'FileSystemProviderError') {
		const code = FileSystemProviderErrorCode[serialized.code as keyof typeof FileSystemProviderErrorCode] ?? FileSystemProviderErrorCode.Unknown;

		return createFileSystemProviderError(serialized.message, code);
	}

	return new Error(raw);
}

/** The JSON `file.rs` reads and writes for bytes — `$type`-tagged, as errors are. */
interface ISerializedVSBuffer {
	readonly $type: string;
	readonly data: number[];
}

/**
 * Structure-preserving deep map. Arrays and plain objects are rebuilt entry by
 * entry, so key order survives; anything else — a `URI` and its `toJSON`, most
 * of all — is passed through untouched unless `transform` claims it.
 */
function mapDeep(value: any, transform: (value: any) => any): any {
	const transformed = transform(value);
	if (transformed !== value) {
		return transformed;
	}

	if (Array.isArray(value)) {
		return value.map(entry => mapDeep(entry, transform));
	}

	const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
	if (prototype === Object.prototype || prototype === null) {
		const result: any = {};
		for (const key of Object.keys(value)) {
			result[key] = mapDeep(value[key], transform);
		}

		return result;
	}

	return value;
}

/**
 * Stock's `ipc.ts` serializes `VSBuffer` at the wire level; we bypass that
 * protocol, so the buffers in a call's arguments are encoded here instead.
 * Numbers rather than base64, because `src-tauri` carries no base64 dependency.
 */
function encodeBuffers(value: any): any {
	return mapDeep(value, entry => entry instanceof VSBuffer
		? { $type: 'VSBuffer', data: Array.from(entry.buffer) } satisfies ISerializedVSBuffer
		: entry);
}

/** The inverse, for call results and event payloads alike. */
function reviveBuffers(value: any): any {
	return mapDeep(value, entry => entry?.$type === 'VSBuffer' && Array.isArray(entry.data)
		? VSBuffer.wrap(new Uint8Array((entry as ISerializedVSBuffer).data))
		: entry);
}

/**
 * An `IChannel` over Tauri's `invoke`. Framing, request matching and
 * serialization are Tauri's, so unlike the other transports this needs no
 * protocol on top — see `TSCODE-PORT.md`, *The porting seam*.
 */
class TauriChannel implements IChannel {

	/** Subscriptions that have been asked for but not yet registered by the backend. */
	private readonly opening = new Set<Promise<IDisposable>>();

	constructor(private readonly channelName: string) { }

	call<T>(command: string, arg?: any, cancellationToken = CancellationToken.None): Promise<T> {
		if (cancellationToken.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}

		// `arg` is a required `serde_json::Value` on the other side: an omitted
		// field fails deserialization, an explicit `null` does not.
		const result = invoke('channel_call', { channel: this.channelName, command, arg: encodeBuffers(arg ?? null) })
			.then(reviveBuffers, error => { throw toChannelError(error); }) as Promise<T>;

		return raceCancellationError(result, cancellationToken);
	}

	listen<T>(event: string, arg?: any): Event<T> {
		let subscription: Promise<IDisposable> | undefined;

		const emitter = new Emitter<T>({
			onWillAddFirstListener: () => {
				const opening = this.subscribe<T>(event, arg, payload => emitter.fire(payload));
				subscription = opening;
				this.opening.add(opening);
				opening.catch(onUnexpectedError).finally(() => this.opening.delete(opening));
			},
			onDidRemoveLastListener: () => {
				const pending = subscription;
				subscription = undefined;
				pending?.then(disposable => disposable.dispose(), () => { /* already reported */ });
			}
		});

		return emitter.event;
	}

	/**
	 * Resolves once every subscription opened so far has reached the backend. A
	 * subscription that failed has already been reported through `onUnexpectedError`,
	 * so waiting is over either way.
	 */
	async whenSubscribed(): Promise<void> {
		await Promise.allSettled([...this.opening]);
	}

	/**
	 * One Rust subscription per event however many listeners the emitter fans out
	 * to: it opens on the first listener and disposes with the last. A fresh id
	 * per cycle keeps a re-subscribe from colliding with the unlisten of the
	 * cycle before it, which is still in flight.
	 */
	private async subscribe<T>(event: string, arg: any, fire: (payload: T) => void): Promise<IDisposable> {
		const subscriptionId = generateUuid();

		// Attached before `channel_listen`, which may emit synchronously.
		const unlisten = await listenToTauriEvent(subscriptionEventName(subscriptionId), tauriEvent => fire(reviveBuffers(tauriEvent.payload)));

		try {
			// Tauri v2 renames command arguments to camelCase: `subscriptionId`.
			await invoke('channel_listen', { channel: this.channelName, event, arg: encodeBuffers(arg ?? null), subscriptionId });
		} catch (error) {
			unlisten();
			throw toChannelError(error);
		}

		return toDisposable(() => {
			unlisten();
			invoke('channel_unlisten', { subscriptionId }).catch(onUnexpectedError);
		});
	}
}

/**
 * The `TauriChannel` behind every handle `getChannel` has handed out, so
 * `whenSubscribed` can find it without widening `IChannel`.
 */
const channelsByHandle = new WeakMap<IChannel, TauriChannel>();

/**
 * Resolves once every subscription `channel` has opened is registered on the backend.
 *
 * `IChannel.listen()` answers with an `Event` and no completion, so a caller whose
 * *next* call starts the producer has no way to keep from racing its own subscription
 * — and the backend drops an event nobody has subscribed to yet. `TauriTerminalProcess`
 * is that caller: `start` spawns the shell. A channel from another transport has no
 * subscription of this kind to wait for.
 */
export function whenSubscribed(channel: IChannel): Promise<void> {
	return channelsByHandle.get(channel)?.whenSubscribed() ?? Promise.resolve();
}

export class TauriChannelClient implements IChannelClient {

	getChannel<T extends IChannel>(channelName: string): T {
		const channel = new TauriChannel(channelName);

		// eslint-disable-next-line local/code-no-dangerous-type-assertions
		const handle = {
			call(command: string, arg?: any, cancellationToken?: CancellationToken) {
				return channel.call(command, arg, cancellationToken);
			},
			listen(event: string, arg: any) {
				return channel.listen(event, arg);
			}
		} as T;

		channelsByHandle.set(handle, channel);
		return handle;
	}
}

/**
 * The renderer's view of the backend. Services ask an injected
 * `IMainProcessService` for their channels, so this is the whole of the wiring.
 */
export class TauriMainProcessService implements IMainProcessService {

	declare readonly _serviceBrand: undefined;

	private readonly client = new TauriChannelClient();

	getChannel(channelName: string): IChannel {
		return this.client.getChannel(channelName);
	}

	registerChannel(channelName: string, channel: IServerChannel<string>): void {
		throw new Error(`Channels are served by the Tauri backend and cannot be registered from the renderer: ${channelName}`);
	}
}
