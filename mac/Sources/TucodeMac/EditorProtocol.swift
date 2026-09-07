import Foundation

/// Native paint translated from the actual upstream editor group and input state.
struct EditorTabData: Codable, Equatable {
	let id: String
	let label: String
	let tooltip: String?
	let resource: String?
	var languageId: String? = nil
	var fileIconTheme: String? = nil
	let dirty: Bool
	let active: Bool
}

struct EditorTabsPaint: Codable {
	let groupId: Int
	let tabs: [EditorTabData]
	let order: [String]?
	let revealTargetId: String?
}

struct EditorTabIntent: Encodable {
	let eventType: String
	let tabId: String
	let groupId: Int
	var anchor: NativeMenuAnchor? = nil
	var index: Int? = nil
}
