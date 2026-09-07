/*---------------------------------------------------------------------------------------------
 *  The token stream the vim engine parses an ex command with.
 *
 *  `:` goes through `exCommandDispatcher._processCommand`, which is `new CM.StringStream(input)`
 *  before it is anything else — so this is on the path of `:w` and not only of `:sort` and
 *  `:s/…/…/`. It is CodeMirror's own cursor-over-a-string, which the CodeMirror 6 adapter takes
 *  from `@codemirror/language` and this port has no source for: the engine is vendored, the
 *  editor it was written against is not, and there is nothing of this shape under `src/vs`
 *  (`eatSpace` and `skipToEnd` appear in no file there).
 *
 *  **So this is rung 4, and the spec is not behaviour** — it is the `StringStream` interface in
 *  `src/vendor/codemirror-vim/types.ts`, which the engine is typed against, member for member.
 *
 *  It is here rather than beside the adapter because **nothing about a cursor over a string is an
 *  editor's**: `src/vendor/monaco-vim/cm_adapter.ts` carries one of its own, but it is declared
 *  inside a file that imports Monaco, so taking it means taking the editor too. `vimAdapter.ts`
 *  overrides the vendored static with this one, so the live implementation is a single file with
 *  no Monaco in its closure rather than a second copy behind one.
 *
 *  Upstream counterpart: none — see above; there is no VS Code file of this shape.
 *--------------------------------------------------------------------------------------------*/

import type { StringStream as IStringStream } from '../../../../../vendor/codemirror-vim/types.js';

/** What a `match`/`eat` argument can be, in all three of the forms the engine passes. */
type Match = string | RegExp | ((ch: string) => boolean);

export class StringStream implements IStringStream {

	pos = 0;
	start = 0;

	/** Where the current line began. There is only ever one line here, so it is always zero. */
	private lineStart = 0;

	constructor(public string: string, private readonly tabSize = 8) { }

	eol(): boolean {
		return this.pos >= this.string.length;
	}

	sol(): boolean {
		return this.pos === this.lineStart;
	}

	peek(): string | void {
		return this.string.charAt(this.pos) || undefined;
	}

	next(): string | void {
		return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined;
	}

	eat(match: Match): string | void {
		const ch = this.string.charAt(this.pos);

		if (!ch || !test(match, ch)) {
			return undefined;
		}

		this.pos++;

		return ch;
	}

	eatWhile(match: Match): boolean {
		const start = this.pos;

		while (this.eat(match)) { /* consumed by `eat` */ }

		return this.pos > start;
	}

	eatSpace(): boolean {
		const start = this.pos;

		while (/[\s ]/.test(this.string.charAt(this.pos))) {
			this.pos++;
		}

		return this.pos > start;
	}

	skipToEnd(): void {
		this.pos = this.string.length;
	}

	skipTo(ch: string): boolean | void {
		const found = this.string.indexOf(ch, this.pos);

		if (found <= -1) {
			return undefined;
		}

		this.pos = found;

		return true;
	}

	backUp(n: number): void {
		this.pos -= n;
	}

	column(): number {
		return countColumn(this.string, this.start, this.tabSize, this.lineStart);
	}

	indentation(): number {
		return countColumn(this.string, undefined, this.tabSize, this.lineStart);
	}

	/**
	 * Consumes `pattern` at the cursor and answers what matched — the array for a regular
	 * expression, `true` for a string. `consume === false` looks without moving.
	 */
	match(pattern: string | RegExp, consume?: boolean, caseInsensitive?: boolean): boolean | RegExpMatchArray | null {
		if (typeof pattern === 'string') {
			const cased = (str: string) => caseInsensitive ? str.toLowerCase() : str;
			const substring = this.string.substr(this.pos, pattern.length);

			if (cased(substring) !== cased(pattern)) {
				return false;
			}
			if (consume !== false) {
				this.pos += pattern.length;
			}

			return true;
		}

		const match = this.string.slice(this.pos).match(pattern);

		if (match && match.index! > 0) {
			return null;
		}
		if (match && consume !== false) {
			this.pos += match[0].length;
		}

		return match;
	}

	current(): string {
		return this.string.slice(this.start, this.pos);
	}
}

function test(match: Match, ch: string): boolean {
	return typeof match === 'string'
		? ch === match
		: match instanceof RegExp ? match.test(ch) : match(ch);
}

/**
 * The column `end` sits at, counting a tab as the next multiple of `tabSize`. CodeMirror's
 * `countColumn`, whose `end === undefined` arm means *the first non-whitespace character*, which
 * is what `indentation()` asks for.
 */
function countColumn(string: string, end: number | undefined, tabSize: number, lineStart: number): number {
	let target = end;

	if (target === undefined) {
		const found = string.search(/[^\s ]/);
		target = found === -1 ? string.length : found;
	}

	let n = 0;
	for (let i = lineStart; i < target; i++) {
		n = string.charAt(i) === '\t' ? n + (tabSize - (n % tabSize)) : n + 1;
	}

	return n;
}
