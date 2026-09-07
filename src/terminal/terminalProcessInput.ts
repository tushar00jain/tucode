/*---------------------------------------------------------------------------------------------
 * Causal terminal input ownership while a real PTY is being created.
 *--------------------------------------------------------------------------------------------*/

/** Preserves user input until the backend's real process-ready event establishes its recipient. */
export class TerminalProcessInputGate {
	private pending: string[] = [];
	private ready = false;
	private closed = false;

	constructor(private readonly deliver: (data: string) => void) { }

	write(data: string): boolean {
		if (this.closed) { return false; }
		if (this.ready) { this.deliver(data); }
		else { this.pending.push(data); }
		return true;
	}

	markReady(): void {
		if (this.ready || this.closed) { return; }
		this.ready = true;
		for (const data of this.pending.splice(0)) { this.deliver(data); }
	}

	close(): void { this.closed = true; this.pending = []; }
}
