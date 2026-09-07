import { Color } from '../vs/base/common/color.js';

/** A translucent semantic colour flattened onto its projection background. */
export function blend(color: Color | undefined, over: Color | undefined): Color | undefined {
	return color && over && !color.isOpaque() ? color.blend(over) : color;
}
