import Foundation

struct QuickInputRow: Codable {
	let id: String
	let separator: Bool
	let label: String
	let description: String?
	let detail: String?
	let focused: Bool
}

struct QuickInputSnapshot: Codable {
	let sessionId: Int
	let producer: String
	let terminal: String
	let value: String
	let valueSelection: [Int]?
	let placeholder: String?
	let enabled: Bool
	let hideInput: Bool
	let hideList: Bool
	let rows: [QuickInputRow]
}

struct QuickInputUpdate: Codable {
	let sessionId: Int
	let value: String?
	let selection: [Int]?
}

struct NavigatorContainer: Codable, Equatable {
	let id: String
	let title: String
	let icon: NavigatorIcon?
}

struct NavigatorIcon: Codable, Equatable {
	let kind: String
	let id: String?
	let path: String?
}

struct NavigatorSection: Codable, Equatable {
	let id: String
	let title: String
	let order: Int
	let expanded: Bool
}

struct NavigatorSnapshot: Codable {
	let generation: Int
	let activeContainerId: String?
	let focusedSectionId: String?
	let containers: [NavigatorContainer]
	let sections: [NavigatorSection]
	let outlineRows: [OutlineRow]
	let filter: NavigatorFilter?
	let search: NativeSearchState?
}

struct NavigatorFilter: Codable {
	let visible: Bool
	let value: String
	let restoreFocus: Bool?
	let revision: Int?
}

struct RenderRGBA: Codable, Equatable {
	let r: Int
	let g: Int
	let b: Int
	let a: Double
}

struct RenderColor: Codable, Equatable { let rgba: RenderRGBA }

struct RenderStyle: Codable, Equatable {
	let fg: RenderColor?
	let bg: RenderColor?
	let bold: Bool?
	let dim: Bool?
	let italic: Bool?
	let underline: Bool?
	let strikethrough: Bool?
}

struct RenderRun: Codable, Equatable {
	let text: String
	let style: RenderStyle
}

struct RenderRecords: Codable, Equatable {
	let root: RenderStyle
	let runs: [RenderRun]
	let accessibleLabel: String
}

struct OutlineRow: Codable, Equatable {
	let id: String
	let kind: String?
	let resource: String?
	var languageId: String? = nil
	var fileIconTheme: String? = nil
	let isDirectory: Bool?
	let parentId: String?
	let expandable: Bool
	let expanded: Bool
	let focused: Bool
	let selected: Bool
	let render: RenderRecords
	let status: String?
	let statusColor: RenderColor?
	let icon: String?
}

struct KeyInputIntent: Encodable {
	let key: String
	let code: String
	let target: String
	let ctrlKey: Bool
	let shiftKey: Bool
	let altKey: Bool
	let metaKey: Bool
}

struct QuickInputIntent: Encodable {
	var selection: [Int]? = nil
	let sessionId: Int
	let eventType: String
	let value: String?
	let id: String?
	let direction: String?
	var focused: Bool? = nil
}

struct NavigatorIntent: Encodable {
	let eventType: String
	let id: String?
	let expanded: Bool?
	let focused: Bool?
	var value: String? = nil
	var direction: String? = nil
	var revision: Int? = nil
	var anchor: NativeMenuAnchor? = nil
}

enum ModelMessage {
	case ready
	case quickInputSnapshot(QuickInputSnapshot)
	case quickInputUpdate(QuickInputUpdate)
	case quickInputHidden
	case navigatorSnapshot(NavigatorSnapshot)
	case editorTabsPaint(EditorTabsPaint)
	case mainMenu(MainMenuPaint)
	case contextMenu(ContextMenuPaint)
	case contextMenuChildren(ContextMenuChildren)
	case contextMenuHidden
	case error(String)
}

private struct MessageHeader: Decodable {
	let version: Int
	let type: String
}

private struct IncomingEnvelope<Payload: Decodable>: Decodable {
	let payload: Payload
}

private struct ErrorPayload: Decodable { let message: String }

enum ProjectionMessageError: LocalizedError {
	case invalidMessage

	var errorDescription: String? { "WKWebView returned an invalid projection message" }
}

func decodeProjectionMessage(_ body: Any) throws -> ModelMessage {
	guard JSONSerialization.isValidJSONObject(body) else { throw ProjectionMessageError.invalidMessage }
	let data = try JSONSerialization.data(withJSONObject: body)
	let decoder = JSONDecoder()
	let header = try decoder.decode(MessageHeader.self, from: data)
	guard header.version == 1 else { throw ProjectionMessageError.invalidMessage }
	switch header.type {
	case "ready": return .ready
	case "quickInputSnapshot":
		return .quickInputSnapshot(try decoder.decode(IncomingEnvelope<QuickInputSnapshot>.self, from: data).payload)
	case "quickInputUpdate":
		return .quickInputUpdate(try decoder.decode(IncomingEnvelope<QuickInputUpdate>.self, from: data).payload)
	case "quickInputHidden": return .quickInputHidden
	case "navigatorSnapshot":
		return .navigatorSnapshot(try decoder.decode(IncomingEnvelope<NavigatorSnapshot>.self, from: data).payload)
	case "editorTabsPaint":
		return .editorTabsPaint(try decoder.decode(IncomingEnvelope<EditorTabsPaint>.self, from: data).payload)
	case "mainMenu":
		return .mainMenu(try decoder.decode(IncomingEnvelope<MainMenuPaint>.self, from: data).payload)
	case "contextMenu":
		return .contextMenu(try decoder.decode(IncomingEnvelope<ContextMenuPaint>.self, from: data).payload)
	case "contextMenuChildren":
		return .contextMenuChildren(try decoder.decode(IncomingEnvelope<ContextMenuChildren>.self, from: data).payload)
	case "contextMenuHidden": return .contextMenuHidden
	case "error":
		return .error(try decoder.decode(IncomingEnvelope<ErrorPayload>.self, from: data).payload.message)
	default: throw ProjectionMessageError.invalidMessage
	}
}
