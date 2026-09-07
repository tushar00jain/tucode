import AppKit
import WebKit
import XCTest
@testable import TucodeMac

@MainActor
final class EditorAreaLayoutTests: XCTestCase {
	func testEmptyEditorDoesNotCollapseWindowAndResizesWithIt() {
		let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 720),
			styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
		let content = window.contentView!
		let editor = EditorAreaView(webView: WKWebView(frame: .zero, configuration: WKWebViewConfiguration()))
		content.addSubview(editor)
		NSLayoutConstraint.activate([
			editor.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 294),
			editor.trailingAnchor.constraint(equalTo: content.trailingAnchor),
			editor.topAnchor.constraint(equalTo: content.topAnchor),
			editor.bottomAnchor.constraint(equalTo: content.bottomAnchor)
		])
		for width: CGFloat in [1120, 900, 1280] {
			window.setContentSize(NSSize(width: width, height: 720))
			window.layoutIfNeeded()
			XCTAssertEqual(window.frame.width, width, accuracy: 1)
			XCTAssertEqual(editor.frame.width, width - 294, accuracy: 1)
			XCTAssertGreaterThan(editor.webView.frame.height, 600)
		}
	}
}
