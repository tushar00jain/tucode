import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INavigatorSectionRecord, NavigatorChromeGateway } from '../../src/workbench/navigatorChromeProjection.js';

const containers = Object.freeze([
	Object.freeze({ id: 'explorer', title: 'Explorer', icon: undefined }),
	Object.freeze({ id: 'search', title: 'Search', icon: undefined })
]);
const sections = (reverse = false): readonly INavigatorSectionRecord[] => Object.freeze((reverse ? [
	{ id: 'scm', title: 'Source Control', order: 1, expanded: false },
	{ id: 'explorer.files', title: 'Files', order: 0, expanded: true }
] : [
	{ id: 'explorer.files', title: 'Files', order: 0, expanded: true },
	{ id: 'scm', title: 'Source Control', order: 1, expanded: false }
]).map(record => Object.freeze(record)));

describe('navigator chrome projection', () => {
	it('owns active/focus identity, rejects stale and same-selected input, and orders sections', () => {
		const trace: string[] = [];
		let gateway!: NavigatorChromeGateway;
		gateway = new NavigatorChromeGateway(event => {
			if (event.kind === 'select-container' && event.id === gateway.snapshot.activeContainerId) { return false; }
			trace.push(`${event.kind}:${event.id}`);
			gateway.publish(event.kind === 'select-container' ? { activeContainerId: event.id } : { focusedSectionId: event.id });
			return true;
		});
		gateway.publish({ containers, activeContainerId: 'explorer', sections: sections(true) });
		const generation = gateway.snapshot.generation;
		assert.deepEqual(gateway.snapshot.sections.map(section => section.id), ['explorer.files', 'scm']);
		assert.equal(gateway.dispatch({ generation, kind: 'select-container', id: 'explorer' }), false);
		assert.equal(gateway.dispatch({ generation: generation - 1, kind: 'select-container', id: 'search' }), false);
		assert.equal(gateway.dispatch({ generation, kind: 'focus-section', id: 'scm' }), true);
		assert.equal(gateway.snapshot.focusedSectionId, 'scm');
		assert.deepEqual(trace, ['focus-section:scm']);
		gateway.dispose();
	});

	it('rejects duplicate/orphan records and keeps repeated publication state bounded', () => {
		const failed = new NavigatorChromeGateway(() => { throw new Error('switch failed'); });
		failed.publish({ containers, activeContainerId: 'explorer', sections: sections() });
		const before = failed.snapshot;
		assert.throws(() => failed.dispatch({ generation: before.generation, kind: 'select-container', id: 'search' }), /switch failed/);
		assert.equal(failed.snapshot, before);
		assert.throws(() => failed.publish({ focusedSectionId: 'missing' }), /orphan/);
		assert.throws(() => failed.publish({ sections: [sections()[0], sections()[0]] }), /duplicate/);
		failed.dispose();

		const gateway = new NavigatorChromeGateway(() => true);
		gateway.publish({ containers, activeContainerId: 'explorer', sections: sections() });
		const initialGeneration = gateway.snapshot.generation;
		for (let index = 0; index < 20; index++) {
			gateway.publish({ sections: index & 1 ? sections(true) : sections(), activeContainerId: index & 1 ? 'search' : 'explorer' });
		}
		assert.equal(gateway.snapshot.generation, initialGeneration + 20);
		assert.equal(gateway.snapshot.sections.length, 2);
		gateway.dispose();
	});

	it('replaces section membership, order, collapse and focus without retaining presentation indexes', () => {
		const gateway = new NavigatorChromeGateway(() => true);
		gateway.publish({ containers, activeContainerId: 'explorer', sections: sections(), focusedSectionId: 'explorer.files' });
		const removedGeneration = gateway.snapshot.generation;
		gateway.publish({ sections: Object.freeze([
			Object.freeze({ id: 'search.results', title: 'Results', order: 1, expanded: true }),
			Object.freeze({ id: 'explorer.files', title: 'Files', order: 2, expanded: false })
		]), focusedSectionId: 'search.results' });
		assert.deepEqual(gateway.snapshot.sections.map(section => [section.id, section.expanded]), [
			['search.results', true], ['explorer.files', false]
		]);
		assert.equal(gateway.snapshot.focusedSectionId, 'search.results');
		assert.equal(gateway.dispatch({ generation: removedGeneration, kind: 'focus-section', id: 'explorer.files' }), false);
		assert.equal(gateway.dispatch({ generation: gateway.snapshot.generation, kind: 'focus-section', id: 'scm' }), false);
		gateway.publish({ sections: Object.freeze([
			Object.freeze({ id: 'explorer.files', title: 'Files', order: 0, expanded: true })
		]), focusedSectionId: undefined });
		assert.equal(gateway.snapshot.focusedSectionId, undefined);
		gateway.dispose();
	});
});
