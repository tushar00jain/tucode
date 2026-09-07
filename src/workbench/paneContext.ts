import { localize } from '../vs/nls.js';
import { RawContextKey } from '../vs/platform/contextkey/common/contextkey.js';

export const CanEditInputContext = new RawContextKey<boolean>('tscodeCanEditInput', false,
	localize('tscodeCanEditInput', "Whether the focused row is a text input"));
export const FilteringContext = new RawContextKey<boolean>('tscodeFiltering', false,
	localize('tscodeFiltering', "Whether the focused pane's filter box is being typed into"));
export const HasContextMenuContext = new RawContextKey<boolean>('tscodeHasContextMenu', false,
	localize('tscodeHasContextMenu', 'Whether the focused row has a context menu'));
export const MultipleViewsContext = new RawContextKey<boolean>('tscodeMultipleViews', false,
	localize('tscodeMultipleViews', 'Whether the shown view container has more than one view'));
export const CanScrollHorizontallyContext = new RawContextKey<boolean>('tscodeCanScrollHorizontally', false,
	localize('tscodeCanScrollHorizontally', "Whether the focused pane has content past its right-hand edge"));
