import AppKit
import XCTest
@testable import TucodeMac

private final class RecordingOutline: NSOutlineView, NSOutlineViewDelegate {
	var fullReloads = 0
	var itemReloads = 0
	override init(frame: NSRect) { super.init(frame: frame); delegate = self }
	required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
	func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
		NSTextField(labelWithString: (item as? NavigatorOutlineItem)?.id ?? "")
	}
	override func reloadData() { fullReloads += 1; super.reloadData() }
	override func reloadItem(_ item: Any?, reloadChildren: Bool) { itemReloads += 1; super.reloadItem(item, reloadChildren: reloadChildren) }
}

final class NativeOutlineDataTests: XCTestCase {
	override func setUp() { super.setUp(); _ = NSApplication.shared }
	private func row(_ id: String, parent: String? = nil, expanded: Bool = false, branch: Bool = false, text: String? = nil) -> [String: Any] {
		var value: [String: Any] = ["id": id, "expandable": branch, "expanded": expanded, "focused": false, "selected": false,
			"render": ["root": [:], "runs": [["text": text ?? id, "style": [:]]], "accessibleLabel": text ?? id]]
		value["parentId"] = parent
		return value
	}
	private func message(reset: Bool = false, rows: [[String: Any]] = [], removed: [String] = [], children: [String: [String]] = [:]) throws -> String {
		let body: [String: Any] = ["generation": 1, "activeContainerId": "search", "containers": [], "sections": [],
			"outline": ["reset": reset, "rows": rows, "removed": removed,
				"children": children.map { ["parentId": $0.key, "ids": $0.value] }]]
		return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
	}
	private func visible(_ outline: NSOutlineView) -> [String] {
		(0..<outline.numberOfRows).compactMap { (outline.item(atRow: $0) as? NavigatorOutlineItem)?.id }
	}

	func testStreamingUsesAppKitInsertionsAndPreservesItemIdentity() throws {
		let decoder = NativeNavigatorDecoder(), data = NativeOutlineData(), outline = RecordingOutline()
		outline.dataSource = data
		outline.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name")))
		data.apply(try decoder.prepare(message(reset: true, rows: [row("file", expanded: true, branch: true), row("a", parent: "file")],
			children: ["": ["file"], "file": ["a"]])), to: outline)
		let file = try XCTUnwrap(data.items["file"]), a = try XCTUnwrap(data.items["a"])
		XCTAssertEqual(visible(outline), ["file", "a"])
		let reloads = outline.fullReloads
		data.apply(try decoder.prepare(message(rows: [row("b", parent: "file")], children: ["file": ["a", "b"]])), to: outline)
		XCTAssertEqual(visible(outline), ["file", "a", "b"])
		XCTAssertTrue(data.items["a"] === a)
		XCTAssertTrue(data.items["file"] === file)
		data.apply(try decoder.prepare(message(rows: [row("a", parent: "file", text: "new preview")])), to: outline)
		XCTAssertEqual(data.rows["a"]?.render.accessibleLabel, "new preview")
		data.apply(try decoder.prepare(message(removed: ["a"], children: ["file": ["b"]])), to: outline)
		XCTAssertEqual(visible(outline), ["file", "b"])
		XCTAssertEqual(outline.fullReloads, reloads, "streamed updates must not reload the entire outline")
		let itemReloads = outline.itemReloads
		data.apply(try decoder.prepare(message()), to: outline)
		XCTAssertEqual(outline.itemReloads, itemReloads, "control-only updates do no row paint")
	}

	func testCollapseExpansionReorderingAndRemovingAnExpandedParent() throws {
		let decoder = NativeNavigatorDecoder(), data = NativeOutlineData(), outline = RecordingOutline()
		outline.dataSource = data
		outline.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name")))
		data.apply(try decoder.prepare(message(reset: true, rows: [row("f", expanded: true, branch: true), row("a", parent: "f"), row("g", branch: true)],
			children: ["": ["f", "g"], "f": ["a"]])), to: outline)
		data.apply(try decoder.prepare(message(rows: [row("f", branch: true)], removed: ["a"], children: ["f": []])), to: outline)
		XCTAssertEqual(visible(outline), ["f", "g"])
		data.apply(try decoder.prepare(message(rows: [row("f", expanded: true, branch: true), row("a", parent: "f")], children: ["f": ["a"]])), to: outline)
		XCTAssertEqual(visible(outline), ["f", "a", "g"])
		data.apply(try decoder.prepare(message(children: ["": ["g", "f"]])), to: outline)
		XCTAssertEqual(visible(outline), ["g", "f", "a"])
		data.apply(try decoder.prepare(message(removed: ["f", "a"], children: ["": ["g"], "f": []])), to: outline)
		XCTAssertEqual(visible(outline), ["g"])
	}

	func testDecoderReturnsOnMainQueueAndPreservesOrderedDeltas() throws {
		let decoder = NativeNavigatorDecoder()
		let done = expectation(description: "decoded")
		let controls = NativeSearchControls()
		let oldState = NativeSearchState(revision: 0, query: "old query", replace: "", includes: "", excludes: "",
			caseSensitive: false, wholeWord: false, regex: false, preserveCase: false,
			replaceVisible: false, detailsVisible: false, searching: true, message: "Loading")
		controls.apply(oldState)
		let field = try XCTUnwrap(controls.arrangedSubviews.first as? NSSearchField)
		var typed: String?
		controls.onEvent = { _, value, _ in typed = value }
		let large = try message(reset: true, rows: (0..<20000).map { row("m\($0)") }, children: ["": (0..<20000).map { "m\($0)" }])
		var inputTurnRan = false
		decoder.decode(large) { result in
			XCTAssertTrue(Thread.isMainThread)
			XCTAssertTrue(inputTurnRan, "decoding must let AppKit's next event-loop turn run")
			XCTAssertEqual(try? result.get().snapshot.outline.rows.count, 20000)
			controls.apply(oldState)
			XCTAssertEqual(typed, "new query")
			XCTAssertEqual(field.stringValue, "new query", "the old result state must not overwrite input made while decoding")
			done.fulfill()
		}
		DispatchQueue.main.async {
			field.stringValue = "new query"
			controls.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
			inputTurnRan = true
		}
		wait(for: [done], timeout: 10)
	}

	func testTwentyThousandMatchesDoNotRepeatOutlineWorkForInput() throws {
		let decoder = NativeNavigatorDecoder(), data = NativeOutlineData(), outline = RecordingOutline()
		let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 600))
		scroll.documentView = outline
		defer { scroll.documentView = nil; outline.dataSource = nil; outline.delegate = nil }
		outline.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name")))
		outline.dataSource = data
		var records: [[String: Any]] = []
		var children: [String: [String]] = ["": (0..<1000).map { "f\($0)" }]
		for file in 0..<1000 {
			let id = "f\(file)"
			records.append(row(id, expanded: true, branch: true))
			children[id] = (0..<20).map { "\(id)-\($0)" }
			records.append(contentsOf: children[id]!.map { row($0, parent: id) })
		}
		let initial = try decoder.prepare(message(reset: true, rows: records, children: children))
		let start = ProcessInfo.processInfo.systemUptime
		data.apply(initial, to: outline)
		let applyTime = ProcessInfo.processInfo.systemUptime - start
		XCTAssertEqual(outline.numberOfRows, 21000)
		let reloads = outline.fullReloads, itemReloads = outline.itemReloads
		let input = try decoder.prepare(message())
		let inputStart = ProcessInfo.processInfo.systemUptime
		for _ in 0..<20 { data.apply(input, to: outline) }
		let inputTime = ProcessInfo.processInfo.systemUptime - inputStart
		XCTAssertEqual(outline.fullReloads, reloads)
		XCTAssertEqual(outline.itemReloads, itemReloads)
		print("Native outline: 20,000 matches initial apply \(Int(applyTime * 1000))ms; 20 input-only updates \(Int(inputTime * 1000))ms")
	}
}
