/*---------------------------------------------------------------------------------------------
 *  The terminal DOM — an element tree with real storage, and nothing else.
 *
 *  This is what lets the workbench's row renderers run here as upstream wrote them. Measured on
 *  this tree: `FilesRenderer`,
 *  `ResourceRenderer`, the search renderers and every widget they build a row out of make **zero**
 *  measurement calls. All 36 in that stack live in `listView.ts`, which this fork already replaced
 *  with `rangeMap`. So the wall that stopped Monaco under a synthetic DOM is not in front of these.
 *
 *  What is here is storage and structure. What is deliberately *not* here is measurement:
 *  `getBoundingClientRect`, `offsetWidth`, `getComputedStyle` and their friends answer zero,
 *  because zero is what a grid of cells has. A real-looking answer would be a lie a future
 *  renderer could act on.
 *
 *  Layout, focus and gestures are not here. `ActionBar` and `Button` were expected to need more
 *  than this and do not — both run against it — so what a row is still missing is one layer up: an
 *  `IAccessibilityService` for the action *view items*, which is phase F's.
 *
 *  Upstream counterpart: none — stands in for the browser's DOM, not for a file of tscode's. It exists so upstream's row renderers run here unmodified (`§4`).
 *--------------------------------------------------------------------------------------------*/

import type { ISelectorTarget } from './selector.js';

import { matchesSelector, parseSelector } from './selector.js';
import { TerminalStyleSheet } from './style.js';

export type TerminalNode = TerminalElement | TerminalText;

/** A declaration bag. Assignment is camelCase, `setProperty` is the CSS name; both are stored. */
export class TerminalStyle {

	setProperty(name: string, value: string): void {
		(this as Record<string, unknown>)[name] = value;
		(this as Record<string, unknown>)[camelCase(name)] = value;
	}

	removeProperty(name: string): void {
		delete (this as Record<string, unknown>)[name];
		delete (this as Record<string, unknown>)[camelCase(name)];
	}

	getPropertyValue(name: string): string {
		return (this as unknown as Record<string, string>)[name] ?? '';
	}
}

/** `background-color` → `backgroundColor`, which is the same property under two spellings. */
export function camelCase(name: string): string {
	return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * What `children` and `childNodes` answer with. Those are an `HTMLCollection` and a `NodeList`, and
 * the one thing both have that an array does not is `item(index)`, which answers `null` past the
 * end rather than throwing: `toolbar.ts:369`, `actionbar.ts:429`, `splitview.ts:1126` and
 * `menubar.ts:871` read an element out that way, `hoverWidget.ts:323` and `selectBoxCustom.ts:879`
 * read a node. Everything else those callers reach — `length`, `[index]`, iteration — an array
 * already has, so this is an array with the one method it was missing.
 */
export class TerminalCollection<T extends TerminalNode = TerminalElement> extends Array<T> {

	item(index: number): T | null {
		return this[index] ?? null;
	}
}

class TerminalClassList {

	private readonly names = new Set<string>();
	constructor(private readonly changed: () => void) { }

	add(...names: string[]): void {
		for (const name of names) {
			if (name) {
				this.names.add(name);
			}
		}
		this.changed();
	}

	remove(...names: string[]): void {
		for (const name of names) {
			this.names.delete(name);
		}
		this.changed();
	}

	toggle(name: string, force?: boolean): boolean {
		const on = force ?? !this.names.has(name);
		if (on) {
			this.names.add(name);
		} else {
			this.names.delete(name);
		}

		this.changed();
		return on;
	}

	contains(name: string): boolean {
		return this.names.has(name);
	}

	get length(): number {
		return this.names.size;
	}

	item(index: number): string | null {
		return [...this.names][index] ?? null;
	}

	values(): IterableIterator<string> {
		return this.names.values();
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this.values();
	}

	get value(): string {
		return [...this.names].join(' ');
	}

	set value(value: string) {
		this.names.clear();
		this.add(...value.split(/\s+/));
	}
}

/** What `dom.ts` calls a `Node`: the two things a tree holds, and what they have in common. */
export abstract class TerminalNodeBase {

	abstract readonly nodeType: number;
	abstract textContent: string;

	parentNode: TerminalElement | null = null;

	get ownerDocument(): TerminalDocument {
		return terminalDocument;
	}

	get parentElement(): TerminalElement | null {
		return this.parentNode;
	}

	remove(): void {
		this.parentNode?.removeChild(this as unknown as TerminalNode);
	}
}

export class TerminalText extends TerminalNodeBase {

	readonly nodeType = 3;
	readonly nodeName = '#text';

	constructor(public data: string) {
		super();
	}

	get textContent(): string {
		return this.data;
	}

	set textContent(text: string) {
		this.data = text;
	}
}

export class TerminalElement extends TerminalNodeBase implements ISelectorTarget {

	readonly nodeType = 1;
	readonly tagName: string;
	readonly childNodes = new TerminalCollection<TerminalNode>();
	readonly classList = new TerminalClassList(() => this.attributeChanged('class'));
	readonly style = new TerminalStyle();

	id = '';
	title = '';
	tabIndex = 0;
	draggable = false;
	value = '';
	selectionStart = 0;
	selectionEnd = 0;
	select(): void { this.setSelectionRange(0, this.value.length); }
	setSelectionRange(start: number, end: number): void {
		this.selectionStart = Math.min(this.value.length, Math.max(0, start));
		this.selectionEnd = Math.min(this.value.length, Math.max(this.selectionStart, end));
	}
	readonly attributeObservers = new Set<(name: string) => void>();
	private attributeChanged(name: string): void { for (const observer of this.attributeObservers) { observer(name); } }

	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Set<{ listener: EventListenerOrEventListenerObject; capture: boolean; once: boolean }>>();
	private _sheet: TerminalStyleSheet | undefined;

	/**
	 * A `<style>` element carries one and nothing else does, which is `HTMLStyleElement.sheet`.
	 * `createCSSRule` writes through it, so this is what makes a rule built at runtime — a
	 * decoration's colour and badge — reach the resolver alongside the sheets on disk.
	 */
	get sheet(): TerminalStyleSheet | null {
		return this.tagName === 'STYLE' ? (this._sheet ??= new TerminalStyleSheet()) : null;
	}

	constructor(tagName = 'div') {
		super();
		this.tagName = tagName.toUpperCase();
	}

	get nodeName(): string {
		return this.tagName;
	}

	get children(): TerminalCollection {
		const elements = new TerminalCollection();
		for (const child of this.childNodes) {
			if (isElement(child)) {
				elements.push(child);
			}
		}

		return elements;
	}

	get firstChild(): TerminalNode | null {
		return this.childNodes[0] ?? null;
	}

	get lastChild(): TerminalNode | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}

	get firstElementChild(): TerminalElement | null {
		return this.children[0] ?? null;
	}

	get lastElementChild(): TerminalElement | null {
		const elements = this.children;

		return elements[elements.length - 1] ?? null;
	}

	get nextSibling(): TerminalNode | null {
		const siblings = this.parentNode?.childNodes;

		return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
	}

	get previousSibling(): TerminalNode | null {
		const siblings = this.parentNode?.childNodes;
		const index = siblings ? siblings.indexOf(this) : 0;

		return index > 0 ? siblings![index - 1] : null;
	}

	get className(): string {
		return this.classList.value;
	}

	set className(value: string) {
		this.classList.value = value;
	}

	hasClass(name: string): boolean {
		return this.classList.contains(name);
	}

	/** Every descendant's text, in document order — which is also what a painter writes out. */
	get textContent(): string {
		return this.childNodes.map(child => child.textContent).join('');
	}

	/**
	 * `HighlightedLabel.render` opens with `textContent = ''`, and it means *detach the children*.
	 * A tree that only overwrites a string renders every update on top of the last one, silently
	 * and with the right text still present — the one semantic the G0 probe got wrong.
	 */
	set textContent(text: string) {
		for (const child of this.childNodes) {
			child.parentNode = null;
		}
		this.childNodes.length = 0;
		if (text) {
			this.appendChild(new TerminalText(text));
		}
	}

	appendChild<T extends TerminalNode>(child: T): T {
		this.insertAt(child, this.childNodes.length);

		return child;
	}

	append(...children: (TerminalNode | string)[]): void {
		for (const child of children) {
			this.appendChild(asNode(child));
		}
	}

	prepend(...children: (TerminalNode | string)[]): void {
		let at = 0;
		for (const child of children) {
			this.insertAt(asNode(child), at++);
		}
	}

	insertBefore<T extends TerminalNode>(child: T, reference: TerminalNode | null): T {
		const at = reference ? this.childNodes.indexOf(reference) : -1;
		this.insertAt(child, at === -1 ? this.childNodes.length : at);

		return child;
	}

	/** `dom.after(sibling, child)`, which is how `IconLabel` puts its suffix container in place. */
	after(...children: (TerminalNode | string)[]): void {
		const parent = this.parentNode;
		if (!parent) {
			return;
		}

		let at = parent.childNodes.indexOf(this) + 1;
		for (const child of children) {
			parent.insertAt(asNode(child), at++);
		}
	}

	removeChild<T extends TerminalNode>(child: T): T {
		const at = this.childNodes.indexOf(child);
		if (at !== -1) {
			this.childNodes.splice(at, 1);
			child.parentNode = null;
		}

		return child;
	}

	replaceChildren(...children: (TerminalNode | string)[]): void {
		this.textContent = '';
		this.append(...children);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value));
		this.attributeChanged(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
		this.attributeChanged(name);
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	matches(selector: string): boolean {
		const parsed = parseSelector(selector);

		return !!parsed && matchesSelector(this, parsed);
	}

	querySelector(selector: string): TerminalElement | null {
		const parsed = parseSelector(selector);
		if (!parsed) {
			return null;
		}

		for (const element of this.descendants()) {
			if (matchesSelector(element, parsed)) {
				return element;
			}
		}

		return null;
	}

	querySelectorAll(selector: string): TerminalElement[] {
		const parsed = parseSelector(selector);

		return parsed ? [...this.descendants()].filter(element => matchesSelector(element, parsed)) : [];
	}

	closest(selector: string): TerminalElement | null {
		const parsed = parseSelector(selector);
		for (let node: TerminalElement | null = this; parsed && node; node = node.parentNode) {
			if (matchesSelector(node, parsed)) {
				return node;
			}
		}

		return null;
	}

	contains(node: TerminalNode | null): boolean {
		for (let walk = node; walk; walk = walk.parentNode) {
			if (walk === this) {
				return true;
			}
		}

		return false;
	}

	*descendants(): IterableIterator<TerminalElement> {
		for (const child of this.childNodes) {
			if (isElement(child)) {
				yield child;
				yield* child.descendants();
			}
		}
	}

	//#region --- present, and answering what a grid of cells has

	addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
		if (!listener) { return; }
		const capture = typeof options === 'boolean' ? options : !!options?.capture;
		let listeners = this.listeners.get(type);
		if (!listeners) { this.listeners.set(type, listeners = new Set()); }
		if (![...listeners].some(entry => entry.listener === listener && entry.capture === capture)) {
			listeners.add({ listener, capture, once: typeof options === 'object' && !!options.once });
		}
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
		const capture = typeof options === 'boolean' ? options : !!options?.capture;
		for (const entry of this.listeners.get(type) ?? []) {
			if (entry.listener === listener && entry.capture === capture) { this.listeners.get(type)?.delete(entry); }
		}
	}

	dispatchEvent(event: Event): boolean {
		if (!event.target) {
			Object.defineProperty(event, 'target', { configurable: true, value: this });
		}
		const path: TerminalElement[] = [];
		for (let node: TerminalElement | null = this; node; node = node.parentNode) { path.push(node); }
		const invoke = (node: TerminalElement, capture: boolean, phase: number) => {
			Object.defineProperty(event, 'currentTarget', { configurable: true, value: node });
			Object.defineProperty(event, 'eventPhase', { configurable: true, value: phase });
			for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
				if (entry.capture !== capture) { continue; }
				if (entry.once) { node.listeners.get(event.type)?.delete(entry); }
				const { listener } = entry;
				if (typeof listener === 'function') { listener.call(node as unknown as EventTarget, event); }
				else { listener.handleEvent(event); }
			}
		};
		try {
			for (const node of path.slice(1).reverse()) {
				invoke(node, true, Event.CAPTURING_PHASE);
				if (event.cancelBubble) { return !event.defaultPrevented; }
			}
			invoke(this, true, Event.AT_TARGET);
			invoke(this, false, Event.AT_TARGET);
			if (event.bubbles && !event.cancelBubble) {
				for (const node of path.slice(1)) {
					invoke(node, false, Event.BUBBLING_PHASE);
					if (event.cancelBubble) { break; }
				}
			}
		} finally {
			Object.defineProperty(event, 'currentTarget', { configurable: true, value: null });
			Object.defineProperty(event, 'eventPhase', { configurable: true, value: Event.NONE });
		}
		return !event.defaultPrevented;
	}

	focus(): void {
		if (terminalDocument.activeElement === this) { return; }
		terminalDocument.activeElement?.blur();
		terminalDocument.activeElement = this;
		this.dispatchEvent(new Event('focus'));
		this.dispatchEvent(new Event('focusin', { bubbles: true }));
	}

	blur(): void {
		if (terminalDocument.activeElement !== this) { return; }
		terminalDocument.activeElement = null;
		this.dispatchEvent(new Event('blur'));
		this.dispatchEvent(new Event('focusout', { bubbles: true }));
	}
	scrollIntoView(): void { }

	getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } {
		return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
	}

	getClientRects(): [] { return []; }

	//#endregion

	private insertAt(child: TerminalNode, at: number): void {
		if (isFragment(child)) {
			for (const node of [...child.childNodes]) {
				this.insertAt(node, at++);
			}

			return;
		}

		child.parentNode?.removeChild(child);
		child.parentNode = this;
		this.childNodes.splice(at, 0, child);
	}
}

for (const property of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft']) {
	Object.defineProperty(TerminalElement.prototype, property, { get: () => 0, set: () => { }, configurable: true });
}

class TerminalFragment extends TerminalElement {
	constructor() {
		super('#fragment');
	}
}

export class TerminalDocument {

	readonly nodeType = 9;
	readonly documentElement = new TerminalElement('html');
	readonly head = new TerminalElement('head');
	readonly body = new TerminalElement('body');

	/** One terminal, one focus. Nothing moves it yet; the gestures that would are phase F. */
	activeElement: TerminalElement | null = null;

	constructor() {
		this.documentElement.append(this.head, this.body);
	}

	/** `getWindow(node)` is `node.ownerDocument.defaultView`, and there is one window here. */
	get defaultView(): typeof globalThis {
		return globalThis;
	}

	createElement(tagName: string): TerminalElement {
		return new TerminalElement(tagName);
	}

	createElementNS(_namespace: string, tagName: string): TerminalElement {
		return new TerminalElement(tagName);
	}

	createTextNode(text: string): TerminalText {
		return new TerminalText(text);
	}

	createDocumentFragment(): TerminalElement {
		return new TerminalFragment();
	}

	querySelector(selector: string): TerminalElement | null {
		return this.documentElement.querySelector(selector);
	}

	getElementById(id: string): TerminalElement | null {
		return this.documentElement.querySelector(`#${id}`);
	}

	addEventListener(): void { }
	removeEventListener(): void { }
	queryCommandSupported(): boolean { return false; }
}

function isElement(node: TerminalNode): node is TerminalElement {
	return node.nodeType === 1;
}

function isFragment(node: TerminalNode): node is TerminalElement {
	return node.nodeType === 1 && (node as TerminalElement).tagName === '#FRAGMENT';
}

function asNode(child: TerminalNode | string): TerminalNode {
	return typeof child === 'string' ? new TerminalText(child) : child;
}

export const terminalDocument = new TerminalDocument();

/** Attribute observation for HistoryInputBox's class-driven placeholder updates. No layout engine. */
export class TerminalMutationObserver {
	private readonly subscriptions = new Map<TerminalElement, (name: string) => void>();
	private records: MutationRecord[] = [];
	constructor(private readonly callback: MutationCallback) { }
	observe(target: TerminalElement, options: MutationObserverInit): void {
		if (options.childList || options.characterData || options.subtree) { throw new Error('Terminal MutationObserver supports attributes only'); }
		const previous = this.subscriptions.get(target);
		if (previous) { target.attributeObservers.delete(previous); }
		const listener = (name: string) => {
			if (options.attributeFilter && !options.attributeFilter.includes(name)) { return; }
			const first = this.records.length === 0;
			this.records.push({ type: 'attributes', target, attributeName: name } as unknown as MutationRecord);
			if (first) { queueMicrotask(() => {
				const records = this.takeRecords();
				if (records.length) { this.callback(records, this as unknown as MutationObserver); }
			}); }
		};
		this.subscriptions.set(target, listener);
		target.attributeObservers.add(listener);
	}
	takeRecords(): MutationRecord[] { const records = this.records; this.records = []; return records; }
	disconnect(): void {
		for (const [target, listener] of this.subscriptions) { target.attributeObservers.delete(listener); }
		this.subscriptions.clear(); this.records = [];
	}
}

/**
 * The globals a rendering page has. `instanceof` is what `dom.ts` tests an element with —
 * `isHTMLElement`, and `join`'s `separator instanceof Node` — so the constructors it names have
 * to be the ones this tree builds, not stand-ins beside them.
 */
export function installTerminalDocument(): void {
	const globals = globalThis as Record<string, unknown>;

	globals['document'] = terminalDocument;
	globals['Node'] = TerminalNodeBase;
	globals['Element'] = TerminalElement;
	globals['HTMLElement'] = TerminalElement;
	globals['Text'] = TerminalText;
	globals['DocumentFragment'] = TerminalFragment;
	globals['MutationObserver'] = TerminalMutationObserver;
}
