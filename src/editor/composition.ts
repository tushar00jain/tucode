/*---------------------------------------------------------------------------------------------
 *  Marked text, against the model.
 *
 *  An IME has three moments: composition begins, the
 *  marked text is replaced over and over, and it is committed or abandoned. `ViewModel` already
 *  has all three — `startComposition`, `compositionType` and `endComposition`, which is what
 *  `TextAreaInput` drives upstream from `compositionstart` / `compositionupdate` / `compositionend`
 *  — and `CursorsController` behind them is what makes a composition one undo step and keeps every
 *  secondary cursor typing the same text.
 *
 *  This keeps track of **where** marked text starts and how long it is so successive composition
 *  updates replace the correct model range.
 *
 *  Upstream counterpart: src/vs/editor/browser/controller/editContext/textArea/textAreaEditContextInput.ts
 *--------------------------------------------------------------------------------------------*/

import { ITextProjectionRange } from './textProjection.js';
import { TextView } from './textView.js';

/** The source every edit this file makes is attributed to, as upstream's `ViewController` does. */
const SOURCE = 'keyboard';

type CompositionState = { readonly kind: 'idle' } | { readonly kind: 'marked'; readonly start: number; readonly length: number };

export class Composition {

	/** Where the marked text begins, as a document offset, while there is one. */
	private state: CompositionState = { kind: 'idle' };

	constructor(private readonly view: TextView) { }

	get range(): ITextProjectionRange | undefined {
		return this.state.kind === 'marked' ? { location: this.state.start, length: this.state.length } : undefined;
	}

	get active(): boolean {
		return this.state.kind === 'marked';
	}

	/**
	 * The marked text, replacing whatever the last one left behind.
	 *
	 * `replacePrevCharCnt` is the previous marked text's length: upstream deduces that number by
	 * diffing two textarea values, and here the IME states it. `positionDelta` is where the caret
	 * sits inside the text just typed, counted back from its end — which is how `TypeOperations`
	 * takes it, and what puts the caret in the middle of a half-composed Japanese phrase.
	 */
	setMarkedText(text: string, selected: ITextProjectionRange): void {
		if (this.state.kind === 'idle') {
			this.view.startComposition();
			this.state = { kind: 'marked', start: this.caret(), length: 0 };
		}

		const state = this.state;
		this.view.compositionType(text, state.kind === 'marked' ? state.length : 0,
			selected.location + selected.length - text.length, SOURCE);
		if (state.kind === 'marked') { this.state = { kind: 'marked', start: state.start, length: text.length }; }

		// An IME clears its marked text to cancel, and a composition with nothing left in it is
		// over — leaving it open would make the next ordinary keystroke part of it.
		if (!text) {
			this.end();
		}
	}

	/** A commit: the text replaces the marked text if there is one, and is typed if there is not. */
	insertText(text: string): void {
		if (this.state.kind === 'idle') {
			this.view.typeInput(text, SOURCE);

			return;
		}

		this.view.compositionType(text, this.state.length, 0, SOURCE);
		this.end();
	}

	/** `unmarkText`: the composition keeps what it has typed and stops being a composition. */
	unmark(): void {
		if (this.state.kind === 'marked') {
			this.end();
		}
	}

	private end(): void {
		this.view.endComposition(SOURCE);
		this.state = { kind: 'idle' };
	}

	/** Replacing or tearing down a text-input generation must close its composition transaction. */
	dispose(): void { this.unmark(); }

	/** The primary cursor as a document offset, which is where marked text will land. */
	private caret(): number {
		return this.view.primaryCursorOffset;
	}
}
