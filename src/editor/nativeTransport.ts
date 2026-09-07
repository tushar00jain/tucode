/** Native UI commands only; backend channels use the shared IChannel adapter. */
export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	const handler = (window as unknown as {
		webkit: { messageHandlers: { tucodeNative: { postMessage(message: unknown): Promise<T> } } };
	}).webkit.messageHandlers.tucodeNative;
	return handler.postMessage({ cmd, args });
}
