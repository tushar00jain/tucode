import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DiffEditorProjectionGateway, ITextEditorProjectionSnapshot, TextEditorInputEvent, TextEditorProjectionGateway, diffEditorSnapshot, textEditorSnapshot
} from '../../src/editor/textProjection.js';

type UnaddressedInput = TextEditorInputEvent extends infer E
	? E extends TextEditorInputEvent ? Omit<E, 'generation' | 'documentId'> : never
	: never;

function snapshot(generation = 1, content = 'one\ntwo', overrides: Partial<ITextEditorProjectionSnapshot> = {}): ITextEditorProjectionSnapshot {
	const lines = content.split('\n');
		return textEditorSnapshot({
		kind: 'text',
		generation, documentId: 'file:///workspace/a.ts', resource: 'file:///workspace/a.ts', version: generation,
		languageId: 'typescript', readonly: false, dirty: generation > 1, focused: true, mode: 'insert',
		vim: { pending: '', prompt: undefined, message: undefined },
		find: { visible: false, query: '', matchCount: 0, currentMatch: 0 },
		primaryCursor: { lineNumber: 1, column: 1 }, primaryCursorView: { lineNumber: 1, column: 1 }, markedRange: undefined,
		selections: [{ anchor: { lineNumber: 1, column: 1 }, active: { lineNumber: 1, column: 1 }, offsets: { location: 0, length: 0 }, primary: true }],
		rows: lines.map((line, index) => ({
			id: `file:///workspace/a.ts#${index + 1}`, viewLineNumber: index + 1, modelLineNumber: index + 1,
			lineNumber: index + 1, fold: 'none', content: line,
			runs: [{ start: 0, length: line.length, text: line, style: { foreground: '#d4d4d4', bold: index === 0 } }],
			mapping: [{ viewStart: 0, viewEnd: line.length, documentStart: index ? lines[0].length + 1 : 0,
				documentEnd: (index ? lines[0].length + 1 : 0) + line.length, kind: 'linear', affinity: 'both' }],
			carets: index ? [] : [{ column: 0, primary: true }], selections: [], searchMatches: []
		})),
		geometry: { metricsId: 'terminal-cell-v1', width: 80, wrap: true, firstVisibleRow: 0, visibleRowCount: 24, scrollColumn: 0, totalRows: lines.length, modelLineCount: lines.length },
		...overrides
	});
}

describe('neutral text editor projection protocol', () => {
	it('accepts only immutable plain complete render records', () => {
		const value = snapshot();
		assert.equal(Object.isFrozen(value), true);
		assert.equal(Object.isFrozen(value.rows), true);
		assert.equal(Object.isFrozen(value.rows[0].runs[0].style), true);
		assert.equal(Object.isFrozen(value.rows[0].searchMatches), true);
		assert.equal(Object.isFrozen(value.vim), true);
		assert.equal('content' in value, false, 'viewport projection carried the complete model');
		assert.doesNotThrow(() => structuredClone(value));
		assert.throws(() => snapshot(1, 'x', { primaryCursor: new (class Position { lineNumber = 1; column = 1; })() }), /live object prototype/);
		assert.throws(() => snapshot(1, 'x', { rows: [{ ...snapshot(1, 'x').rows[0], runs: [{ start: 1, length: 1, text: 'x', style: {} }] }] }), /non-contiguous/);
		assert.throws(() => snapshot(1, 'x', { rows: [snapshot(1, 'x').rows[0], snapshot(1, 'x').rows[0]] }), /duplicate/);
		const combining = snapshot(1, 'e\u0301');
		assert.throws(() => snapshot(1, 'e\u0301', { rows: [{ ...combining.rows[0], mapping: [
			{ viewStart: 0, viewEnd: 1, documentStart: 0, documentEnd: 1, kind: 'linear', affinity: 'both' },
			{ viewStart: 1, viewEnd: 2, documentStart: 1, documentEnd: 2, kind: 'linear', affinity: 'both' }
		] }] }), /splits grapheme/);
	});

	it('rejects stale generations, wrong documents and orphan row input', () => {
		const inputs: TextEditorInputEvent[] = [];
		const gateway = new TextEditorProjectionGateway(snapshot(), event => { inputs.push(event); });
		assert.equal(gateway.dispatch({ generation: 1, documentId: 'file:///workspace/a.ts', kind: 'text', text: 'x' }), true);
		assert.equal(gateway.publish(snapshot(2, 'xone\ntwo')), true);
		assert.equal(gateway.publish(snapshot(1, 'stale')), false);
		assert.equal(gateway.dispatch({ generation: 1, documentId: 'file:///workspace/a.ts', kind: 'undo' }), false);
		assert.equal(gateway.dispatch({ generation: 2, documentId: 'file:///workspace/b.ts', kind: 'redo' }), false);
		assert.equal(gateway.dispatch({ generation: 2, documentId: 'file:///workspace/a.ts', kind: 'pointer', action: 'place-caret', rowId: 'missing', column: 0, extend: false }), false);
		assert.equal(inputs.length, 1);
		gateway.dispose();
	});

	it('gives the terminal an ordered edit/composition/Vim/focus trace', () => {
		const run = () => {
			const trace: string[] = [];
			let generation = 1;
			let content = 'one\ntwo';
			let gateway!: TextEditorProjectionGateway;
			gateway = new TextEditorProjectionGateway(snapshot(), event => {
				trace.push(`input:${event.kind}${event.kind === 'composition' ? `:${event.phase}` : ''}`);
				if (event.kind === 'text') { content += event.text; }
				if (event.kind === 'undo') { content = 'one\ntwo'; }
				gateway.publish(snapshot(++generation, content, event.kind === 'focus' ? { focused: event.focused } : {}));
			});
			gateway.onDidSnapshot(value => trace.push(`snapshot:${value.generation}:${value.rows.map(row => row.content).join('\n')}:${value.focused}`));
			const dispatch = (event: UnaddressedInput) => gateway.dispatch({
				...event, generation: gateway.snapshot.generation, documentId: gateway.snapshot.documentId
			} as TextEditorInputEvent);
			dispatch({ kind: 'text', text: '!' });
			dispatch({ kind: 'move', action: 'left', extend: false });
			dispatch({ kind: 'move', action: 'right', extend: true });
			dispatch({ kind: 'composition', phase: 'update', text: 'e\u0301', selected: { location: 2, length: 0 } });
			dispatch({ kind: 'composition', phase: 'commit', text: '\u00e9' });
			dispatch({ kind: 'key', key: { name: 'char', char: 'u' } });
			dispatch({ kind: 'undo' });
			dispatch({ kind: 'redo' });
			dispatch({ kind: 'save' });
			dispatch({ kind: 'focus', focused: false });
			gateway.dispose();
			return trace;
		};
		assert.deepEqual(run(), run());
	});

	it('publishes each replacement once and detaches its observer', () => {
		const gateway = new TextEditorProjectionGateway(snapshot(), () => {});
		let observed = 0;
		const observer = gateway.onDidSnapshot(() => { observed++; });
		for (let generation = 2; generation <= 17; generation++) {
			assert.equal(gateway.publish(snapshot(generation, generation % 2 ? 'one\ntwo' : 'one\nthree')), true);
		}
		assert.equal(observed, 16);
		assert.equal(gateway.snapshot.generation, 17);
		observer.dispose();
		assert.equal(gateway.publish(snapshot(18, 'detached')), true);
		assert.equal(observed, 16);
		gateway.dispose();
	});

	it('keeps long wrapped/composed mapping proportional to layout spans', () => {
		for (const length of [64, 4096]) {
			const content = 'a'.repeat(length);
			const value = snapshot(1, content);
			assert.equal(value.rows[0].mapping.length, 1);
			assert.equal(value.rows[0].runs.length, 1);
			assert.equal(value.rows[0].mapping[0].documentEnd, content.length);
		}
	});

	it('projects side-qualified diff records and rejects stale replacement', () => {
		const value = diffEditorSnapshot({ kind: 'diff', generation: 1, documentId: 'diff:a:b', focused: false,
			original: { documentId: 'a', resource: 'file:///a', version: 1, languageId: 'text' },
			modified: { documentId: 'b', resource: 'file:///b', version: 1, languageId: 'text' },
			rows: [{ id: 'a#1', sourceDocumentId: 'a', side: 'original', marker: '-', viewLineNumber: 1, modelLineNumber: 1,
				lineNumber: 1, fold: 'none', content: 'old', runs: [{ start: 0, length: 3, text: 'old', style: {} }],
				mapping: [{ viewStart: 0, viewEnd: 3, documentStart: 0, documentEnd: 3, kind: 'linear', affinity: 'both' }],
				carets: [], selections: [], searchMatches: [], decorations: [{ start: 0, end: 3, kind: 'line' }] }],
			geometry: { metricsId: 'cell', width: 80, wrap: false, firstVisibleRow: 0, visibleRowCount: 20, scrollColumn: 0, totalRows: 1, modelLineCount: 1 } });
		const gateway = new DiffEditorProjectionGateway(value, () => {});
		assert.equal(gateway.snapshot.rows[0].sourceDocumentId, 'a');
		assert.equal(Object.isFrozen(gateway.snapshot.rows[0].decorations), true);
		assert.equal(gateway.publish({ ...value, generation: 2 }), true);
		assert.equal(gateway.publish(value), false);
		gateway.dispose();
	});
});
