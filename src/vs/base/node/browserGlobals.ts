/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Upstream counterpart: none — the globals a browser supplies (`document`, `HTMLElement`, `requestAnimationFrame`, `ResizeObserver`); no tscode file declares them.
 *--------------------------------------------------------------------------------------------*/

/**
 * The globals a page has and a Node process does not, for the handful of `base/browser`
 * modules the headless service graph reaches — `window.ts`, `browser.ts`, `canIUse.ts` and
 * `dom.ts`, which are imported for `runWhenWindowIdle`, `mainWindow` and a feature probe and
 * nothing else. Boot imports this for its side effect before any of them load.
 *
 * `window` is `globalThis`, so the timer and idle-callback probes those modules run resolve
 * to Node's own implementations rather than to stubs: `_runWhenIdle` finds no
 * `requestIdleCallback` and falls back to `setTimeout`, which is the behaviour it is written
 * to have. What is stubbed below is only what has no Node counterpart at all, and each stub
 * answers what the probe reading it treats as "absent".
 *
 * The document is **not** a stub any more: `tui/terminal/dom` is a real element tree, which is what lets
 * upstream's row renderers run here unmodified — see `§4` in `docs/ARCHITECTURE.md`.
 */

import { readFile } from 'node:fs/promises';
import { cwd } from 'node:process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installTerminalDocument } from '../../../tui/terminal/dom/document.js';
import { checkoutRoot } from './checkout.js';

const globals = globalThis as Record<string, unknown>;

globals['window'] ??= globalThis;
globals['self'] ??= globalThis;

// `window` is Node's global object here, but Node's `BroadcastChannel` is not a browser window
// capability. Letting it leak through makes browser module singletons (for example the global
// drag tracker) create an owned `MessagePort` at import time with no frontend lifecycle that can
// dispose it. Native and terminal frontends share one module graph, so the browser fallback's
// process-local event path is the truthful capability and leaves no native handle behind.
delete globals['BroadcastChannel'];

// Where the application was loaded from, which is what `location.href` meant in the webview:
// `dom.ts` tests it for `https:` to pick the preferred web schema for remote authorities, and
// `amdX.ts` resolves bundled asset paths against it. A `file:` URL is the truthful answer, and
// it puts both on the branch a terminal wants.
globals['location'] ??= { href: pathToFileURL(join(checkoutRoot() ?? cwd(), '/')).href };

// `window.addEventListener`, which `ContextKeyService` and `broadcast.ts` register on. Node's
// `globalThis` is not an `EventTarget`, so one is created and its methods bound here: no window
// event will ever fire in this process, and a real target keeps that a fact about the events
// rather than about the registration — a listener is held, and could be dispatched to.
globals['UIEvent'] ??= class TerminalUIEvent extends Event {
	readonly detail: number;
	readonly view: Window | null;
	constructor(type: string, init: UIEventInit = {}) {
		super(type, init);
		this.detail = init.detail ?? 0;
		this.view = init.view ?? null;
	}
};

const windowEvents = new EventTarget();
// Node's EventTarget does not remove capture listeners with the DOM boolean overload.
// Normalize both directions so upstream widget disposal releases the registered listener.
const windowListenerOptions = (options?: boolean | AddEventListenerOptions) => typeof options === 'boolean' ? { capture: options } : options;
globals['addEventListener'] ??= (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) =>
	windowEvents.addEventListener(type, listener, windowListenerOptions(options));
globals['removeEventListener'] ??= (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) =>
	windowEvents.removeEventListener(type, listener, windowListenerOptions(options));
globals['dispatchEvent'] ??= windowEvents.dispatchEvent.bind(windowEvents);

// `browser.ts` reads `navigator.userAgent` at load; Node has had `navigator` since 21, and
// `maxTouchPoints` and `clipboard` are absent there, which is the answer for a terminal.
globals['navigator'] ??= { userAgent: `Node.js/${process.versions.node}` };

// The terminal DOM, as `document` and as the constructors `instanceof` names. A `<style>` element
// it makes has no `sheet`, which is what a real one reports until it is in a rendered document,
// and `domStylesheets.ts` reads every rule through `style.sheet?.` and `?? []`. So a rule written
// at runtime — a decoration's colour — still goes nowhere, by the same path it would go nowhere
// in a page that never painted. The rules that *are* read come from the stylesheets on disk, which
// `tui/terminal/dom/style.ts` resolves.
installTerminalDocument();

// VS Code's workbench list commands attach a synthetic browser event to focus/selection changes.
// Node has `Event` but no `KeyboardEvent`; this is the transport shape those controllers read.
globals['KeyboardEvent'] ??= class TerminalKeyboardEvent extends Event {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly charCode: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly isComposing = false;

	constructor(type: string, init: KeyboardEventInit & { keyCode?: number; charCode?: number } = {}) {
		super(type, { bubbles: init.bubbles, cancelable: init.cancelable, composed: init.composed });
		this.key = init.key ?? '';
		this.code = init.code ?? '';
		this.keyCode = init.keyCode ?? 0;
		this.charCode = init.charCode ?? 0;
		this.ctrlKey = init.ctrlKey ?? false;
		this.shiftKey = init.shiftKey ?? false;
		this.altKey = init.altKey ?? false;
		this.metaKey = init.metaKey ?? false;
	}
};

// Pointer input uses the browser widget's own listeners and policy. This is only the browser
// event transport shape; TerminalElement supplies bubbling through the already-rendered DOM.
globals['MouseEvent'] ??= class TerminalMouseEvent extends Event {
	readonly button: number;
	readonly buttons: number;
	readonly detail: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly clientX: number;
	readonly clientY: number;
	readonly pageX: number;
	readonly pageY: number;
	readonly offsetX: number;
	readonly offsetY: number;
	readonly view: Window | null;

	constructor(type: string, init: MouseEventInit = {}) {
		super(type, { bubbles: init.bubbles, cancelable: init.cancelable, composed: init.composed });
		this.button = init.button ?? 0;
		this.buttons = init.buttons ?? 0;
		this.detail = init.detail ?? 0;
		this.ctrlKey = init.ctrlKey ?? false;
		this.shiftKey = init.shiftKey ?? false;
		this.altKey = init.altKey ?? false;
		this.metaKey = init.metaKey ?? false;
		this.clientX = init.clientX ?? 0;
		this.clientY = init.clientY ?? 0;
		this.pageX = this.clientX;
		this.pageY = this.clientY;
		this.offsetX = this.clientX;
		this.offsetY = this.clientY;
		this.view = init.view ?? null;
	}
};

// A terminal element has no CSS box. Browser widgets still ask the window for computed border,
// padding and margin values while laying out their own DOM renderer, so expose the browser API
// with the terminal's truthful zero-sized answer. The element tree remains the source for row
// content; this only lets the unmodified VS Code list/tree controller complete its layout pass.
globals['getComputedStyle'] ??= () => new Proxy({
	getPropertyValue: () => '',
	getPropertyPriority: () => '',
	item: () => '',
	length: 0
}, {
	get(target, property) {
		return property in target ? target[property as keyof typeof target] : '';
	}
});

// One animation frame is one paint. `dom.ts` schedules on it — `ResourceLabelWidget.onDidRender`
// goes through `scheduleAtNextAnimationFrame` — and Node has no counterpart, so the callback runs
// on the next turn instead. Unreferenced, so a scheduled frame cannot keep the process alive.
globals['requestAnimationFrame'] ??= (callback: (time: number) => void): NodeJS.Timeout => setTimeout(() => callback(Date.now()), 0).unref();
globals['cancelAnimationFrame'] ??= (handle: NodeJS.Timeout): void => clearTimeout(handle);

// A resize that can never happen: `tui/terminal/dom`'s elements have no size, so nothing they are observed
// for can change. `ToolBar` constructs one at load and every SCM row renderer builds a toolbar, so
// this is what stands between those renderers and running — and a callback that never fires is the
// truth about a tree with no layout, not a stand-in for one.
globals['ResizeObserver'] ??= class ResizeObserver {
	observe(): void { }
	unobserve(): void { }
	disconnect(): void { }
};

// `fetch` of a `file:` URL, which Node answers with `not implemented... yet...`. The vendored
// TextMate service and its worker both load `onig.wasm` through
// `fetch(resolveAmdNodeModulePath('vscode-oniguruma', 'release/onig.wasm'))`, which was an
// `http:` URL a webview served and is the asset on disk here. Only that arm is answered; every
// other request is Node's own `fetch`.
const nodeFetch = globalThis.fetch;
globals['fetch'] = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

	return url.startsWith('file:')
		? readFile(fileURLToPath(url)).then(contents => new Response(contents))
		: nodeFetch(input, init);
};

// `CSS.escape`, which is the only member of the `CSS` namespace anything in this tree reaches:
// `cssValue.ts`'s `className()` runs every class name through it, and the file icon theme's
// stylesheet is built out of about eight hundred of them. Node has no counterpart, so this is
// CSSOM's own algorithm — "serialize an identifier",
// https://drafts.csswg.org/cssom/#serialize-an-identifier — written out step for step.
globals['CSS'] ??= {
	escape(value: string): string {
		const input = String(value);
		let result = '';

		for (let at = 0; at < input.length; at++) {
			const code = input.charCodeAt(at);

			if (code === 0x0000) {
				result += '�';
			} else if ((code >= 0x0001 && code <= 0x001f) || code === 0x007f
				|| (at === 0 && code >= 0x0030 && code <= 0x0039)
				|| (at === 1 && code >= 0x0030 && code <= 0x0039 && input.charCodeAt(0) === 0x002d)) {
				result += `\\${code.toString(16)} `;
			} else if (at === 0 && code === 0x002d && input.length === 1) {
				result += `\\${input[at]}`;
			} else if (code >= 0x0080 || code === 0x002d || code === 0x005f
				|| (code >= 0x0030 && code <= 0x0039)
				|| (code >= 0x0041 && code <= 0x005a)
				|| (code >= 0x0061 && code <= 0x007a)) {
				result += input[at];
			} else {
				result += `\\${input[at]}`;
			}
		}

		return result;
	}
};

// `dom.ts` defines a `connection-observer` custom element at load. There are no elements to
// observe the connection of, so the registry answers that nothing is defined and takes the
// definition without keeping it.
globals['customElements'] ??= { get: () => undefined, define: () => { } };
