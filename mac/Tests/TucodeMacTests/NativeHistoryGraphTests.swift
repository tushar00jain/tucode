import AppKit
import XCTest
@testable import TucodeMac

@MainActor
final class NativeHistoryGraphTests: XCTestCase {
	func testNativeColumnsFitViewportAndCommitTextUsesEachRowsGeometry() throws {
		let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 150))
		let outline = NativeOutlineView(frame: NSRect(x: 0, y: 0, width: 600, height: 150))
		outline.style = .sourceList
		let graph = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("history-graph"))
		graph.resizingMask = []
		graph.minWidth = 0
		let text = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("outline"))
		outline.addTableColumn(graph); outline.addTableColumn(text)
		outline.outlineTableColumn = text
		scroll.documentView = outline
		let data = HistoryLayoutData()
		outline.dataSource = data
		outline.delegate = data
		let rows = try [22, 33].map { width in
			let json = """
			{"id":"\(width)","kind":"history-commit","expandable":true,"expanded":false,"focused":false,"selected":false,
			"render":{"root":{},"runs":[],"accessibleLabel":"Commit"},"graph":{"width":\(width),"height":22,"shapes":[]}}
			"""
			return try JSONDecoder().decode(OutlineRow.self, from: Data(json.utf8))
		}
		outline.rowRecord = { rows.indices.contains($0) ? rows[$0] : nil }
		outline.reloadData()
		let originalElasticity = scroll.horizontalScrollElasticity, originalMinimum = text.minWidth
		outline.historyGraphWidth = 33
		outline.layoutSubtreeIfNeeded()
		XCTAssertEqual(outline.frame.width, scroll.contentView.bounds.width, accuracy: 0.5)
		XCTAssertEqual(scroll.horizontalScrollElasticity, .none)
		XCTAssertEqual(outline.frameOfCell(atColumn: 1, row: 1).minX - outline.frameOfCell(atColumn: 1, row: 0).minX, 11, accuracy: 0.5)
		XCTAssertLessThanOrEqual(outline.frameOfCell(atColumn: 1, row: 0).maxX, scroll.contentView.bounds.width)
		XCTAssertEqual(outline.frameOfOutlineCell(atRow: 0), .zero)
		let firstView = try XCTUnwrap(outline.view(atColumn: 1, row: 0, makeIfNecessary: true))
		let secondView = try XCTUnwrap(outline.view(atColumn: 1, row: 1, makeIfNecessary: true))
		outline.layoutSubtreeIfNeeded()
		XCTAssertEqual(secondView.frame.minX - firstView.frame.minX, 11, accuracy: 0.5)
		scroll.setFrameSize(NSSize(width: 180, height: 150))
		outline.needsLayout = true; outline.layoutSubtreeIfNeeded()
		XCTAssertEqual(outline.frame.width, scroll.contentView.bounds.width, accuracy: 0.5)
		outline.historyGraphWidth = 1000
		outline.layoutSubtreeIfNeeded()
		XCTAssertEqual(outline.frame.width, scroll.contentView.bounds.width, accuracy: 0.5)
		XCTAssertLessThanOrEqual(outline.rect(ofColumn: 1).maxX, scroll.contentView.bounds.width)
		outline.historyGraphWidth = nil
		XCTAssertEqual(scroll.horizontalScrollElasticity, originalElasticity)
		XCTAssertEqual(text.minWidth, originalMinimum)
	}

	func testHiddenDisclosureStillAllowsNativeArrowKeyExpansion() throws {
		let outline = NativeOutlineView(frame: NSRect(x: 0, y: 0, width: 300, height: 150))
		let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("outline"))
		outline.addTableColumn(column); outline.outlineTableColumn = column
		let data = HistoryLayoutData()
		outline.dataSource = data
		let json = #"{"id":"commit","kind":"history-commit","expandable":true,"expanded":false,"focused":true,"selected":true,"render":{"root":{},"runs":[],"accessibleLabel":"Commit"}}"#
		let record = try JSONDecoder().decode(OutlineRow.self, from: Data(json.utf8))
		outline.rowRecord = { _ in record }
		let window = NSWindow(contentRect: outline.frame, styleMask: .borderless, backing: .buffered, defer: false)
		window.isReleasedWhenClosed = false
		window.contentView = outline
		defer { window.close() }
		outline.reloadData()
		outline.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
		window.makeFirstResponder(outline)
		XCTAssertEqual(outline.frameOfOutlineCell(atRow: 0), .zero)
		func press(_ keyCode: UInt16, _ character: Int) {
			let text = String(UnicodeScalar(character)!)
			outline.keyDown(with: NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
				timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
				charactersIgnoringModifiers: text, isARepeat: false, keyCode: keyCode)!)
		}
		press(124, NSRightArrowFunctionKey)
		XCTAssertTrue(outline.isItemExpanded(NSNumber(value: 0)))
		XCTAssertEqual(outline.numberOfRows, 3)
		press(123, NSLeftArrowFunctionKey)
		XCTAssertFalse(outline.isItemExpanded(NSNumber(value: 0)))
		XCTAssertEqual(outline.numberOfRows, 2)
	}

	func testHistoryChildrenFollowOwnGraphWithNativeFolderIndentation() throws {
		let outline = NativeOutlineView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
		outline.style = .sourceList
		let graph = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("history-graph"))
		graph.width = 99
		let text = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("outline"))
		outline.addTableColumn(graph); outline.addTableColumn(text); outline.outlineTableColumn = text
		let data = HistoryLayoutData()
		data.children = [-1: [0], 0: [1, 2], 2: [3]]
		outline.dataSource = data
		let records = try (0..<4).map { id in
			let json = """
			{"id":"\(id)","kind":"\(id == 0 ? "history-commit" : "history-change")","expandable":\(id == 0 || id == 2),"expanded":true,"focused":false,"selected":false,
			"render":{"root":{},"runs":[],"accessibleLabel":"Row"},"graph":{"width":22,"height":22,"shapes":[]}}
			"""
			return try JSONDecoder().decode(OutlineRow.self, from: Data(json.utf8))
		}
		outline.rowRecord = { row in
			guard let id = outline.item(atRow: row) as? NSNumber else { return nil }
			return records[id.intValue]
		}
		outline.reloadData(); outline.expandItem(nil, expandChildren: true)
		outline.historyGraphWidth = 99
		let commit = outline.frameOfCell(atColumn: 1, row: 0)
		let file = outline.frameOfCell(atColumn: 1, row: 1)
		let folder = outline.frameOfCell(atColumn: 1, row: 2)
		let nested = outline.frameOfCell(atColumn: 1, row: 3)
		XCTAssertEqual(file.minX - commit.minX, outline.indentationPerLevel, accuracy: 0.5)
		XCTAssertEqual(file.minX, folder.minX, accuracy: 0.5)
		XCTAssertEqual(nested.minX - file.minX, outline.indentationPerLevel, accuracy: 0.5)
		let disclosure = outline.frameOfOutlineCell(atRow: 2)
		XCTAssertFalse(disclosure.isEmpty)
		XCTAssertEqual(disclosure.maxX, folder.minX, accuracy: 0.5)
		outline.collapseItem(NSNumber(value: 2))
		XCTAssertEqual(outline.numberOfRows, 3)
		outline.expandItem(NSNumber(value: 2))
		XCTAssertEqual(outline.numberOfRows, 4)
		outline.rowRecord = nil
	}

	func testControlsConstructAndApplyStateWithoutSendingActions() {
		let controls = NativeHistoryControls()
		var actions: [String] = []
		controls.onAction = { actions.append($0) }
		controls.apply(NativeHistoryState(graphWidth: 33, repository: "Repository", refs: "main", loading: false,
			pageOnScroll: false, viewMode: "tree", enabled: true))
		XCTAssertFalse(controls.isHidden)
		XCTAssertEqual(controls.arrangedSubviews.count, 2)
		XCTAssertTrue(actions.isEmpty)
		controls.apply(nil)
		XCTAssertTrue(controls.isHidden)
	}

	func testGraphPaintUsesPreparedCoordinatesAcrossNativeRowHeights() throws {
		let json = #"{"width":33,"height":22,"shapes":[{"kind":"path","commands":[[0,11,0],[1,11,22]],"color":{"rgba":{"r":220,"g":20,"b":40,"a":1}},"strokeWidth":3}]}"#
		let geometry = try JSONDecoder().decode(NativeHistoryGraph.self, from: Data(json.utf8))
		for height in [22, 30, 44] {
			let view = NativeHistoryGraphView(frame: NSRect(x: 0, y: 0, width: 33, height: height))
			view.graph = geometry
			let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 33, pixelsHigh: height,
				bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
			let context = NSGraphicsContext(bitmapImageRep: bitmap)!
			NSGraphicsContext.saveGraphicsState()
			NSGraphicsContext.current = context
			view.draw(view.bounds)
			NSGraphicsContext.restoreGraphicsState()
			XCTAssertGreaterThan(bitmap.colorAt(x: 11, y: 0)?.redComponent ?? 0, 0.5)
			XCTAssertGreaterThan(bitmap.colorAt(x: 11, y: height - 1)?.redComponent ?? 0, 0.5)
			XCTAssertEqual(bitmap.colorAt(x: 25, y: height / 2)?.alphaComponent ?? 1, 0)
		}
	}
}

@MainActor
private final class HistoryLayoutData: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
	func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? { NSTableCellView() }
	var children = [-1: [0, 1], 0: [2]]
	func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { children[(item as? NSNumber)?.intValue ?? -1]?.count ?? 0 }
	func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { NSNumber(value: children[(item as? NSNumber)?.intValue ?? -1]![index]) }
	func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { children[(item as! NSNumber).intValue] != nil }
}
