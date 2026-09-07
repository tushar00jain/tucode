import '../../src/vs/base/node/browserGlobals.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Event } from '../../src/vs/base/common/event.js';
import { lineRenderRecords } from '../../src/render/domRecords.js';
import { bindPaneFocusContext, bindPaneVisibilityContext, PaneChromeProjectionGateway, paneChromeSnapshot } from '../../src/workbench/paneChromeProjection.js';
import { IConfigurationService } from '../../src/vs/platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../src/vs/platform/contextkey/browser/contextKeyService.js';
import { InputFocusedContext } from '../../src/vs/platform/contextkey/common/contextkeys.js';
import { ContextKeyExpr } from '../../src/vs/platform/contextkey/common/contextkey.js';
import { ExplorerResourceReadonlyContext, ExplorerRootContext, FilesExplorerFocusCondition,
	FilesExplorerFocusedContext, FoldersViewVisibleContext } from '../../src/vs/workbench/contrib/files/common/files.js';

const value = (generation: number, text = '') => paneChromeSnapshot({
	generation, identity: 'search', title: 'Search', header: [lineRenderRecords([{ text }])],
	textInputValue: text, canEdit: true, editing: true, filtering: false, expanded: true, focused: false
});

describe('pane chrome projection', () => {
	it('projects Explorer focus ownership into upstream cut eligibility', () => {
		const configuration = { onDidChangeConfiguration: Event.None, getValue: () => undefined };
		const contexts = new ContextKeyService(configuration as IConfigurationService);
		InputFocusedContext.bindTo(contexts).set(false);
		ExplorerRootContext.bindTo(contexts).set(false);
		ExplorerResourceReadonlyContext.bindTo(contexts).set(false);
		const explorerFocused = FilesExplorerFocusedContext.bindTo(contexts);
		const explorerVisible = FoldersViewVisibleContext.bindTo(contexts);
		const gateway = new PaneChromeProjectionGateway(value(1), () => true);
		const focusBinding = bindPaneFocusContext(gateway, explorerFocused);
		const visibilityBinding = bindPaneVisibilityContext(gateway, explorerVisible);
		const cutEligible = ContextKeyExpr.and(FilesExplorerFocusCondition,
			ExplorerRootContext.toNegated(), ExplorerResourceReadonlyContext.toNegated());
		try {
			assert.equal(contexts.contextMatchesRules(cutEligible), false);
			assert.equal(gateway.dispatch({ generation: gateway.snapshot.generation, kind: 'focus', focused: true }), true);
			assert.equal(contexts.contextMatchesRules(cutEligible), true);
			gateway.publish({ ...gateway.snapshot, expanded: false });
			assert.equal(contexts.contextMatchesRules(cutEligible), false);
			gateway.publish({ ...gateway.snapshot, expanded: true });
			assert.equal(contexts.contextMatchesRules(cutEligible), true);
			assert.equal(gateway.dispatch({ generation: gateway.snapshot.generation, kind: 'focus', focused: false }), true);
			assert.equal(contexts.contextMatchesRules(cutEligible), false);
		} finally {
			visibilityBinding.dispose(); focusBinding.dispose(); gateway.dispose(); contexts.dispose();
		}
	});

	it('freezes records, rejects stale input, and emits normalized input once', () => {
		const seen: string[] = [];
		const gateway = new PaneChromeProjectionGateway(value(1, 'a'), event => { seen.push(event.kind); return true; });
		assert.equal(Object.isFrozen(gateway.snapshot.header[0].runs), true);
		assert.equal(gateway.dispatch({ generation: 0, kind: 'set-text', value: 'stale' }), false);
		assert.equal(gateway.dispatch({ generation: 1, kind: 'set-text', value: 'alpha' }), true);
		assert.equal(gateway.dispatch({ generation: 1, kind: 'complete-filter', delta: 1 }), true);
		assert.equal(gateway.dispatch({ generation: 1, kind: 'scroll-horizontal', direction: -1 }), true);
		assert.deepEqual(seen, ['set-text', 'complete-filter', 'scroll-horizontal']);
		assert.equal(gateway.dispatch({ generation: 1, kind: 'focus', focused: true }), true);
		assert.equal(gateway.snapshot.focused, true);
		assert.equal(gateway.dispatch({ generation: gateway.snapshot.generation, kind: 'focus', focused: true }), true,
			'same focus must not create another generation');
		gateway.dispose();
	});

	it('keeps repeated replacements bounded without retaining history', () => {
		const gateway = new PaneChromeProjectionGateway(value(1), () => true);
		for (let index = 0; index < 20; index++) {
			gateway.publish({ identity: 'search', title: 'Search', header: [lineRenderRecords([{ text: String(index) }])],
				textInputValue: String(index), canEdit: true, editing: true, filtering: false, expanded: true });
		}
		assert.equal(gateway.snapshot.generation, 21);
		assert.equal(gateway.snapshot.header[0].runs[0].text, '19');
		gateway.dispose();
	});
});
