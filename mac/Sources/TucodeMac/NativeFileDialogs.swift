import AppKit
import UniformTypeIdentifiers

/// AppKit chooses paths and confirms replacement; VS Code owns opening and writing files.
final class NativeFileDialogs {
	private var activePanel: NSSavePanel?

	func show(_ body: Any, in window: NSWindow, reply: @escaping (Any?, String?) -> Void) {
		guard let options = body as? [String: Any], let kind = options["kind"] as? String,
			kind == "open" || kind == "save" else {
			reply(nil, "Invalid file dialog request")
			return
		}
		guard activePanel == nil, window.attachedSheet == nil else {
			reply(nil, "A dialog is already open")
			return
		}
		let panel: NSSavePanel
		if kind == "open" {
			let open = NSOpenPanel()
			open.canChooseFiles = options["canSelectFiles"] as? Bool ?? true
			open.canChooseDirectories = options["canSelectFolders"] as? Bool ?? false
			open.allowsMultipleSelection = options["canSelectMany"] as? Bool ?? false
			panel = open
		} else {
			panel = NSSavePanel()
			panel.canCreateDirectories = true
			panel.isExtensionHidden = false
		}
		if let title = options["title"] as? String { panel.title = title }
		if let label = options["label"] as? String { panel.prompt = label }
		if let path = options["defaultPath"] as? String, path.hasPrefix("/") {
			let url = URL(fileURLWithPath: path)
			var isDirectory: ObjCBool = false
			if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
				panel.directoryURL = url
			} else {
				panel.directoryURL = url.deletingLastPathComponent()
				panel.nameFieldStringValue = url.lastPathComponent
			}
		}
		let extensions = (options["filters"] as? [[String: Any]] ?? [])
			.flatMap { $0["extensions"] as? [String] ?? [] }
		if !extensions.isEmpty && !extensions.contains("*") && !extensions.contains("") {
			let types = Array(Set(extensions)).compactMap { UTType(filenameExtension: $0) }
			if !types.isEmpty { panel.allowedContentTypes = types }
		}
		activePanel = panel
		let responder = window.firstResponder
		panel.beginSheetModal(for: window) { [weak self] response in
			self?.activePanel = nil
			window.makeFirstResponder(responder)
			guard response == .OK else { reply(NSNull(), nil); return }
			let urls = (panel as? NSOpenPanel)?.urls ?? panel.url.map { [$0] } ?? []
			do {
				let selections = try urls.map { url -> [String: Any] in
					let canonical = url.resolvingSymlinksInPath()
					let directory = kind == "open" ? try canonical.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true : false
					return ["path": canonical.path(percentEncoded: false), "directory": directory]
				}
				reply(selections, nil)
			} catch { reply(nil, error.localizedDescription) }
		}
	}
}
