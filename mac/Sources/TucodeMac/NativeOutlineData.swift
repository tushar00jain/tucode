import AppKit

/// Stable AppKit object identity for one model-owned Explorer row.
final class NavigatorOutlineItem: NSObject {
	let id: String
	init(_ id: String) { self.id = id }
}

/// AppKit's ordinary outline data source. Only changed records cross the bridge.
final class NativeOutlineData: NSObject, NSOutlineViewDataSource {
	private(set) var rows: [String: OutlineRow] = [:]
	private(set) var items: [String: NavigatorOutlineItem] = [:]
	private var children: [String: [NavigatorOutlineItem]] = [:]

	func apply(_ prepared: PreparedNavigatorSnapshot, to outlineView: NSOutlineView) {
		let update = prepared.snapshot.outline
		// Retain only touched identities; copying a whole dictionary would trigger
		// a full copy on the next streamed insertion on AppKit's thread.
		let existingParents = Set(prepared.differences.compactMap { items[$0.parentId] == nil ? nil : $0.parentId })
		let existingRows = Set(update.rows.compactMap { rows[$0.id] == nil ? nil : $0.id })
		let reinserted = prepared.differences.flatMap { $0.changes.insertions }.compactMap { change -> String? in
			if case .insert(_, let id, _) = change, items[id] != nil { return id }; return nil
		}
		if update.reset {
			rows.removeAll(keepingCapacity: true)
			items.removeAll(keepingCapacity: true)
			children.removeAll(keepingCapacity: true)
		}
		for id in update.removed {
			rows.removeValue(forKey: id)
			items.removeValue(forKey: id)
			children.removeValue(forKey: id)
		}
		for row in update.rows {
			rows[row.id] = row
			if items[row.id] == nil { items[row.id] = NavigatorOutlineItem(row.id) }
		}
		for branch in prepared.differences {
			children[branch.parentId] = branch.ids.isEmpty ? nil : branch.ids.compactMap { items[$0] }
		}
		if update.reset {
			outlineView.reloadData()
		} else {
			// AppKit retains row views and disclosure state. Swift's CollectionDifference
			// supplies removals in descending order and insertions in ascending order.
			outlineView.beginUpdates()
			for branch in prepared.differences {
				let parent = items[branch.parentId]
				if !branch.parentId.isEmpty {
					guard let parent, existingParents.contains(branch.parentId),
						outlineView.isItemExpanded(parent) else { continue }
				}
				let removals = IndexSet(branch.changes.removals.compactMap { if case .remove(let offset, _, _) = $0 { return offset }; return nil })
				let insertions = IndexSet(branch.changes.insertions.compactMap { if case .insert(let offset, _, _) = $0 { return offset }; return nil })
				if !removals.isEmpty { outlineView.removeItems(at: removals, inParent: parent, withAnimation: []) }
				if !insertions.isEmpty { outlineView.insertItems(at: insertions, inParent: parent, withAnimation: []) }
			}
			outlineView.endUpdates()
			for row in update.rows where existingRows.contains(row.id) {
				if let item = items[row.id] { outlineView.reloadItem(item, reloadChildren: false) }
			}
		}
		outlineView.beginUpdates()
		for row in update.rows where row.expandable {
			guard let item = items[row.id] else { continue }
			if row.expanded && !outlineView.isItemExpanded(item) {
				outlineView.expandItem(item)
			} else if !row.expanded && outlineView.isItemExpanded(item) {
				outlineView.collapseItem(item)
			}
		}
		// Removing/reinserting an existing branch (sorting or reparenting) clears
		// AppKit's expansion for that subtree. Restore only model-expanded branches.
		for id in reinserted { restoreDisclosure(id, in: outlineView) }
		outlineView.endUpdates()
	}
	private func restoreDisclosure(_ id: String, in outlineView: NSOutlineView) {
		guard rows[id]?.expanded == true, let item = items[id] else { return }
		if !outlineView.isItemExpanded(item) { outlineView.expandItem(item) }
		for child in children[id] ?? [] { restoreDisclosure(child.id, in: outlineView) }
	}
	private func outlineId(_ item: Any?) -> String? { (item as? NavigatorOutlineItem)?.id }

	func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
		children[outlineId(item) ?? ""]?.count ?? 0
	}

	func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
		children[outlineId(item) ?? ""]![index]
	}

	func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
		outlineId(item).flatMap { rows[$0]?.expandable } ?? false
	}

}
