import AppKit

/// The application owns the backend and native windows; windows own editor connections.
final class ApplicationController: NSObject, NSApplicationDelegate {
	private var workspaces: [UUID: WorkspaceWindowController] = [:]
	private var nextWindowOrigin: NSPoint?
	private var editors: WryApplication?

	func applicationDidFinishLaunching(_ notification: Notification) {
		// The app setting controls grouping, independently of the system tabbing preference.
		NSWindow.allowsAutomaticWindowTabbing = false
		let root = argument("--repo-root").map { URL(fileURLWithPath: $0, isDirectory: true) }
			?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
		do {
			editors = try WryApplication()
			open(root, workspaceFile: argument("--workspace"), visualCompareTabs: argument("--visual-compare-tabs"))
		} catch {
			NSAlert(error: error).runModal()
			NSApp.terminate(nil)
			return
		}
		NSApp.activate(ignoringOtherApps: true)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		guard let editors else { return .terminateNow }
		for workspace in Array(workspaces.values) { workspace.stop() }
		workspaces.removeAll()
		self.editors = nil
		editors.stop()
		return .terminateLater
	}

	private func open(_ root: URL, workspaceFile: String? = nil, visualCompareTabs: String? = nil,
		tabbedWith parent: WorkspaceWindowController? = nil) {
		guard let editors else { return }
		let id = UUID()
		let controller = WorkspaceWindowController(root: root, workspaceFile: workspaceFile,
			visualCompareTabs: visualCompareTabs, editors: editors)
		controller.onClose = { [weak self] in self?.workspaces.removeValue(forKey: id) }
		controller.onOpenFolders = { [weak self, weak controller] folders, nativeTabs in
			for folder in folders { self?.open(folder, tabbedWith: nativeTabs ? controller : nil) }
		}
		workspaces[id] = controller
		do {
			nextWindowOrigin = try controller.show(cascadingFrom: nextWindowOrigin, tabbedWith: parent)
		} catch {
			controller.stop()
			workspaces.removeValue(forKey: id)
			NSAlert(error: error).runModal()
		}
	}

	private func argument(_ name: String) -> String? {
		guard let index = CommandLine.arguments.firstIndex(of: name),
			CommandLine.arguments.indices.contains(index + 1) else { return nil }
		return CommandLine.arguments[index + 1]
	}
}
