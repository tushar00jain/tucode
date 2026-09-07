/*---------------------------------------------------------------------------------------------
 * A frontend-neutral decoded key.
 *
 * Window systems and terminal transports produce this record at their edges. Everything above
 * those edges—workbench dispatch, editor policy, Vim and projected pane input—consumes it without
 * depending on the frontend that decoded it.
 *--------------------------------------------------------------------------------------------*/

export interface INormalizedKey {
	/** Correlation only for bounded adapter diagnostics; never participates in semantics. */
	readonly diagnosticEventId?: number;
	/** `up`, `down`, `enter`, `escape`, `f1`–`f12`, `char`, or another decoded key name. */
	readonly name: string;
	readonly ctrl?: boolean;
	readonly shift?: boolean;
	readonly alt?: boolean;
	readonly meta?: boolean;
	/** Optional physical-key facts supplied by window-system decoders. */
	readonly code?: string;
	readonly keyCode?: number;
	/** The character typed, when `name` is `char`. */
	readonly char?: string;
	/** Optional transport spelling retained when a frontend can forward the original input. */
	readonly sequence?: string;
}
