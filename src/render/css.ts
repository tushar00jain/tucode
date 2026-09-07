/*---------------------------------------------------------------------------------------------
 *  Platform-neutral CSS scalar decoding shared by the DOM interpreter and native projectors.
 *--------------------------------------------------------------------------------------------*/

/** CSS's own escape — `\.` for a literal dot, `\31 ` for a leading digit. */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([\s\S]))/g;

export function unescapeCss(text: string): string {
	return text.replace(CSS_ESCAPE, (_, hex: string | undefined, char: string) => hex ? String.fromCodePoint(parseInt(hex, 16)) : char);
}
