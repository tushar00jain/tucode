import Foundation

/// Derived presentation records, not a second search or filesystem model.
struct NativeOutlineUpdate: Codable {
	let reset: Bool
	let rows: [OutlineRow]
	let removed: [String]
	let children: [NativeOutlineChildren]
	let focusedId: String?
}

struct NativeOutlineChildren: Codable {
	let parentId: String
	let ids: [String]
}

struct NativeOutlineDifference {
	let parentId: String
	let ids: [String]
	let changes: CollectionDifference<String>
}

struct PreparedNavigatorSnapshot {
	let snapshot: NavigatorSnapshot
	let differences: [NativeOutlineDifference]
}

/// Foundation decoding and Swift's standard diff run away from AppKit input.
/// The caller acknowledges each application, bounding the bridge to one update.
final class NativeNavigatorDecoder {
	private let queue = DispatchQueue(label: "com.tucode.navigator.decode", qos: .userInitiated)
	private var children: [String: [String]] = [:]

	func decode(_ text: String, completion: @escaping (Result<PreparedNavigatorSnapshot, Error>) -> Void) {
		queue.async {
			let result = Result { try self.prepare(text) }
			DispatchQueue.main.async { completion(result) }
		}
	}

	// Called serially, also usable without AppKit for protocol tests.
	func prepare(_ text: String) throws -> PreparedNavigatorSnapshot {
		let snapshot = try JSONDecoder().decode(NavigatorSnapshot.self, from: Data(text.utf8))
		if snapshot.outline.reset { children.removeAll(keepingCapacity: true) }
		let differences = snapshot.outline.children.map { branch in
			let old = children[branch.parentId] ?? []
			children[branch.parentId] = branch.ids.isEmpty ? nil : branch.ids
			return NativeOutlineDifference(parentId: branch.parentId, ids: branch.ids,
				changes: branch.ids.difference(from: old))
		}
		return PreparedNavigatorSnapshot(snapshot: snapshot, differences: differences)
	}
}
