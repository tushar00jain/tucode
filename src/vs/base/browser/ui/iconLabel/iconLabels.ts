/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../dom.js';
import { ThemeIcon } from '../../../common/themables.js';
import { parseLabelWithIconSegments } from '../../../common/iconLabels.js';

export function renderLabelWithIcons(text: string, renderIconsInDefaultColor?: boolean): Array<HTMLSpanElement | string> {
	return parseLabelWithIconSegments(text).map(segment => segment.text ?? renderIconClasses(segment.iconClassNames!, renderIconsInDefaultColor));
}

function renderIconClasses(classNames: readonly string[], renderDefaultColor?: boolean): HTMLSpanElement {
	const node = dom.$('span');
	node.classList.add(...classNames);
	if (renderDefaultColor) { node.classList.add('codicon-colored'); }
	return node;
}

export function renderIcon(icon: ThemeIcon, renderDefaultColor?: boolean): HTMLSpanElement {
	const node = dom.$(`span`);
	const classes = ThemeIcon.asClassNameArray(icon);
	if (renderDefaultColor) {
		classes.push('codicon-colored');
	}
	node.classList.add(...classes);
	return node;
}
