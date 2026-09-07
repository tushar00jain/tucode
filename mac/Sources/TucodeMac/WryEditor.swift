import AppKit
import WebKit
import CTucode

private func editorError() -> NSError {
	NSError(domain: "Tucode", code: 1, userInfo: [NSLocalizedDescriptionKey: String(cString: tucode_editor_error())])
}

/// Swift knows only the editor lifetime. Rust owns its backend and workers.
final class WryApplication {
	private let handle: UnsafeMutableRawPointer
	init() throws {
		guard let handle = tucode_app_start() else { throw editorError() }
		self.handle = handle
	}
	func makeEditor(in parent: NSView, configuration: WKWebViewConfiguration) throws -> WryEditor {
		let id = tucode_editor_create(handle, Unmanaged.passUnretained(parent).toOpaque(),
			Unmanaged.passUnretained(configuration).toOpaque())
		guard id != 0, let view = tucode_editor_view(id) else { throw editorError() }
		return WryEditor(id: id, webView: Unmanaged<WKWebView>.fromOpaque(view).takeUnretainedValue())
	}
	func stop() {
		tucode_app_stop(handle) { NSApp.reply(toApplicationShouldTerminate: true) }
	}
}

final class WryEditor {
	private var id: UInt64
	let webView: WKWebView
	init(id: UInt64, webView: WKWebView) { self.id = id; self.webView = webView }
	func close() {
		guard id != 0 else { return }
		tucode_editor_close(id)
		id = 0
	}
	deinit { close() }
}
