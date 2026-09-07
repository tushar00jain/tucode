/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** SearchWidget's debounce calculation, shared with native search inputs without importing a widget. */
export function searchOnTypeDelay(value: string, isRegex: boolean, debouncePeriod: number): number {
	if (!isRegex) { return debouncePeriod; }
	const regex = new RegExp(value, 'ug');
	const matchienessHeuristic = `
								~!@#$%^&*()_+
								\`1234567890-=
								qwertyuiop[]\\
								QWERTYUIOP{}|
								asdfghjkl;'
								ASDFGHJKL:"
								zxcvbnm,./
								ZXCVBNM<>? `.match(regex)?.length ?? 0;
	const delayMultiplier =
		matchienessHeuristic < 50 ? 1 :
			matchienessHeuristic < 100 ? 5 : // expressions like `.` or `\w`
				10; // only things matching empty string
	return debouncePeriod * delayMultiplier;
}
