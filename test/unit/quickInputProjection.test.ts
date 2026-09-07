import assert from 'node:assert/strict';
import test from 'node:test';
import Severity from '../../src/vs/base/common/severity.js';
import { Emitter, Event } from '../../src/vs/base/common/event.js';
import { QuickInputHideReason } from '../../src/vs/platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../src/vs/platform/quickinput/common/quickInput.js';
import {
	IQuickInputProjectionSource, QuickInputProducer, QuickInputProjectionController
} from '../../src/editor/nativeQuickInputProjection.js';

const producers: readonly QuickInputProducer[] = ['command-palette', 'quick-open', 'pick', 'input-box', 'live-picker'];

function fixture(producer: QuickInputProducer) {
	const changed = new Emitter<void>();
	const hidden = new Emitter<{ reason: QuickInputHideReason }>();
	const button = { label: 'Back', tooltip: 'Back' };
	const itemButton = { label: 'Remove' };
	const first: IQuickPickItem = { label: 'README', description: 'workspace', buttons: [itemButton] };
	const second: IQuickPickItem = { label: 'LICENSE', highlights: { label: [{ start: 0, end: 3 }] } };
	const rows = [{ item: first }, { item: second }];
	let focus = 0;
	let selected = [first];
	const actions: string[] = [];
	const source: IQuickInputProjectionSource = {
		producer, title: 'Open', description: 'Files', step: 1, totalSteps: 2, value: '', valueSelection: [0, 0],
		placeholder: 'Type', prompt: 'Choose', validationMessage: undefined, severity: Severity.Info,
		enabled: true, password: false, busy: false, hideInput: false, hideList: producer === 'input-box',
		ignoreFocusOut: false, canSelectMany: true, keepScrollPosition: true, projectionScrollTop: 0, buttons: [button],
		get rowCount() { return rows.length; }, get projectionFocus() { return focus; }, get selectedItems() { return selected; },
		onDidChangeInput: Event.None,
		acceptInput(value, selection) { this.value = value; this.valueSelection = selection; },
		onDidChange: changed.event, onDidHide: hidden.event, row: index => rows[index],
		navigate: next => { focus = next ? 1 : 0; actions.push(`navigate:${next}`); changed.fire(); },
		setProjectionFocus: index => { focus = index; actions.push(`focus:${index}`); changed.fire(); },
		setProjectionSelection: (index, value) => {
			const item = rows[index]?.item; if (!item) { return; }
			selected = value ? [...new Set([...selected, item])] : selected.filter(candidate => candidate !== item);
			actions.push(`select:${index}:${value}`); changed.fire();
		},
		setProjectionScroll: top => actions.push(`scroll:${top}`),
		accept: () => actions.push('accept'), cancel: () => { actions.push('cancel'); hidden.fire({ reason: QuickInputHideReason.Gesture }); },
		triggerProjectionButton: (value, item) => actions.push(`button:${value.label}:${item?.label ?? 'global'}`)
	};
	return { source, changed, hidden, actions };
}

test('Quick Input projection is immutable, identity based, session safe and exhaustive across producers', () => {
	for (const producer of producers) {
		const f = fixture(producer);
		const controller = new QuickInputProjectionController(f.source);
		const initial = controller.snapshot;
		assert.equal(Object.isFrozen(initial), true);
		assert.equal(Object.isFrozen(initial.rows), true);
		assert.equal(initial.rows[0]?.selected, true);
		const firstId = initial.rows[0]!.id;
		const secondId = initial.rows[1]!.id;
		const buttonId = initial.buttons[0]!.id;
		const itemButtonId = initial.rows[0]!.buttons[0]!.id;
		assert.equal(controller.dispatch(Object.freeze({ sessionId: initial.sessionId, type: 'focus', id: secondId })), true);
		assert.equal(controller.snapshot.focusedId, secondId);
		controller.dispatch(Object.freeze({ sessionId: initial.sessionId, type: 'select', id: secondId, selected: true }));
		assert.deepEqual(controller.snapshot.selectedIds, [firstId, secondId]);
		controller.dispatch(Object.freeze({ sessionId: initial.sessionId, type: 'button', id: buttonId }));
		controller.dispatch(Object.freeze({ sessionId: initial.sessionId, type: 'button', id: itemButtonId, rowId: firstId }));
		assert.deepEqual(f.actions.slice(-2), ['button:Back:global', 'button:Remove:README']);
		controller.dispatch(Object.freeze({ sessionId: initial.sessionId, type: 'cancel' }));
		assert.equal(controller.snapshot.terminal, 'cancelled');
		assert.equal(controller.dispatch(Object.freeze({ sessionId: initial.sessionId, type: 'accept' })), false);
		controller.dispose();
	}
});

test('replacement sessions reject stale events while preserving stable item identities', () => {
	const first = fixture('quick-open');
	const oldController = new QuickInputProjectionController(first.source);
	const old = oldController.snapshot;
	const replacement = fixture('quick-open');
	const current = new QuickInputProjectionController(replacement.source);
	assert.notEqual(old.sessionId, current.sessionId);
	assert.equal(current.dispatch(Object.freeze({ sessionId: old.sessionId, type: 'accept' })), false);
	assert.deepEqual(replacement.actions, []);
	oldController.dispose(); current.dispose();
});
