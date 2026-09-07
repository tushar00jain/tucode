import Severity from '../../out/src/vs/base/common/severity.js';
import { Emitter, Event } from '../../out/src/vs/base/common/event.js';
import { QuickInputProjectionController } from '../../out/src/editor/nativeQuickInputProjection.js';

/** Drives the production neutral controller; this is projection input, not a native/model bypass. */
export function quickInputProjectionFixture(options = {}) {
	const changed = new Emitter();
	const hidden = new Emitter();
	const items = (options.rows ?? [{ label: 'item' }]).map(row => ({ item: row }));
	let focus = options.focus ?? (items.length ? 0 : -1);
	let selectedItems = [];
	const source = {
		producer: options.producer ?? 'quick-open', title: options.title, description: options.description,
		step: options.step, totalSteps: options.totalSteps, value: options.value ?? '', valueSelection: options.valueSelection,
		placeholder: options.placeholder, prompt: options.prompt, validationMessage: options.validationMessage,
		severity: options.severity ?? Severity.Ignore, enabled: options.enabled ?? true, password: options.password ?? false,
		busy: options.busy ?? false, hideList: options.hideList ?? false, hideInput: options.hideInput ?? false,
		ignoreFocusOut: options.ignoreFocusOut ?? true, canSelectMany: options.canSelectMany ?? false,
		keepScrollPosition: options.keepScrollPosition ?? false, projectionScrollTop: 0, buttons: options.buttons ?? [],
		get rowCount() { return items.length; }, get projectionFocus() { return focus; }, get selectedItems() { return selectedItems; },
		onDidChangeInput: Event.None,
		acceptInput(value, selection) { this.value = value; this.valueSelection = selection; },
		onDidChange: changed.event, onDidHide: hidden.event, row: index => items[index],
		navigate: next => { focus = Math.max(0, Math.min(items.length - 1, focus + (next ? 1 : -1))); changed.fire(); },
		setProjectionFocus: index => { focus = index; changed.fire(); },
		setProjectionSelection: (index, selected) => {
			const item = items[index]?.item; if (!item) return;
			selectedItems = selected ? [...new Set([...selectedItems, item])] : selectedItems.filter(value => value !== item);
			changed.fire();
		},
		setProjectionScroll() {},
		accept: options.accept ?? (() => {}), cancel: options.cancel ?? (() => {}),
		triggerProjectionButton: options.triggerButton ?? (() => {})
	};
	const controller = new QuickInputProjectionController(source);
	return { controller, source, changed, hidden, dispose() { controller.dispose(); changed.dispose(); hidden.dispose(); } };
}
