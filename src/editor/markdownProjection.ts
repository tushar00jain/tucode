/*---------------------------------------------------------------------------------------------
 * Shared Markdown document lifecycle and immutable vendored marked tokens. Terminal layout owns
 * rows and styling; the text-file service remains authoritative for source content.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../vs/base/common/lifecycle.js';
import { dirname, resolvePath } from '../vs/base/common/resources.js';
import { URI } from '../vs/base/common/uri.js';
import { Token, Tokens, TokensList, marked } from '../vs/base/common/marked/marked.js';

export interface IMarkdownLink { readonly id: string; readonly href: string; readonly label: string; }
export interface IMarkdownProjectionSnapshot {
	readonly kind: 'markdown'; readonly generation: number; readonly documentId: string; readonly resource: string;
	readonly version: number; readonly status: 'loading' | 'ready' | 'error'; readonly error?: string;
	readonly focused: boolean; readonly selection: Readonly<{ readonly location: number; readonly length: number }>;
	readonly scroll: Readonly<{ readonly firstVisibleRow: number; readonly visibleRowCount: number }>;
	readonly tokens: Readonly<TokensList>; readonly links: readonly Readonly<IMarkdownLink>[];
	readonly accessibility: Readonly<{ readonly identity: string; readonly label: string; readonly value: string }>;
}
interface IMarkdownAddress { readonly generation: number; readonly documentId: string; }
export type MarkdownInputEvent = IMarkdownAddress & (
	| { readonly kind: 'focus'; readonly focused: boolean }
	| { readonly kind: 'select'; readonly location: number; readonly length: number }
	| { readonly kind: 'viewport'; readonly firstVisibleRow: number; readonly visibleRowCount: number }
	| { readonly kind: 'open-link'; readonly linkId: string }
);
export interface IMarkdownProjectionSource { readonly snapshot: IMarkdownProjectionSnapshot; readonly onDidSnapshot: Event<IMarkdownProjectionSnapshot>; readonly onDidInput: Event<MarkdownInputEvent>; dispatch(event: MarkdownInputEvent): boolean; }
export interface IResolvedMarkdownDocument extends IDisposable { readonly version: number; readonly content: string; readonly onDidChange: Event<Readonly<{ readonly version: number; readonly content: string }>>; }
export interface IMarkdownBackend { resolve(resource: string): Promise<IResolvedMarkdownDocument>; open(resource: string): Promise<boolean>; }

/** Preserve the parser's complete structure, including nested lists and GFM tables. */
export function markdownTokens(resource: string, content: string): Pick<IMarkdownProjectionSnapshot, 'tokens' | 'links'> & { readonly text: string } {
	const tokens = marked.lexer(content);
	const links = new Map<string, IMarkdownLink>();
	marked.walkTokens(tokens, token => {
		if (token.type === 'link') {
			const link = token as Tokens.Link;
			const href = /^[a-z][a-z\d+.-]*:/i.test(link.href) ? link.href : resolvePath(dirname(URI.parse(resource)), link.href).toString();
			links.set(link.href, { id: link.href, href, label: link.text });
		}
	});
	return freezePlain({ tokens, links: [...links.values()], text: readableText(tokens) });
}

const ENTITIES = new Map([['&quot;', '"'], ['&nbsp;', ' '], ['&amp;', '&'], ['&#39;', "'"], ['&lt;', '<'], ['&gt;', '>']]);
const unescape = (text: string) => text.replace(/&(#\d+|[a-zA-Z]+);/g, match => ENTITIES.get(match) ?? match);

/** Accessibility needs readable text, not a second document/block representation. */
function readableText(tokens: readonly Token[], inline = false): string {
	return tokens.filter(token => token.type !== 'space' && token.type !== 'def').map(token => {
		switch (token.type) {
			case 'blockquote': return readableText((token as Tokens.Blockquote).tokens);
			case 'list': return (token as Tokens.List).items.map(item => readableText(item.tokens)).join('\n');
			case 'code': return (token as Tokens.Code).text.replace(/\n$/, '');
			case 'hr': return '─'.repeat(32);
			case 'br': return '\n';
			case 'image': return unescape((token as Tokens.Image).text) || (token as Tokens.Image).href;
			case 'html': return inline ? (token as Tokens.Tag).text : token.raw.trim();
			default: {
				const value = token as Tokens.Text;
				return value.tokens ? readableText(value.tokens, true) : unescape(value.text ?? token.raw ?? '');
			}
		}
	}).join(inline ? '' : '\n');
}

export function markdownSnapshot(value: IMarkdownProjectionSnapshot): IMarkdownProjectionSnapshot {
	if (!value.documentId || !value.resource || !Number.isSafeInteger(value.generation) || value.generation < 1) { throw new Error('invalid markdown projection address'); }
	if (value.selection.location < 0 || value.selection.length < 0 || value.scroll.firstVisibleRow < 0 || value.scroll.visibleRowCount < 1) { throw new Error('invalid markdown selection or viewport'); }
	return freezePlain({ ...value, selection: { ...value.selection }, scroll: { ...value.scroll }, accessibility: value.accessibility });
}

/** Freeze each parser tree once; later viewport/focus snapshots reuse it. */
const frozenData = new WeakSet<object>();
function freezePlain<T>(value: T, ancestors = new Set<object>()): T {
	if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return value; }
	if (typeof value !== 'object') { throw new Error('snapshot is not immutable plain data'); }
	if (frozenData.has(value)) { return value; }
	if (ancestors.has(value)) { throw new Error('snapshot has a cyclic object'); }
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) { throw new Error('snapshot has a live object prototype'); }
	ancestors.add(value);
	for (const child of Object.values(value)) { freezePlain(child, ancestors); }
	ancestors.delete(value); Object.freeze(value); frozenData.add(value);
	return value;
}

export class MarkdownController extends Disposable {
	readonly projection: MarkdownProjectionGateway; private generation = 1; private epoch = 0; private version = 0; private resource: string; private document?: IResolvedMarkdownDocument;
	private focused = false; private selection = { location: 0, length: 0 }; private scroll = { firstVisibleRow: 0, visibleRowCount: 40 }; private status: IMarkdownProjectionSnapshot['status'] = 'loading'; private error?: string; private content = '';
	private parsedContent: string | undefined; private parsedResource: string | undefined; private parsed = markdownTokens('', '');
	private pending = new Set<Promise<unknown>>(); private readonly currentDocument = this._register(new MutableDisposable<DisposableStore>());
	constructor(readonly documentId: string, resource: string, private readonly backend: IMarkdownBackend) { super(); this.resource = resource; this.projection = this._register(new MarkdownProjectionGateway(this.makeSnapshot(), event => this.handle(event))); }
	get diagnostics(): Readonly<{ readonly documents: number; readonly observers: number; readonly pending: number }> { return Object.freeze({ documents: this.document ? 1 : 0, observers: this.document ? 1 : 0, pending: this.pending.size }); }
	open(): Promise<void> { return this.replace(this.resource); }
	replace(resource: string): Promise<void> { const epoch = ++this.epoch; this.currentDocument.clear(); this.document = undefined; this.resource = resource; this.status = 'loading'; this.error = undefined; this.content = ''; this.version = 0; this.publish();
		const work = this.backend.resolve(resource).then(document => { if (epoch !== this.epoch || this._store.isDisposed) { document.dispose(); return; } const store = new DisposableStore(); store.add(document); this.document = document; this.version = document.version; this.content = document.content; this.status = 'ready'; store.add(document.onDidChange(change => { if (this.document !== document) { return; } this.version = change.version; this.content = change.content; this.publish(); })); this.currentDocument.value = store; this.publish(); }, error => { if (epoch !== this.epoch || this._store.isDisposed) { return; } this.status = 'error'; this.error = error instanceof Error ? error.message : String(error); this.publish(); }); this.track(work); return work; }
	get idle(): boolean { return this.pending.size === 0; } async whenSettled(): Promise<void> { while (this.pending.size) { await Promise.allSettled([...this.pending]); } }
	private track(work: Promise<unknown>): void { this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); }
	private handle(event: MarkdownInputEvent): void { switch (event.kind) { case 'focus': if (this.focused === event.focused) { return; } this.focused = event.focused; break; case 'select': if (this.selection.location === event.location && this.selection.length === event.length) { return; } this.selection = { location: event.location, length: event.length }; break; case 'viewport': if (this.scroll.firstVisibleRow === event.firstVisibleRow && this.scroll.visibleRowCount === event.visibleRowCount) { return; } this.scroll = { firstVisibleRow: event.firstVisibleRow, visibleRowCount: event.visibleRowCount }; break; case 'open-link': { const link = this.projection.snapshot.links.find(value => value.id === event.linkId); if (link) { this.track(this.backend.open(link.href)); } return; } } this.publish(); }
	private publish(): void { this.projection.publish(this.makeSnapshot()); }
	private makeSnapshot(): IMarkdownProjectionSnapshot {
		const content = this.status === 'ready' ? this.content : '';
		if (this.parsedContent !== content || this.parsedResource !== this.resource) { this.parsedContent = content; this.parsedResource = this.resource; this.parsed = markdownTokens(this.resource, content); }
		return markdownSnapshot({ kind: 'markdown', generation: this.generation++, documentId: this.documentId, resource: this.resource,
			version: this.version, status: this.status, error: this.error, focused: this.focused, selection: this.selection, scroll: this.scroll,
			tokens: this.parsed.tokens, links: this.parsed.links,
			accessibility: { identity: `${this.documentId}:content`, label: 'Markdown Preview', value: this.parsed.text } });
	}
	override dispose(): void { this.epoch++; this.document = undefined; super.dispose(); }
}

export class MarkdownProjectionGateway extends Disposable implements IMarkdownProjectionSource {
	private current: IMarkdownProjectionSnapshot; private readonly changed = this._register(new Emitter<IMarkdownProjectionSnapshot>()); readonly onDidSnapshot = this.changed.event; private readonly inputs = this._register(new Emitter<MarkdownInputEvent>()); readonly onDidInput = this.inputs.event;
	constructor(initial: IMarkdownProjectionSnapshot, private readonly handle: (event: MarkdownInputEvent) => void | Promise<void>) { super(); this.current = markdownSnapshot(initial); }
	get snapshot(): IMarkdownProjectionSnapshot { return this.current; }
	publish(value: IMarkdownProjectionSnapshot): boolean { const next = markdownSnapshot(value); if (next.documentId !== this.current.documentId || next.generation <= this.current.generation) { return false; } this.current = next; this.changed.fire(next); return true; }
	dispatch(event: MarkdownInputEvent): boolean { if (event.documentId !== this.current.documentId || event.generation !== this.current.generation || event.kind === 'open-link' && !this.current.links.some(link => link.id === event.linkId)) { return false; } const frozen = Object.freeze({ ...event }); this.inputs.fire(frozen); void this.handle(frozen); return true; }
}
