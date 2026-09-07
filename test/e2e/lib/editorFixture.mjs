// The editor fixtures shared by the browser and public macOS journeys. Keeping the source text in
// one inert record module makes the native journey exercise the exact upstream token and wrapping
// inputs without importing either harness or maintaining a second handwritten approximation.

export const TOKEN_COLOR_FILE_CONTENT = [
	'/** The sample every language gets a copy of. */',
	"import { readFile } from 'node:fs/promises';",
	'',
	"export const KIND = 'POLYGLOT';",
	''
].join('\n');

export const LONG_LINE_HEAD = 'HEAD-MARKER ';
export const LONG_LINE_LEAD = 'lorem ipsum dolor sit amet '.repeat(24);
export const LONG_LINE_TAIL = 'y'.repeat(600);

export function longLineFileContent(needle) {
	return [
		'// One very long line, so the search preview has to elide.',
		'const before = 1;',
		LONG_LINE_HEAD + LONG_LINE_LEAD + needle + LONG_LINE_TAIL,
		'const after = 2;',
		''
	].join('\n');
}
