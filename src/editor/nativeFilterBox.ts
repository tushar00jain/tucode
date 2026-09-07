/* Native field transport for the shared view-root controllers. AppKit paints the snapshot. */
import type { IViewRoot, IViewRootBox } from '../vs/workbench/browser/tauri/viewRootController.js';

export class NativeFilterBox implements IViewRootBox {
	isOpen = false;
	hasKeyboard = true;
	value = '';
	private revision = 0;
	get height(): number { return this.isOpen ? 28 : 0; }
	open(query: string): void { this.value = query; this.isOpen = true; this.hasKeyboard = true; }
	close(): boolean { this.isOpen = false; return this.hasKeyboard; }
	dispose(): void { this.isOpen = false; }
	get snapshot() { return { visible: this.isOpen, value: this.value, revision: this.revision, restoreFocus: this.hasKeyboard }; }
	dispatch(root: IViewRoot, prefix: string, payload: any): boolean {
		switch (payload.eventType) {
			case `${prefix}-filter-open`: root.open(); return true;
			case `${prefix}-filter-change`:
				if (typeof payload.value === 'string') {
					root.open();
					this.revision = typeof payload.revision === 'number' ? payload.revision : this.revision + 1;
					this.value = payload.value; root.apply(payload.value);
				}
				return true;
			case `${prefix}-filter-cancel`: this.hasKeyboard = payload.focused !== false; root.cancel(); return true;
			case `${prefix}-filter-commit`: root.commit(); return true;
			case `${prefix}-filter-complete`: root.complete(payload.direction === 'previous' ? -1 : 1); return true;
			default: return false;
		}
	}
}
