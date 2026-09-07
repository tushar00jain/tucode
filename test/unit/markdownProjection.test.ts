import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Tokens } from '../../src/vs/base/common/marked/marked.js';
import { Emitter } from '../../src/vs/base/common/event.js';
import { IMarkdownBackend, IResolvedMarkdownDocument, MarkdownController, markdownTokens, markdownSnapshot } from '../../src/editor/markdownProjection.js';

class Document implements IResolvedMarkdownDocument {
	private readonly changed = new Emitter<Readonly<{ version: number; content: string }>>(); readonly onDidChange = this.changed.event;
	disposed = false; constructor(public version: number, public content: string) { }
	set(content: string): void { this.content = content; this.changed.fire(Object.freeze({ version: ++this.version, content })); }
	dispose(): void { this.disposed = true; this.changed.dispose(); }
}

describe('neutral Markdown projection', () => {
	it('extracts immutable semantic records without a DOM or frontend object', () => {
		const result = markdownTokens('file:///work/README.md', '# Head\n\n**bold** *em* ~~gone~~ [docs](guide.md) ![logo](img.png) `x`\n\n> quote\n\n1. one\n\n```ts\nconst x = 1\n```');
		assert.deepEqual(result.tokens.filter(token => token.type !== 'space').map(token => token.type), ['heading', 'paragraph', 'blockquote', 'list', 'code']);
		assert.equal(result.links[0].href, 'file:///work/guide.md');
		assert.equal(result.text, 'Head\nbold em gone docs logo x\nquote\none\nconst x = 1');
		const inline = (result.tokens.find(token => token.type === 'paragraph') as Tokens.Paragraph).tokens;
		assert.equal((inline.find(token => token.type === 'image') as Tokens.Image).href, 'img.png');
		assert.ok(inline.some(token => token.type === 'strong'));
		assert.ok(inline.some(token => token.type === 'codespan'));
		assert.ok(Object.isFrozen(result.tokens) && Object.isFrozen(inline) && Object.isFrozen(result.links[0]));
		assert.throws(() => markdownSnapshot({ kind: 'markdown', generation: 1, documentId: 'opaque', resource: 'file:///opaque.md', version: 1, status: 'ready', focused: false, selection: { location: 0, length: 0 }, scroll: { firstVisibleRow: 0, visibleRowCount: 1 }, tokens: result.tokens, links: [], accessibility: new (class { identity = 'opaque'; label = 'Markdown'; value = ''; })() }), /live object prototype/);
	});

	it('proves open, render, normalized link, scroll, selection, focus and live file replacement', async () => {
		const document = new Document(4, '[go](next.md)'); const opened: string[] = [];
		const backend: IMarkdownBackend = { async resolve() { return document; }, async open(resource) { opened.push(resource); return true; } };
		const controller = new MarkdownController('readme', 'file:///work/README.md', backend); await controller.open();
		const tokens = controller.projection.snapshot.tokens;
		let snapshot = controller.projection.snapshot; assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.version, 4);
		assert.equal(controller.projection.dispatch({ kind: 'focus', focused: true, generation: snapshot.generation, documentId: 'readme' }), true);
		snapshot = controller.projection.snapshot; assert.equal(controller.projection.dispatch({ kind: 'select', location: 1, length: 2, generation: snapshot.generation, documentId: 'readme' }), true);
		snapshot = controller.projection.snapshot; assert.equal(controller.projection.dispatch({ kind: 'viewport', firstVisibleRow: 3, visibleRowCount: 8, generation: snapshot.generation, documentId: 'readme' }), true);
		snapshot = controller.projection.snapshot; assert.equal(controller.projection.dispatch({ kind: 'open-link', linkId: snapshot.links[0].id, generation: snapshot.generation, documentId: 'readme' }), true); await controller.whenSettled();
		assert.deepEqual(opened, ['file:///work/next.md']); assert.equal(controller.projection.snapshot.focused, true); assert.deepEqual(controller.projection.snapshot.selection, { location: 1, length: 2 }); assert.equal(controller.projection.snapshot.scroll.firstVisibleRow, 3);
		assert.equal(controller.projection.snapshot.tokens, tokens, 'focus and viewport reuse the parsed tree');
		document.set('# Head\n\n**bold *nested*** [docs](guide.md) `a & b` ![logo](image.png)\n\n```ts\nconst value = 1;\n```');
		assert.equal(controller.projection.snapshot.accessibility.value, 'Head\nbold nested docs a & b logo\nconst value = 1;');
		const staleGeneration = controller.projection.snapshot.generation; document.set('# replacement'); assert.equal(controller.projection.snapshot.tokens[0].type, 'heading');
		assert.equal(controller.projection.dispatch({ kind: 'focus', focused: false, generation: staleGeneration, documentId: 'readme' }), false);
		controller.dispose(); assert.equal(document.disposed, true);
	});

	it('cancels stale resolves, publishes failure, and keeps repeated observer replacement scalar', async () => {
		const pending = new Map<string, { resolve(value: Document): void; reject(error: Error): void }>();
		const backend: IMarkdownBackend = { resolve(resource) { return new Promise((resolve, reject) => pending.set(resource, { resolve, reject })); }, async open() { return true; } };
		const controller = new MarkdownController('replace', 'file:///a.md', backend); const first = controller.open(); const second = controller.replace('file:///b.md');
		const b = new Document(1, '# b'); pending.get('file:///b.md')!.resolve(b); await second; const a = new Document(1, '# stale'); pending.get('file:///a.md')!.resolve(a); await first;
		assert.equal(a.disposed, true); assert.equal(controller.projection.snapshot.resource, 'file:///b.md');
		for (let i = 0; i < 20; i++) { b.set(`value ${i}`); }
		assert.deepEqual(controller.diagnostics, { documents: 1, observers: 1, pending: 0 }); assert.equal(controller.projection.snapshot.version, 21);
		const failed = controller.replace('file:///failure.md'); pending.get('file:///failure.md')!.reject(new Error('gone')); await failed;
		assert.equal(controller.projection.snapshot.status, 'error'); assert.equal(controller.projection.snapshot.error, 'gone'); assert.equal(b.disposed, true); assert.deepEqual(controller.diagnostics, { documents: 0, observers: 0, pending: 0 });
		controller.dispose();
	});
});
