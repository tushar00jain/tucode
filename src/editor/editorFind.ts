/*---------------------------------------------------------------------------------------------
 * Shared find semantics for projected text editors.
 *--------------------------------------------------------------------------------------------*/

import { ITextModel } from '../vs/editor/common/model.js';
import { MATCHES_LIMIT } from '../vs/editor/contrib/find/browser/findModel.js';
import type { ITextOffsetRange } from './textView.js';

export interface IEditorFindSnapshot {
	readonly visible: boolean;
	readonly query: string;
	readonly matchCount: number;
	/** One-based, or zero when there is no current match. */
	readonly currentMatch: number;
}

export interface IEditorFindSelectionTarget {
	readonly primaryCursorOffset: number;
	selectOffsets(range: ITextOffsetRange, source: string): void;
}

/**
 * Owns only the find session. Text matching remains the upstream text model's implementation and
 * selection remains the shared editor view's implementation; frontends receive scalar state.
 */
export class EditorFindSession {
	private visible = false;
	private query = '';
	private matches: readonly Readonly<{ readonly location: number; readonly length: number }>[] = [];
	private current = -1;
	private origin = 0;

	constructor(private readonly model: ITextModel, private readonly selection: IEditorFindSelectionTarget) { }

	get snapshot(): Readonly<IEditorFindSnapshot> {
		return Object.freeze({ visible: this.visible, query: this.query,
			matchCount: this.matches.length, currentMatch: this.current + 1 });
	}

	open(): void {
		if (!this.visible) { this.origin = this.selection.primaryCursorOffset; }
		this.visible = true;
		this.research();
	}

	setQuery(query: string): void {
		this.query = query;
		this.research();
	}

	refresh(): void { this.research(); }

	next(): void { this.step(1); }
	previous(): void { this.step(-1); }
	close(): void { this.visible = false; }

	private research(): void {
		if (!this.query) {
			this.matches = [];
			this.current = -1;
			return;
		}
		this.matches = this.model.findMatches(this.query, true, false, false, null, false, MATCHES_LIMIT).map(match => {
			const location = this.model.getOffsetAt(match.range.getStartPosition());
			return Object.freeze({ location,
				length: this.model.getOffsetAt(match.range.getEndPosition()) - location });
		});
		this.current = this.matches.findIndex(match => match.location >= this.origin);
		if (this.current < 0 && this.matches.length) { this.current = 0; }
		this.selectCurrent();
	}

	private step(delta: 1 | -1): void {
		if (!this.matches.length) { this.current = -1; return; }
		this.current = (this.current + delta + this.matches.length) % this.matches.length;
		this.selectCurrent();
	}

	private selectCurrent(): void {
		const match = this.matches[this.current];
		if (match) { this.selection.selectOffsets(match, 'find'); }
	}
}
