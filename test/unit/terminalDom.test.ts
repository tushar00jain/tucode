/*---------------------------------------------------------------------------------------------
 *  The terminal DOM and the stylesheet resolver, on upstream's own sheet.
 *
 *  Each of these is a semantic the G0 measurement found by being bitten by it, so each fails
 *  *silently* if it regresses: a `textContent = ''` that does not detach renders every update on
 *  top of the last one with the right text still present, a detach that does not unlink leaks a
 *  row per repaint, and a `classList` that does not agree with `className` leaves the resolver
 *  reading nothing while the tree still paints.
 *
 *  The resolver is asserted against `iconlabel.css` as it is on disk — upstream's file, restored
 *  verbatim from `vendor` — rather than against a fixture, so the values under test are the ones
 *  the application actually resolves.
 *
 *  Upstream counterpart: none — tests `tui/terminal/dom`, which stands in for the browser rather than for a tscode file.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TerminalElement, TerminalText, TerminalMutationObserver, terminalDocument } from '../../src/tui/terminal/dom/document.js';
import { matchesSelector, parseSelector } from '../../src/tui/terminal/dom/selector.js';
import { addStylesheet, resolvePseudo, resolveStyle, setGlyphSubstitution } from '../../src/tui/terminal/dom/style.js';
import { addGlyphSubstitutes, setIconFont, substituteGlyphs } from '../../src/tui/terminal/dom/glyphSubstitutes.js';

const ICONLABEL_CSS = fileURLToPath(new URL('../../src/vs/base/browser/ui/iconLabel/iconlabel.css', import.meta.url));

/** `parent > child.classes`, which is the shape every assertion below wants. */
function element(classes: string, ...children: (TerminalElement | string)[]): TerminalElement {
	const node = terminalDocument.createElement('span');
	node.className = classes;
	node.append(...children);

	return node;
}

describe('terminal DOM', () => {
	it('captures non-bubbling focus and blur and bubbles focusin/out across child transitions', () => {
		const parent = element('parent'); const first = element('first'); const second = element('second');
		parent.append(first, second);
		const events: string[] = [];
		for (const type of ['focus', 'blur']) {
			parent.addEventListener(type, event => events.push(`${event.type}:capture`), true);
			parent.addEventListener(type, event => events.push(`${event.type}:bubble`));
		}
		for (const type of ['focusin', 'focusout']) { parent.addEventListener(type, event => events.push(event.type)); }
		first.focus(); second.focus(); second.blur();
		assert.deepEqual(events, ['focus:capture', 'focusin', 'blur:capture', 'focusout', 'focus:capture', 'focusin', 'blur:capture', 'focusout']);
	});
	it('removes the matching capture registration without removing its bubbling sibling', () => {
		const parent = element('parent'); const child = element('child'); parent.append(child);
		let calls = 0; const listener = () => calls++;
		parent.addEventListener('probe', listener, true); parent.addEventListener('probe', listener);
		parent.removeEventListener('probe', listener, true);
		child.dispatchEvent(new Event('probe', { bubbles: true }));
		assert.equal(calls, 1);
	});
	it('clears dispatch bookkeeping when propagation stops during capture', () => {
		const parent = element('parent'); const child = element('child'); parent.append(child);
		parent.addEventListener('probe', event => event.stopPropagation(), true);
		const event = new Event('probe', { bubbles: true });
		child.dispatchEvent(event);
		assert.equal(event.currentTarget, null);
		assert.equal(event.eventPhase, Event.NONE);
	});

	it('detaches children on `textContent = ""`, rather than rendering on top of them', () => {
		const label = element('monaco-highlighted-label', element('highlight', 'life'), 'cycle.ts');
		assert.equal(label.textContent, 'lifecycle.ts');

		// `HighlightedLabel.render` opens with exactly this, then appends the new children.
		label.textContent = '';
		label.append(element('highlight', 'prov'), 'ider.rs');

		assert.equal(label.textContent, 'provider.rs');
		assert.equal(label.childNodes.length, 2);
	});

	it('unlinks on detach, so a repaint cannot leak a row', () => {
		const row = element('monaco-tl-contents');
		const first = element('label-name', 'a');
		const second = element('label-name', 'b');
		row.append(first, second);

		first.remove();
		row.removeChild(second);

		assert.deepEqual([...row.children], []);
		assert.equal(first.parentNode, null);
		assert.equal(second.parentNode, null);
	});

	it('moves a child rather than sharing it when it is appended twice', () => {
		const from = element('a');
		const to = element('b');
		const child = element('c');
		from.append(child);
		to.append(child);

		assert.deepEqual([...from.children], []);
		assert.equal(child.parentNode, to);
	});

	// `children` is an `HTMLCollection` and `childNodes` a `NodeList`, and `item(index)` is the
	// accessor that is on both and on no array: `toolbar.ts:369` reads every action item out with
	// it, and an index past the end is `null` there rather than a throw.
	it('reads a child out by index, and answers `null` past the end', () => {
		const row = element('monaco-tl-contents');
		const first = element('label-name', 'a');
		row.append(first, 'trailing');

		assert.equal(row.children.length, 1);
		assert.equal(row.children.item(0), first);
		assert.equal(row.children.item(1), null);
		assert.equal(row.children.item(-1), null);
		assert.equal(row.childNodes.item(1)?.textContent, 'trailing');
		assert.equal(row.childNodes.item(2), null);
	});

	it('keeps `classList` and `className` agreeing with each other', () => {
		const node = element('monaco-icon-label explorer-item');
		node.classList.add('bold');
		node.classList.remove('explorer-item');

		assert.equal(node.className, 'monaco-icon-label bold');
		assert.ok(node.classList.contains('bold'));

		// `FastLabelNode.classNames` clears through `classList.value` and adds the new set.
		node.classList.value = '';
		node.classList.add('monaco-icon-label', 'strikethrough');

		assert.equal(node.className, 'monaco-icon-label strikethrough');
		assert.ok(!node.classList.contains('bold'));
	});

	it('stores attributes and reads them back', () => {
		const node = element('label');
		node.setAttribute('aria-label', 'provider.rs');

		assert.equal(node.getAttribute('aria-label'), 'provider.rs');
		node.removeAttribute('aria-label');
		assert.equal(node.getAttribute('aria-label'), null);
	});

	it('answers the reach `FilesRenderer.renderStat` makes for the twistie', () => {
		const row = element('monaco-list-row');
		const inner = element('monaco-tl-row');
		const twistie = element('monaco-tl-twistie');
		const contents = element('monaco-tl-contents');
		row.append(inner);
		inner.append(twistie, contents);

		assert.equal(contents.parentElement?.parentElement?.querySelector('.monaco-tl-twistie'), twistie);
	});

	it('makes text nodes first class, so a span can be replaced in place', () => {
		const container = element('a');
		const text = new TerminalText('one');
		container.append(text, element('b', 'two'));

		container.replaceChildren('three');

		assert.equal(container.textContent, 'three');
		assert.equal(text.parentNode, null);
	});

	it('bubbles browser widget input through the rendered tree without replacing its target', () => {
		const row = element('monaco-list-row');
		const contents = element('monaco-tl-contents');
		row.append(contents);
		const seen: EventTarget[] = [];
		contents.addEventListener('click', event => seen.push(event.target!));
		row.addEventListener('click', event => seen.push(event.target!));

		contents.dispatchEvent(new Event('click', { bubbles: true }));

		assert.deepEqual(seen, [contents, contents]);
	});
});

describe('selector subset', () => {

	const target = () => {
		const outer = element('monaco-icon-label bold');
		const middle = element('monaco-icon-label-container');
		const inner = element('label-name');
		outer.append(middle);
		middle.append(inner);

		return inner;
	};

	const match = (selector: string, node: TerminalElement) => {
		const parsed = parseSelector(selector);
		assert.ok(parsed, `${selector} is outside the subset`);

		return matchesSelector(node, parsed);
	};

	it('matches class, compound, descendant and child', () => {
		const inner = target();

		assert.ok(match('.label-name', inner));
		assert.ok(match('.monaco-icon-label.bold .label-name', inner));
		assert.ok(match('.monaco-icon-label > .monaco-icon-label-container > .label-name', inner));
		// Discriminating: `.bold` is on the grandparent, so a child combinator must not reach it.
		assert.ok(!match('.bold > .label-name', inner));
		assert.ok(!match('.monaco-icon-label.italic .label-name', inner));
	});

	it('skips what a terminal has no form for, rather than approximating it', () => {
		for (const selector of ['.monaco-list:focus .selected', '.row:hover', 'a[href]', '.a:not(.b:hover)']) {
			assert.equal(parseSelector(selector), undefined, selector);
		}
	});

	it('negates a compound, which is what takes a file row\'s twistie away', () => {
		// `views.css:8`, the rule that lets an icon stand where a folder's twistie stands.
		const rule = '.file-icon-themable-tree.align-icons-and-twisties .monaco-tl-twistie:not(.force-twistie):not(.collapsible)';
		const twistie = element('monaco-tl-twistie');
		element('file-icon-themable-tree align-icons-and-twisties', twistie);

		assert.ok(match(rule, twistie));
		twistie.className = 'monaco-tl-twistie collapsible';
		assert.ok(!match(rule, twistie));
		// `:not()` weighs what its argument weighs, so two of them outrank one.
		assert.ok(parseSelector('.a:not(.b):not(.c)')!.specificity > parseSelector('.a:not(.b)')!.specificity);
	});

	it('reads a pseudo-element off the rightmost compound, and only there', () => {
		assert.equal(parseSelector('.monaco-icon-label::before')!.pseudo, 'before');
		assert.equal(parseSelector('.a > .b:after')!.pseudo, 'after');
		assert.equal(parseSelector('.monaco-icon-label')!.pseudo, undefined);
		// The compounds are still the element's, so the same selector matches the same element.
		assert.deepEqual(parseSelector('.a > .b::after')!.compounds, parseSelector('.a > .b')!.compounds);
		// A pseudo-class on a compound that is not the last one is still outside the subset.
		assert.equal(parseSelector('.monaco-list:focus .selected::after'), undefined);
	});

	it('orders by specificity', () => {
		assert.ok(parseSelector('.a.b')!.specificity > parseSelector('.a')!.specificity);
		assert.ok(parseSelector('#a')!.specificity > parseSelector('.a.b')!.specificity);
	});
});

describe('stylesheet resolver', () => {

	addStylesheet(readFileSync(ICONLABEL_CSS, 'utf8'));

	/** `iconlabel.css`'s own tree, which is the one every row in this frontend is built out of. */
	function label(...classes: string[]) {
		const outer = element(['monaco-icon-label', ...classes].join(' '));
		const container = element('monaco-icon-label-container');
		const nameContainer = element('monaco-icon-name-container');
		const name = element('label-name');
		const descriptionContainer = element('monaco-icon-description-container');
		const description = element('label-description');
		outer.append(container);
		container.append(nameContainer, descriptionContainer);
		nameContainer.append(name);
		descriptionContainer.append(description);

		return { outer, name, description };
	}

	it('reads `opacity` as dim off upstream\'s own rule', () => {
		// `.monaco-icon-label > … > .label-description { opacity: .7 }` — the one thing that makes a
		// path beside a filename read as secondary in a terminal.
		assert.equal(resolveStyle(label().description).dim, true);
		assert.equal(resolveStyle(label().name).dim, undefined);
	});

	it('reads `font-weight` and `text-decoration` off the modifier classes', () => {
		assert.equal(resolveStyle(label('bold').name).bold, true);
		assert.equal(resolveStyle(label('italic').name).italic, true);
		assert.equal(resolveStyle(label('strikethrough').name).strikethrough, true);
		// Discriminating: each modifier is on the *outer* element and applies only to the label
		// below it, so a resolver that ignored the descendant part would answer this one too.
		assert.equal(resolveStyle(label('bold').outer).bold, undefined);
	});

	it('takes an inline `display: none` as "do not paint"', () => {
		const { name } = label();
		assert.equal(resolveStyle(name).hidden, undefined);

		// `FilesRenderer.renderElement` hides the label this way while a row is editable — it assigns
		// `style.display`, which `TerminalStyle` files under both spellings of the name, and `display`
		// spells the same in each. So this writes the declaration that assignment writes.
		name.style.setProperty('display', 'none');
		assert.equal(resolveStyle(name).hidden, true);
	});

	it('allows visible count badges to override display:none without overriding visibility:hidden', () => {
		addStylesheet('.search-badge-test { display: none; } .search-badge-test.keep { display: inline-block; }');
		const badge = element('search-badge-test keep');
		assert.equal(resolveStyle(badge).hidden, false);
		badge.style.setProperty('visibility', 'hidden');
		assert.equal(resolveStyle(badge).hidden, true);
	});

	it('delivers input class mutations asynchronously and disconnects queued notifications', async () => {
		const input = new TerminalElement('textarea');
		const batches: MutationRecord[][] = [];
		const observer = new TerminalMutationObserver(records => batches.push(records));
		observer.observe(input, { attributeFilter: ['class'] });
		input.classList.add('empty'); input.setAttribute('title', 'ignored');
		assert.equal(batches.length, 0);
		await Promise.resolve();
		assert.equal(batches.length, 1); assert.equal(batches[0][0].target, input);
		input.classList.remove('empty'); observer.disconnect();
		await Promise.resolve(); assert.equal(batches.length, 1);
		input.value = 'query'; input.select(); assert.equal(input.selectionEnd, 5);
	});

	it('keeps a colour as upstream wrote it, for the theme to resolve', () => {
		addStylesheet('.label-name { color: var(--vscode-list-activeSelectionForeground); }');

		assert.equal(resolveStyle(label().name).color, 'var(--vscode-list-activeSelectionForeground)');
	});

	it('reads a horizontal margin as separation, and a zero one as none', () => {
		// `.label-description { margin-left: 0.5em }` is upstream's own, and it is the only thing
		// between a file name and the folder beside it — a row that ignored it reads `main.tssrc`.
		assert.equal(resolveStyle(label().description).spaceBefore, true);
		assert.equal(resolveStyle(label().description).spaceAfter, undefined);

		addStylesheet([
			'.no-space { margin-left: 0; padding-right: 0px; }',
			'.shorthand { margin: 0 2px; }',
			'.vertical-only { margin: 4px 0; }',
			'.pushed { margin-left: auto; }'
		].join('\n'));

		const of = (className: string) => resolveStyle(element(className));
		assert.deepEqual([of('no-space').spaceBefore, of('no-space').spaceAfter], [false, false]);
		assert.deepEqual([of('shorthand').spaceBefore, of('shorthand').spaceAfter], [true, true]);
		// Discriminating: the vertical form has the same two-value shape and must read as neither.
		assert.deepEqual([of('vertical-only').spaceBefore, of('vertical-only').spaceAfter], [false, false]);
		assert.equal(of('pushed').spaceBefore, true);
	});

	it('lets the later of two equally specific rules win', () => {
		addStylesheet('.label-name { font-style: italic; }\n.label-name { font-style: normal; }');

		assert.equal(resolveStyle(label().name).italic, false);
	});

	/**
	 * The rule `FileIconThemeLoader` writes for one of seti's definitions, spelled exactly as it
	 * spells it: `css.stringValue` puts the theme document's `fontCharacter` in as the four
	 * characters `E00B` behind a backslash, so the escape has to be read before the codepoint it
	 * names can be recognised at all.
	 */
	const SETI_RULE = ".ts-ext-file-icon.file-icon::before { color: #519aba; content: '\\E00B'; font-family: 'seti'; }";

	const icon = () => resolvePseudo(element('monaco-icon-label ts-ext-file-icon file-icon'), 'before');

	it('keeps an icon codepoint until the terminal substitution is installed', () => {
		addStylesheet(SETI_RULE);
		setGlyphSubstitution(style => style);

		assert.deepEqual(
			[icon()?.content, icon()?.color],
			[String.fromCharCode(0xe00b), '#519aba']);

		setGlyphSubstitution(substituteGlyphs);
	});

	it('draws that codepoint as its substitute, and as itself when the terminal\'s font has it', () => {
		addStylesheet(SETI_RULE);
		addGlyphSubstitutes([[String.fromCharCode(0xe00b), 'T']]);

		assert.deepEqual([icon()?.content, icon()?.color], ['T', '#519aba']);

		// `tscode.iconFont`: the user says the terminal's font has the glyph, so it is drawn.
		setIconFont(true);
		assert.equal(icon()?.content, String.fromCharCode(0xe00b));
		setIconFont(false);

		// A codepoint with no substitute is not drawn at all, which is what a box with no text is.
		addStylesheet(".no-substitute::before { content: '\\E0FF'; }");
		assert.equal(resolvePseudo(element('no-substitute'), 'before'), undefined);
	});
});
