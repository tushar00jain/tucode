/*---------------------------------------------------------------------------------------------
 *  The status bar, in a terminal.
 *
 *  Nothing here decides where an entry goes. `StatusbarViewModel` is upstream's own ordering — the
 *  alignment split, the primary/secondary priorities, and the `location` form that positions one
 *  entry relative to another (`status.scm.1` sits beside `status.scm.0` because
 *  `SCMActiveRepositoryController` says so, not because this file knows what a branch is). This
 *  file holds the model, renders each entry's label and lays the two groups out left and right.
 *
 *  **An entry's label is upstream's too.** `renderLabelWithIcons` splits `$(git-branch) main` into
 *  a codicon span and its text, exactly as `SimpleIconLabel` does for `StatusbarEntryItem`; the span
 *  has no text, so `paint` drops it and the terminal is left with the words. That is §15's
 *  icon-font exception, arriving through upstream's own renderer rather than through a
 *  `stripIcons` of ours.
 *
 *  What this part does not have is the half that is a gesture: an entry is not clickable, has no
 *  hover, and cannot be hidden from a context menu on the bar. `StatusbarEntryItem` is where all
 *  three live upstream, and it takes the hover service, telemetry and a touch gesture target — so it
 *  is the widget this file replaces rather than one it could have run.
 *
 *  Upstream counterpart: src/vs/workbench/browser/parts/statusbar/statusbarPart.ts, src/vs/workbench/browser/parts/statusbar/statusbarItem.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../vs/base/common/lifecycle.js';
import { Event } from '../../vs/base/common/event.js';
import { IStorageService } from '../../vs/platform/storage/common/storage.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { STATUS_BAR_BACKGROUND, STATUS_BAR_FOREGROUND } from '../../vs/workbench/common/theme.js';
import {
	IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarEntryLocation, IStatusbarEntryPriority,
	IStatusbarService, StatusbarAlignment, StatusbarProjectionController
} from '../../workbench/statusbarProjection.js';
import { ILine, ISpan, spanWidth } from '../terminal/screen.js';

/** One column between two entries, which is what `statusbarpart.css` spends its padding on. */
const GAP = ' ';

export class TerminalStatusbarPart extends Disposable implements IStatusbarService {

	declare readonly _serviceBrand: undefined;

	private readonly controller: StatusbarProjectionController;
	/** Fires whenever the bar's contents change, which is what `Workbench` repaints on. */
	readonly onDidChange: Event<void>;

	readonly onDidChangeEntryVisibility: Event<{ id: string; visible: boolean }>;

	constructor(
		@IStorageService storageService: IStorageService,
		@IThemeService private readonly themeService: IThemeService
	) {
		super();

		this.controller = this._register(new StatusbarProjectionController(storageService));
		this.onDidChange = Event.map(this.controller.onDidSnapshot, () => undefined);
		this.onDidChangeEntryVisibility = this.controller.onDidChangeEntryVisibility;
	}

	//#region --- IStatusbarEntryContainer

	addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priorityOrLocation: number | IStatusbarEntryLocation | IStatusbarEntryPriority = 0): IStatusbarEntryAccessor {
		const registration = this.controller.addEntry(entry, id, alignment, priorityOrLocation);
		return {
			update: updated => registration.update(updated),
			dispose: () => registration.dispose()
		};
	}

	isEntryVisible(id: string): boolean {
		return this.controller.isEntryVisible(id);
	}

	updateEntryVisibility(id: string, visible: boolean): void {
		this.controller.setEntryVisibility(id, visible);
	}

	//#endregion

	/**
	 * The bar as one line: the left group, then whatever the workbench has to say about the keys,
	 * then the right group flush against the right edge. Both groups are the view model's order.
	 *
	 * The keys arrive as a function of the room left over rather than as a line, because the entries
	 * are what decides how much room there is — and the row is one row: a caller that has to fit
	 * inside it has to be told what "inside it" is, or it guesses and the terminal wraps.
	 */
	line(cols: number, hints: (room: number) => ILine): ILine {
		const theme = this.themeService.getColorTheme();
		const base: ISpan = { fg: theme.getColor(STATUS_BAR_FOREGROUND), bg: theme.getColor(STATUS_BAR_BACKGROUND), text: '' };

		const left = this.group(StatusbarAlignment.LEFT, base);
		const right = this.group(StatusbarAlignment.RIGHT, base);
		const entries = [...left, ...right].reduce((width, span) => width + spanWidth(span.text), 0);
		const keys = hints(Math.max(0, cols - entries - (left.length ? GAP.length : 0)));
		const head = [...left, ...(left.length && keys.length ? [{ ...base, text: GAP }] : []), ...keys];
		const used = [...head, ...right].reduce((width, span) => width + spanWidth(span.text), 0);

		return [...head, { ...base, text: ' '.repeat(Math.max(0, cols - used)) }, ...right];
	}

	private group(alignment: StatusbarAlignment, base: ISpan): ISpan[] {
		const spans: ISpan[] = [];

		const ids = alignment === StatusbarAlignment.LEFT ? this.controller.snapshot.left : this.controller.snapshot.right;
		for (const id of ids) {
			const entry = this.controller.snapshot.entries.find(candidate => candidate.id === id);
			if (!entry?.text) { continue; }
			if (spans.length) {
				spans.push({ ...base, text: GAP });
			}
			spans.push({ ...base, text: entry.text });
		}

		return spans;
	}

	//#region --- what a terminal status bar has no counterpart for

	getPart(): never {
		throw new Error('IStatusbarService.getPart is not available in tucode: there is one status bar and it is not rooted in an element.');
	}

	createAuxiliaryStatusbarPart(): never {
		throw new Error('IStatusbarService.createAuxiliaryStatusbarPart is not available in tucode: there is one window.');
	}

	createScoped(): IStatusbarService {
		return this;
	}

	overrideEntry(): IDisposable {
		throw new Error('IStatusbarService.overrideEntry is not available in tucode: nothing overrides an entry here.');
	}

	overrideStyle(): IDisposable {
		throw new Error('IStatusbarService.overrideStyle is not available in tucode: the bar is `statusBar.background`/`foreground` and nothing restyles it.');
	}

	/** Focus lives in a pane or an overlay; the status bar is drawn, never entered. */
	focus(): void { }
	focusNextEntry(): void { }
	focusPreviousEntry(): void { }

	isEntryFocused(): boolean {
		return false;
	}

	//#endregion
}
