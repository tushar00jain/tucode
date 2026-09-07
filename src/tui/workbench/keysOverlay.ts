/*---------------------------------------------------------------------------------------------
 *  Every key that works right now, on the floating layer.
 *
 *  The status line is one row and the vocabulary outgrew it: the search pane's hints alone run to
 *  about 190 columns, so the keys past the edge were cut off and a user could not find out that a
 *  digit moves between the parts, that `Ctrl+B` hides the side bar, or that `Shift+Tab` walks the
 *  strip backwards — the `tabs` scope was never on the row at all. This is the rest of that row.
 *
 *  **It is the same list, not a second one.** `keyEntries` is what the status line is built from,
 *  and it is `IKeybindingService.lookupKeybinding` per declared command — so a key that is bound
 *  and does not apply here is absent for the same reason the dispatch would refuse it, and a key
 *  that a child process swallows is absent because the pane said so. Nothing is a table.
 *
 *  Upstream counterpart: none — upstream shows a user their keys in the Keyboard Shortcuts *editor*
 *  (`contrib/preferences/browser/keybindingsEditor.ts`), which tscode does not ship: its `contrib/preferences`
 *  is six files of settings plumbing and no editor. So the surface is A2's floating layer, and what fills it is
 *  the status line's own list.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../vs/base/common/color.js';
import { localize } from '../../vs/nls.js';
import { IKeybindingService } from '../../vs/platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { descriptionForeground, foreground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { editorWidgetBorder } from '../../vs/platform/theme/common/colors/editorColors.js';
import { quickInputBackground, quickInputForeground, quickInputTitleBackground } from '../../vs/platform/theme/common/colors/quickpickColors.js';
import { ILine } from '../terminal/screen.js';
import { IKeyEntry, keyEntries, SHOW_KEYS_ID } from './commands.js';
import { GOLDEN_CUT, IFrameSize, IOverlaySize, ListOverlay } from './overlay.js';
import { IKey } from '../terminal/input.js';

/** The box's own two rows, as `quickInput.ts` counts them. */
const BORDER_ROWS = 2;

/** The title row above the list, which `header()` draws and the list does not scroll. */
const TITLE_ROWS = 1;

/** The gap between a key and what it does, and the indent every row carries. */
const GAP = 2;

export class KeysOverlay extends ListOverlay {

	private readonly entries: IKeyEntry[];

	/**
	 * The navigation a pane answers itself, which is not a command and so is in no registry — the
	 * same string the status line puts in front of the hints.
	 */
	constructor(
		keybindingService: IKeybindingService,
		private readonly navigation: string,
		reaches: (id: string) => boolean,
		@IThemeService themeService: IThemeService
	) {
		super(themeService);

		// Every key but the one that opened this, which is on screen by being obeyed.
		this.entries = keyEntries(keybindingService, reaches).filter(entry => entry.id !== SHOW_KEYS_ID);
		this.didChangeRows();
	}

	get rowCount(): number {
		return this.entries.length;
	}

	get background(): Color | undefined {
		return this.themeService.getColorTheme().getColor(quickInputBackground);
	}

	get border(): Color | undefined {
		return this.themeService.getColorTheme().getColor(editorWidgetBorder);
	}

	override get hint(): string {
		return localize('tscode.showKeys.hint', "↑↓ move · Escape Close");
	}

	/** Wide enough for the longest row it has, and never wider than a quick input. */
	size(frame: IFrameSize): IOverlaySize {
		const widest = this.entries.reduce((width, entry) => Math.max(width, this.keyWidth + GAP + entry.title.length), this.navigation.length);

		return {
			width: Math.min(Math.max(widest + GAP * 2, this.navigation.length + GAP * 2), Math.round(frame.cols * GOLDEN_CUT), frame.cols),
			height: Math.min(this.entries.length + TITLE_ROWS + BORDER_ROWS, frame.rows)
		};
	}

	/** The keys are in one column, so the widest of them is what the titles line up after. */
	private get keyWidth(): number {
		return this.entries.reduce((width, entry) => Math.max(width, entry.key.length), 0);
	}

	protected override header(): ILine[] {
		const theme = this.themeService.getColorTheme();

		return [[{
			text: ` ${this.navigation}`,
			fg: theme.getColor(descriptionForeground),
			bg: theme.getColor(quickInputTitleBackground)
		}]];
	}

	/**
	 * No row background at all: this list is read rather than picked from, and its cursor row is
	 * marked by the foreground alone — the one overlay with no `.focused` background to fill with.
	 */
	protected override rowBackground(): Color | undefined {
		return undefined;
	}

	protected renderRow(index: number, focused: boolean): ILine {
		const theme = this.themeService.getColorTheme();
		const entry = this.entries[index];

		return [
			{ text: ` ${entry.key.padEnd(this.keyWidth)}`, fg: theme.getColor(quickInputForeground) ?? theme.getColor(foreground), bold: true },
			{ text: `${' '.repeat(GAP)}${entry.title}`, fg: theme.getColor(focused ? foreground : descriptionForeground) }
		];
	}

	override handleKey(key: IKey): boolean {
		if (key.name === 'escape' || key.name === 'enter') {
			this.close();

			return true;
		}

		return super.handleKey(key);
	}
}
