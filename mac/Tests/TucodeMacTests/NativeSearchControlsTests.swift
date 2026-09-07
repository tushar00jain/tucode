import AppKit
import XCTest
@testable import TucodeMac

final class NativeSearchControlsTests: XCTestCase {
	private func state(revision: Int = 0, query: String = "needle", expanded: Bool = false) -> NativeSearchState {
		NativeSearchState(revision: revision, query: query, replace: "replacement", includes: "*.swift", excludes: "build",
			caseSensitive: true, wholeWord: false, regex: false, preserveCase: true,
			replaceVisible: expanded, detailsVisible: expanded, searching: false, message: "2 results in 2 files")
	}
	private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
	private func field(_ key: String, in controls: NativeSearchControls) throws -> NSSearchField {
		try XCTUnwrap(views(controls).compactMap { $0 as? NSSearchField }.first { $0.identifier?.rawValue == key })
	}

	func testNativeControlsPaintServiceStateWithoutSendingEdits() throws {
		let controls = NativeSearchControls()
		var events: [String] = []
		controls.onEvent = { type, _, _ in events.append(type) }
		XCTAssertTrue(controls.isHidden)
		controls.apply(state(expanded: true))
		XCTAssertFalse(controls.isHidden)
		XCTAssertEqual(try field("query", in: controls).stringValue, "needle")
		XCTAssertEqual(try field("replace", in: controls).stringValue, "replacement")
		XCTAssertEqual(try field("includes", in: controls).stringValue, "*.swift")
		XCTAssertEqual(try field("excludes", in: controls).stringValue, "build")
		let buttons = views(controls).compactMap { $0 as? NSButton }
		XCTAssertEqual(buttons.first { $0.identifier?.rawValue == "case" }?.state, .on)
		XCTAssertEqual(buttons.first { $0.identifier?.rawValue == "word" }?.state, .off)
		XCTAssertEqual(buttons.first { $0.identifier?.rawValue == "replace" }?.state, .on)
		XCTAssertTrue(events.isEmpty)
		controls.apply(nil)
		XCTAssertTrue(controls.isHidden)
	}

	func testStreamedOldStateCannotReplaceAnUnacknowledgedEdit() throws {
		let controls = NativeSearchControls()
		controls.apply(state())
		var events: [(String, String?, Int?)] = []
		controls.onEvent = { events.append(($0, $1, $2)) }
		let query = try field("query", in: controls)
		query.stringValue = "new query"
		controls.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: query))
		XCTAssertEqual(events.count, 1)
		XCTAssertEqual(events[0].0, "search-query-change")
		XCTAssertEqual(events[0].1, "new query")
		XCTAssertEqual(events[0].2, 1)
		controls.apply(state())
		XCTAssertEqual(query.stringValue, "new query")
		controls.apply(state(revision: 1, query: "new query"))
		XCTAssertEqual(query.stringValue, "new query")
		controls.apply(state(revision: 2, query: "service update"))
		XCTAssertEqual(query.stringValue, "service update")
		XCTAssertEqual(events.count, 1, "painting acknowledgements must not send edits back")
	}
}
