/** Transport bookkeeping only. VS Code owns the tree; AppKit owns row reuse and layout. */
export interface NativeOutlineRow { id: string; parentId?: string; focused: boolean; selected: boolean; }

export class NativeOutlineUpdates {
	private context: string | undefined;
	private rows = new Map<string, string>();
	private children = new Map<string, string[]>();
	private inputRows: readonly NativeOutlineRow[] | undefined;
	private focusedId: string | undefined;

	/** Arrays are immutable view projections; control edits reuse the last array. */
	capture<T extends NativeOutlineRow>(context: string, rows: readonly T[]) {
		if (context === this.context && rows === this.inputRows) {
			return { reset: false, rows: [] as T[], removed: [] as string[], children: [] as { parentId: string; ids: string[] }[], focusedId: this.focusedId };
		}
		const reset = context !== this.context;
		if (reset) { this.rows.clear(); this.children.clear(); }
		this.context = context;
		const nextRows = new Map<string, string>();
		const nextChildren = new Map<string, string[]>();
		const changedRows: T[] = [];
		let focusedId: string | undefined;
		let selectedId: string | undefined;
		for (const row of rows) {
			const value = JSON.stringify(row);
			nextRows.set(row.id, value);
			if (this.rows.get(row.id) !== value) { changedRows.push(row); }
			const parent = row.parentId ?? '';
			let children = nextChildren.get(parent);
			if (!children) { nextChildren.set(parent, children = []); }
			children.push(row.id);
			if (row.focused) { focusedId = row.id; }
			if (row.selected) { selectedId = row.id; }
		}
		const removed = [...this.rows.keys()].filter(id => !nextRows.has(id));
		const children: { parentId: string; ids: string[] }[] = [];
		for (const parentId of new Set([...this.children.keys(), ...nextChildren.keys()])) {
			const before = this.children.get(parentId) ?? [];
			const ids = nextChildren.get(parentId) ?? [];
			if (before.length !== ids.length || before.some((id, index) => id !== ids[index])) { children.push({ parentId, ids }); }
		}
		this.rows = nextRows;
		this.children = nextChildren;
		this.inputRows = rows;
		this.focusedId = focusedId ?? selectedId;
		return { reset, rows: changedRows, removed, children, focusedId: this.focusedId };
	}
}
