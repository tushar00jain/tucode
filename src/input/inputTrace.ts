/*---------------------------------------------------------------------------------------------
 *  Bounded diagnostics for the platform-neutral input boundary.
 *--------------------------------------------------------------------------------------------*/

export interface IInputStageRecord {
	readonly eventId: number;
	readonly stage: string;
	readonly detail?: Readonly<Record<string, unknown>>;
}

const LIMIT = 128;
let enabled = false;
const records: IInputStageRecord[] = [];
let sequence = 0;
let observer: ((records: readonly IInputStageRecord[]) => void) | undefined;

export function nextInputTraceEventId(): number { return ++sequence; }

export function setInputTraceObserver(value: ((records: readonly IInputStageRecord[]) => void) | undefined): void {
	observer = value;
}

export function setInputTraceEnabled(value: boolean): void {
	enabled = value;
	if (!value) { records.length = 0; }
}

export function recordInputStage(eventId: number | undefined, stage: string, detail?: Record<string, unknown>): void {
	if (!enabled || eventId === undefined) { return; }
	const record = Object.freeze({ eventId, stage, detail: detail ? Object.freeze({ ...detail }) : undefined });
	records.push(record);
	if (records.length > LIMIT) { records.splice(0, records.length - LIMIT); }
	try { observer?.(inputTraceSnapshot()); } catch (error) {
		// Diagnostics are observational: a sink failure may report, but never alter input ownership.
		globalThis.console?.error?.(`TUCODE_INPUT_TRACE_FAILURE ${String(error)}`);
	}
}

export function inputTraceSnapshot(): readonly IInputStageRecord[] {
	return Object.freeze(records.map(record => Object.freeze({ ...record, detail: record.detail ? Object.freeze({ ...record.detail }) : undefined })));
}
