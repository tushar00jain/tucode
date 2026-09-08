import AppKit
import XCTest
@testable import TucodeMac

@MainActor
final class NativeQuickInputTests: XCTestCase {
	private func snapshot() -> QuickInputSnapshot {
		QuickInputSnapshot(sessionId: 7, producer: "quick-open", terminal: "open", value: "pack",
			valueSelection: nil, placeholder: nil, enabled: true, hideInput: false, hideList: false,
			rows: [
				QuickInputRow(id: "section", separator: true, label: "Files", description: nil, detail: nil, focused: false),
				QuickInputRow(id: "file", separator: false, label: "Package.swift", description: "mac", detail: "Swift package", focused: true),
				QuickInputRow(id: "other", separator: false, label: "Package.resolved", description: "mac", detail: nil, focused: false)
			])
	}

	func testPaintPreservesServiceOrderAndDoesNotSendInput() {
		let field = NativeQuickInputField()
		var intents: [QuickInputIntent] = []
		field.onIntent = { intents.append($0) }
		field.apply(snapshot())
		let table = NSTableView()
		XCTAssertEqual(field.numberOfRows(in: table), 3)
		XCTAssertFalse(field.tableView(table, shouldSelectRow: 0))
		XCTAssertTrue(field.tableView(table, isGroupRow: 0))
		for (index, row) in snapshot().rows.enumerated() {
			let cell = field.tableView(table, viewFor: nil, row: index) as? NSTableCellView
			XCTAssertEqual(cell?.textField?.stringValue, row.label)
			XCTAssertEqual(cell?.toolTip, row.detail)
		}
		XCTAssertTrue(intents.isEmpty)
	}

	func testHoverAndClickForwardIdentitiesWithoutChangingQuery() {
		let field = NativeQuickInputField()
		var intents: [QuickInputIntent] = []
		field.onIntent = { intents.append($0) }
		field.apply(snapshot())
		field.focusRow(0)
		field.focusRow(1)
		field.activateRow(-1)
		XCTAssertTrue(intents.isEmpty, "headers, existing focus and empty space are not actions")
		field.focusRow(2)
		XCTAssertEqual(intents.last?.eventType, "focus")
		XCTAssertEqual(intents.last?.id, "other")
		field.activateRow(2)
		XCTAssertEqual(intents.last?.eventType, "activate")
		XCTAssertEqual(intents.last?.id, "other")
		XCTAssertEqual(intents.last?.sessionId, 7)
		XCTAssertEqual(field.stringValue, "pack")
		field.hideSuggestions()
		field.activateRow(2)
		XCTAssertEqual(intents.count, 2, "dismissed UI cannot dispatch stale rows")
	}

	func testToolbarInteractionBeginsOnlyWhenOpeningSearch() {
		let field = NativeQuickInputField()
		var beginnings = 0
		field.onBeginInteraction = { beginnings += 1 }
		field.apply(snapshot())
		field.apply(snapshot())
		XCTAssertEqual(beginnings, 1, "Result updates must not restart toolbar focus or expansion")
		field.hideSuggestions()
		field.apply(snapshot())
		XCTAssertEqual(beginnings, 2)
	}

	func testArrowKeysAndReturnUseServiceNavigationAndAcceptance() {
		let field = NativeQuickInputField()
		var intents: [QuickInputIntent] = []
		field.onIntent = { intents.append($0) }
		field.apply(snapshot())
		let editor = NSTextView()
		XCTAssertTrue(field.control(field, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:))))
		XCTAssertEqual(intents.last?.eventType, "navigate")
		XCTAssertEqual(intents.last?.direction, "next")
		XCTAssertTrue(field.control(field, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:))))
		XCTAssertEqual(intents.last?.eventType, "accept")
		XCTAssertTrue(field.control(field, textView: editor, doCommandBy: #selector(NSResponder.cancelOperation(_:))))
		XCTAssertEqual(intents.last?.eventType, "cancel")
	}
}
