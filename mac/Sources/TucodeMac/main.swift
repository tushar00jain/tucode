import AppKit
import Foundation
import UniformTypeIdentifiers
import WebKit

private final class WebAssetSchemeHandler: NSObject, WKURLSchemeHandler {
	private let root: URL

	init(root: URL) {
		self.root = root.standardizedFileURL
	}

	func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
		guard let requestURL = urlSchemeTask.request.url else {
			urlSchemeTask.didFailWithError(URLError(.badURL))
			return
		}
		let relative = requestURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		let isAppResource = relative.hasPrefix("app-resource/")
		let resourceRoot = root.appendingPathComponent(isAppResource ? "app" : "Web").resolvingSymlinksInPath()
		let resourcePath = isAppResource ? String(relative.dropFirst("app-resource/".count)) : relative
		let file = resourceRoot.appendingPathComponent(resourcePath).standardizedFileURL.resolvingSymlinksInPath()
		let unqualifiedRootPath = resourceRoot.path(percentEncoded: false)
		let rootPath = unqualifiedRootPath.hasSuffix("/") ? unqualifiedRootPath : unqualifiedRootPath + "/"
		guard file.path(percentEncoded: false).hasPrefix(rootPath) else {
			urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile))
			return
		}
		let data: Data
		do {
			data = try Data(contentsOf: file)
		} catch {
			let diagnostic = "WK asset missing: \(requestURL.absoluteString) -> \(file.path(percentEncoded: false)): \(error)\n"
			FileHandle.standardError.write(Data(diagnostic.utf8))
			urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
			return
		}
		let extensionName = file.pathExtension.lowercased()
		let mimeType: String
		switch extensionName {
		case "js": mimeType = "text/javascript"
		case "css": mimeType = "text/css"
		case "wasm": mimeType = "application/wasm"
		case "svg": mimeType = "image/svg+xml"
		case "ttf": mimeType = "font/ttf"
		case "woff": mimeType = "font/woff"
		case "woff2": mimeType = "font/woff2"
		default: mimeType = UTType(filenameExtension: extensionName)?.preferredMIMEType
			?? "application/octet-stream"
		}
		let response = URLResponse(url: requestURL, mimeType: mimeType,
			expectedContentLength: data.count, textEncodingName: extensionName == "html" ? "utf-8" : nil)
		urlSchemeTask.didReceive(response)
		urlSchemeTask.didReceive(data)
		urlSchemeTask.didFinish()
	}

	func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
}

private final class TucodeWindow: NSWindow {
	var handleUnhandledKeyEquivalent: ((NSEvent) -> Bool)?

	override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
		var constrained = super.constrainFrameRect(frameRect, to: screen)
		// Mission Control can propose a frame outside every display when moving
		// from a Retina screen. AppKit otherwise leaves only a title-bar sliver visible.
		guard let screen, screen != self.screen,
			!NSScreen.screens.contains(where: { $0.frame.intersects(frameRect) }) else {
			return constrained
		}
		let visible = screen.visibleFrame
		constrained.origin = NSPoint(
			x: max(visible.minX, visible.midX - constrained.width / 2),
			y: max(visible.minY, visible.midY - constrained.height / 2)
		)
		return constrained
	}

	override func performKeyEquivalent(with event: NSEvent) -> Bool {
		if NSApp.mainMenu?.performKeyEquivalent(with: event) == true { return true }
		if super.performKeyEquivalent(with: event) { return true }
		return handleUnhandledKeyEquivalent?(event) ?? false
	}
}

private func changesDocumentImage() -> NSImage {
	let image = NSImage(size: NSSize(width: 16, height: 18), flipped: false) { _ in
		NSColor.labelColor.setStroke()
		let path = NSBezierPath()
		path.lineWidth = 1.25
		path.lineJoinStyle = .round
		path.move(to: NSPoint(x: 3, y: 1))
		path.line(to: NSPoint(x: 13, y: 1))
		path.line(to: NSPoint(x: 13, y: 12))
		path.line(to: NSPoint(x: 9, y: 16))
		path.line(to: NSPoint(x: 3, y: 16))
		path.close()
		path.move(to: NSPoint(x: 9, y: 16)); path.line(to: NSPoint(x: 9, y: 12)); path.line(to: NSPoint(x: 13, y: 12))
		path.move(to: NSPoint(x: 5.5, y: 9)); path.line(to: NSPoint(x: 10.5, y: 9))
		path.move(to: NSPoint(x: 8, y: 6.5)); path.line(to: NSPoint(x: 8, y: 11.5))
		path.move(to: NSPoint(x: 5.5, y: 4)); path.line(to: NSPoint(x: 10.5, y: 4))
		path.stroke()
		return true
	}
	image.isTemplate = true
	return image
}

private final class NavigatorIconButton: NSButton {
	override var alignmentRectInsets: NSEdgeInsets {
		NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
	}

	var usesSelectedAppearance = false {
		didSet { needsLayout = true }
	}

	override func layout() {
		super.layout()
		wantsLayer = true
		layer?.cornerRadius = 13
		layer?.cornerCurve = .circular
		layer?.masksToBounds = true
		layer?.backgroundColor = usesSelectedAppearance ? NSColor.controlAccentColor.cgColor : NSColor.clear.cgColor
	}
}

private final class NavigatorContainerItem: NSCollectionViewItem {
	let button = NavigatorIconButton()

	override func loadView() {
		view = NSView()
		button.isBordered = false
		button.imagePosition = .imageOnly
		button.imageScaling = .scaleProportionallyDown
		button.focusRingType = .none
		button.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(button)
		NSLayoutConstraint.activate([
			button.widthAnchor.constraint(equalToConstant: 31),
			button.heightAnchor.constraint(equalToConstant: 28),
			button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
			button.centerYAnchor.constraint(equalTo: view.centerYAnchor)
		])
	}

	func configure(title: String, symbol: String, id: String, selected: Bool, target: AnyObject, action: Selector) {
		button.title = ""
		button.toolTip = title
		button.identifier = NSUserInterfaceItemIdentifier(id)
		button.target = target
		button.action = action
		button.isBordered = false
		button.usesSelectedAppearance = selected
		button.imagePosition = .imageOnly
		let image = (symbol == "tucode.changes" ? changesDocumentImage() : NSImage(systemSymbolName: symbol, accessibilityDescription: title))
			?? NSImage(named: NSImage.actionTemplateName)
		button.image = image?.withSymbolConfiguration(.init(pointSize: 14, weight: .medium)) ?? image
		button.contentTintColor = selected ? .white : .secondaryLabelColor
		button.setAccessibilityIdentifier("tucode.navigator.container.\(id)")
		button.setAccessibilityLabel(title)
	}
}

/// AppKit owns row hit testing, keyboard navigation and selection. Only semantic operations cross
/// the bridge; asynchronously resolved children still come from the shared Explorer model.
private final class NativeOutlineView: NSOutlineView {
	private(set) var mouseDownItemId: String?
	var onFilter: (() -> Bool)?
	var onOpen: ((Int) -> Void)?
	var onFocus: ((Bool) -> Void)?
	var onContextMenu: ((Int, NSPoint) -> Void)?

	private func requestContextMenu(for event: NSEvent) {
		onContextMenu?(row(at: convert(event.locationInWindow, from: nil)), event.locationInWindow)
	}

	override func rightMouseDown(with event: NSEvent) { requestContextMenu(for: event) }

	override func mouseDown(with event: NSEvent) {
		if event.modifierFlags.contains(.control) { requestContextMenu(for: event); return }
		let point = convert(event.locationInWindow, from: nil)
		let clickedRow = row(at: point)
		mouseDownItemId = clickedRow >= 0 ? (item(atRow: clickedRow) as? NavigatorOutlineItem)?.id : nil
		defer { mouseDownItemId = nil }
		super.mouseDown(with: event)
	}

	override func keyDown(with event: NSEvent) {
		if event.characters == "/", onFilter?() == true { return }
		if event.keyCode == 36 || event.keyCode == 76 {
			onOpen?(selectedRow)
			return
		}
		super.keyDown(with: event)
	}

	override func becomeFirstResponder() -> Bool {
		let accepted = super.becomeFirstResponder()
		if accepted { onFocus?(true) }
		return accepted
	}

	override func resignFirstResponder() -> Bool {
		let accepted = super.resignFirstResponder()
		if accepted { onFocus?(false) }
		return accepted
	}
}

final class WorkspaceWindowController: NSObject, NSWindowDelegate, NSTableViewDelegate,
	NSOutlineViewDataSource, NSOutlineViewDelegate, WKScriptMessageHandler,
	WKScriptMessageHandlerWithReply, NSSearchFieldDelegate, NSToolbarDelegate {
	private var changesFilter: NSSearchField!
	private var changesInputRevision = 0
	private let searchControls = NativeSearchControls()
	private var window: NSWindow!
	private var errorLabel: NSTextField!
	private var quickInputField: NativeQuickInputField!
	private var quickInputToolbarItem: NSSearchToolbarItem!
	private let quickInputToolbarIdentifier = NSToolbarItem.Identifier("com.tucode.quickInput")
	private var navigatorContainerBar: NSView!
	private var navigatorContainerBarWidth: NSLayoutConstraint!
	private var navigatorContainerCollection: NSCollectionView!
	private var navigatorSectionTable: NSTableView!
	private var navigatorSectionScroll: NSScrollView!
	private var navigatorSectionHeight: NSLayoutConstraint!
	private var navigatorOutline: NativeOutlineView!
	private var navigatorContainerDataSource: NSCollectionViewDiffableDataSource<String, String>!
	private var navigatorSectionDataSource: NSTableViewDiffableDataSource<String, String>!
	private let navigatorDecoder = NativeNavigatorDecoder()
	private var navigatorSnapshot: NavigatorSnapshot?
	private var navigatorContainers: [String: NavigatorContainer] = [:]
	private var navigatorSections: [String: NavigatorSection] = [:]
	private let navigatorOutlineData = NativeOutlineData()
	private var applyingNavigatorSnapshot = false
	private var editorAreaView: EditorAreaView!
	private var webAssetHandler: WebAssetSchemeHandler!
	private let editors: WryApplication
	private var editor: WryEditor?
	private let fileDialogs = NativeFileDialogs()
	private var webEditorReady = false
	private var pendingNativeMessages: [String] = []
	private var keyEventMonitor: Any?
	// WebKit can send an unhandled NSEvent back through NSApplication asynchronously.
	// Keep its identity until the event is released, not just until keyDown returns.
	private let forwardedEditorKeys = NSHashTable<NSEvent>(options: [.weakMemory, .objectPointerPersonality])
	private let root: URL
	private let workspaceFile: String?
	private let visualCompareTabs: String?
	private var fallbackMenu: NSMenu?
	private var stopped = false
	var onClose: (() -> Void)?
	var onOpenFolders: (([URL], Bool) -> Void)?

	init(root: URL, workspaceFile: String?, visualCompareTabs: String?, editors: WryApplication) {
		self.editors = editors
		self.root = root
		self.workspaceFile = workspaceFile
		self.visualCompareTabs = visualCompareTabs
		super.init()
	}

	func show(cascadingFrom point: NSPoint?, tabbedWith parent: WorkspaceWindowController?) throws -> NSPoint {
		buildMainMenu()
		try buildWindow()
		let nextOrigin: NSPoint
		if let parent {
			window.setFrame(parent.window.frame, display: false)
			parent.window.tabbingMode = .preferred
			window.tabbingMode = .preferred
			parent.window.addTabbedWindow(window, ordered: .above)
			nextOrigin = point ?? NSPoint(x: window.frame.minX + 28, y: window.frame.maxY - 28)
		} else {
			window.center()
			nextOrigin = point.map { window.cascadeTopLeft(from: $0) }
				?? NSPoint(x: window.frame.minX + 28, y: window.frame.maxY - 28)
		}
		window.makeKeyAndOrderFront(nil)
		startWebEditor()
		return nextOrigin
	}

	func windowDidBecomeKey(_ notification: Notification) {
		if !editorMainMenu.activate(), let fallbackMenu { NSApp.mainMenu = fallbackMenu }
		sendNativeInput(type: "windowFocus", payload: ["focused": true])
	}

	func windowDidResignKey(_ notification: Notification) {
		sendNativeInput(type: "windowFocus", payload: ["focused": false])
	}

	func window(_ window: NSWindow, willUseFullScreenPresentationOptions proposedOptions: NSApplication.PresentationOptions)
		-> NSApplication.PresentationOptions {
		// Keep the workspace toolbar in place when the full-screen menu bar hides.
		proposedOptions.subtracting(.autoHideToolbar)
	}

	func windowWillClose(_ notification: Notification) {
		stop()
		onClose?()
	}

	func stop() {
		guard !stopped else { return }
		stopped = true
		if let keyEventMonitor { NSEvent.removeMonitor(keyEventMonitor) }
		editorContextMenu.hide()
		quickInputField.hideSuggestions()
		guard let editorAreaView else { return }
		let controller = editorAreaView.webView.configuration.userContentController
		controller.removeScriptMessageHandler(forName: "tucodeProjection", contentWorld: .page)
		controller.removeScriptMessageHandler(forName: "tucodeNative", contentWorld: .page)
		editor?.close()
		editor = nil
	}

	private func buildWindow() throws {
		let tucodeWindow = TucodeWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1120, height: 720),
			styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		tucodeWindow.handleUnhandledKeyEquivalent = { [weak self] event in
			self?.handleVSCodeKeyEquivalent(event) ?? false
		}
		window = tucodeWindow
		window.delegate = self
		window.isReleasedWhenClosed = false
		window.title = "\(root.lastPathComponent) — tucode"
		window.tab.title = root.lastPathComponent
		window.tabbingIdentifier = "com.tucode.workspace"
		window.tabbingMode = .disallowed
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		window.titlebarSeparatorStyle = .none
		quickInputField = NativeQuickInputField()
		quickInputField.onOpen = { [weak self] in
			self?.sendNativeInput(type: "command", payload: ["id": "workbench.action.quickOpen"])
		}
		quickInputField.onIntent = { [weak self] intent in
			self?.sendNativeInput(type: "quickInputEvent", payload: intent)
		}
		quickInputToolbarItem = NSSearchToolbarItem(itemIdentifier: quickInputToolbarIdentifier)
		quickInputToolbarItem.label = "Search Files and Commands"
		quickInputToolbarItem.searchField = quickInputField
		quickInputToolbarItem.preferredWidthForSearchField = 368
		quickInputToolbarItem.visibilityPriority = .high
		let preferredSearchWidth = quickInputField.widthAnchor.constraint(equalToConstant: 368)
		preferredSearchWidth.priority = .defaultHigh
		preferredSearchWidth.isActive = true
		quickInputField.onBeginInteraction = { [weak self] in
			self?.quickInputToolbarItem.beginSearchInteraction()
		}
		let navigatorShell = try buildNavigatorShell()
		window.contentViewController = navigatorShell
		window.toolbarStyle = .unified
		let toolbar = NSToolbar(identifier: "com.tucode.workspace.toolbar")
		toolbar.displayMode = .iconOnly
		toolbar.delegate = self
		window.toolbar = toolbar
		let content = navigatorShell.splitViewItems[1].viewController.view
		errorLabel = NSTextField(wrappingLabelWithString: "")
		errorLabel.font = .systemFont(ofSize: 13, weight: .medium)
		errorLabel.textColor = .systemRed
		errorLabel.alignment = .center
		errorLabel.isHidden = true
		errorLabel.setAccessibilityIdentifier("tucode.bootstrap.error")
		errorLabel.translatesAutoresizingMaskIntoConstraints = false

		content.addSubview(errorLabel)
		NSLayoutConstraint.activate([
			errorLabel.centerXAnchor.constraint(equalTo: editorAreaView.centerXAnchor),
			errorLabel.centerYAnchor.constraint(equalTo: editorAreaView.centerYAnchor),
			errorLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 480)
			])
		window.initialFirstResponder = navigatorOutline

		keyEventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
			guard let self else { return event }
			// AppKit hosts the toolbar in a separate window during full screen.
			guard let eventWindow = event.window,
				(eventWindow === self.window || eventWindow === self.quickInputField.window),
				self.window.attachedSheet == nil,
				NSApp.modalWindow == nil else { return event }
			if event.type != .keyDown {
				self.forwardKeyRelease(event)
				return event
			}
			// Give the native field editor first refusal; NativeWindow forwards unhandled
			// global shortcuts to VS Code after AppKit's normal key-equivalent dispatch.
			if let editor = self.searchControls.currentEditor ?? self.changesFilter.currentEditor() ?? self.quickInputField.currentEditor(), editor === eventWindow.firstResponder {
				if self.handleNativeFieldEdit(event, editor: editor) { return nil }
				// Leave Quick Input's suggestions navigation to AppKit; forward only global shortcuts below.
				if editor !== self.quickInputField.currentEditor() { return event }
			}
			if NSApp.mainMenu?.performKeyEquivalent(with: event) == true
				|| self.handleVSCodeKeyEquivalent(event) { return nil }
			return event
		}
	}

	func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
		// AppKit uses this section to place window tabs beside the full-height sidebar.
		[.sidebarTrackingSeparator, .flexibleSpace, quickInputToolbarIdentifier, .flexibleSpace]
	}

	func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
		toolbarDefaultItemIdentifiers(toolbar)
	}

	func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
		willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
		identifier == quickInputToolbarIdentifier ? quickInputToolbarItem : nil
	}

	private func buildNavigatorShell() throws -> NSSplitViewController {
		let containerLayout = NSCollectionViewFlowLayout()
		containerLayout.scrollDirection = .horizontal
		containerLayout.itemSize = NSSize(width: 30, height: 30)
		containerLayout.minimumInteritemSpacing = 0
		containerLayout.minimumLineSpacing = 0
		containerLayout.sectionInset = NSEdgeInsets(top: 0, left: 2, bottom: 0, right: 2)
		navigatorContainerCollection = NSCollectionView()
		navigatorContainerCollection.collectionViewLayout = containerLayout
		navigatorContainerCollection.backgroundColors = [.clear]
		navigatorContainerCollection.isSelectable = false
		navigatorContainerCollection.register(NavigatorContainerItem.self,
			forItemWithIdentifier: NSUserInterfaceItemIdentifier("navigator-container"))
		navigatorContainerCollection.setAccessibilityIdentifier("tucode.navigator.containers")
		navigatorSectionTable = navigatorTable(identifier: "tucode.navigator.sections")

		navigatorContainerDataSource = NSCollectionViewDiffableDataSource<String, String>(
			collectionView: navigatorContainerCollection
		) { [weak self] collection, indexPath, id in
			guard let self, let record = self.navigatorContainers[id],
				let item = collection.makeItem(withIdentifier: NSUserInterfaceItemIdentifier("navigator-container"),
					for: indexPath) as? NavigatorContainerItem else { return NSCollectionViewItem() }
			item.configure(title: record.title, symbol: self.navigatorSymbol(for: record), id: record.id,
				selected: self.navigatorSnapshot?.activeContainerId == record.id,
				target: self, action: #selector(self.navigatorContainerPressed(_:)))
			return item
		}
		navigatorSectionDataSource = NSTableViewDiffableDataSource<String, String>(
			tableView: navigatorSectionTable
		) { [weak self] table, _, _, id in
			guard let self, let record = self.navigatorSections[id] else { return NSTableCellView() }
			return self.navigatorCell(in: table, reuse: "section",
				text: "\(record.expanded ? "▼" : "▶") \(record.title.uppercased())",
				accessibilityIdentifier: "tucode.navigator.section.\(record.id)", font: .systemFont(ofSize: 11, weight: .semibold))
		}

		let containerScroll = NSScrollView()
		// The selector's container handles spacing; don't inset its fixed-height viewport again.
		containerScroll.automaticallyAdjustsContentInsets = false
		containerScroll.documentView = navigatorContainerCollection
		containerScroll.hasVerticalScroller = false
		containerScroll.hasHorizontalScroller = false
		containerScroll.borderType = .noBorder
		containerScroll.drawsBackground = false
		containerScroll.translatesAutoresizingMaskIntoConstraints = false

		navigatorContainerBar = NSView()
		navigatorContainerBar.wantsLayer = true
		navigatorContainerBar.layer?.cornerRadius = 15
		navigatorContainerBar.layer?.borderWidth = 0.5
		navigatorContainerBar.layer?.borderColor = NSColor.separatorColor.cgColor
		navigatorContainerBar.layer?.masksToBounds = true
		navigatorContainerBar.translatesAutoresizingMaskIntoConstraints = false
		navigatorContainerBar.addSubview(containerScroll)
		navigatorContainerBarWidth = navigatorContainerBar.widthAnchor.constraint(equalToConstant: 36)
		NSLayoutConstraint.activate([
			navigatorContainerBarWidth,
			navigatorContainerBar.heightAnchor.constraint(equalToConstant: 30),
			containerScroll.leadingAnchor.constraint(equalTo: navigatorContainerBar.leadingAnchor),
			containerScroll.trailingAnchor.constraint(equalTo: navigatorContainerBar.trailingAnchor),
			containerScroll.topAnchor.constraint(equalTo: navigatorContainerBar.topAnchor),
			containerScroll.bottomAnchor.constraint(equalTo: navigatorContainerBar.bottomAnchor)
		])

		navigatorSectionScroll = NSScrollView()
		navigatorSectionScroll.documentView = navigatorSectionTable
		navigatorSectionScroll.hasVerticalScroller = true
		navigatorSectionScroll.borderType = .noBorder
		navigatorSectionScroll.drawsBackground = false
		navigatorSectionScroll.translatesAutoresizingMaskIntoConstraints = false
		navigatorSectionScroll.isHidden = true

		navigatorOutline = NativeOutlineView()
		navigatorOutline.headerView = nil
		navigatorOutline.delegate = self
		navigatorOutline.dataSource = navigatorOutlineData
		navigatorOutline.style = .sourceList
		navigatorOutline.backgroundColor = .clear
		navigatorOutline.usesAlternatingRowBackgroundColors = false
		navigatorOutline.rowSizeStyle = .small
		navigatorOutline.allowsMultipleSelection = false
		navigatorOutline.indentationPerLevel = 14
		navigatorOutline.indentationMarkerFollowsCell = true
		navigatorOutline.target = self
		navigatorOutline.action = #selector(activateClickedOutlineRow)
		navigatorOutline.onOpen = { [weak self] row in
			guard let self, let id = self.outlineId(self.navigatorOutline.item(atRow: row)) else { return }
			self.sendNavigatorEvent(type: "outline-open", id: id)
		}
		navigatorOutline.onFocus = { [weak self] focused in
			self?.sendNavigatorEvent(type: "outline-focus-state", focused: focused)
		}
		navigatorOutline.onContextMenu = { [weak self] row, point in
			guard let self, let id = self.outlineId(self.navigatorOutline.item(atRow: row)) else { return }
			self.window.makeFirstResponder(self.navigatorOutline)
			self.navigatorOutline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
			self.sendNativeInput(type: "navigatorEvent", payload: NavigatorIntent(
				eventType: "outline-context-menu", id: id, expanded: nil, focused: nil, anchor: NativeMenuAnchor(point)))
		}
		navigatorOutline.onFilter = { [weak self] in
			guard let self, let prefix = self.navigatorFilterPrefix else { return false }
			self.sendNavigatorEvent(type: "\(prefix)-filter-open")
			return true
		}
		navigatorOutline.setAccessibilityIdentifier("tucode.navigator.outline")
		let outlineColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("outline"))
		outlineColumn.resizingMask = .autoresizingMask
		navigatorOutline.addTableColumn(outlineColumn)
		navigatorOutline.outlineTableColumn = outlineColumn

		let outlineScroll = NSScrollView()
		outlineScroll.documentView = navigatorOutline
		outlineScroll.hasVerticalScroller = true
		outlineScroll.autohidesScrollers = true
		outlineScroll.borderType = .noBorder
		outlineScroll.drawsBackground = false
		outlineScroll.backgroundColor = .clear
		outlineScroll.contentView.drawsBackground = false
		outlineScroll.translatesAutoresizingMaskIntoConstraints = false

		changesFilter = NSSearchField()
		changesFilter.placeholderString = "Filter"
		(changesFilter.cell as? NSSearchFieldCell)?.searchButtonCell = nil
		(changesFilter.cell as? NSSearchFieldCell)?.cancelButtonCell = nil
		changesFilter.delegate = self
		changesFilter.sendsSearchStringImmediately = true
		changesFilter.setAccessibilityIdentifier("tucode.changes.filter")
		changesFilter.isHidden = true
		searchControls.onEvent = { [weak self] type, value, revision in
			self?.sendNavigatorEvent(type: type, value: value, revision: revision)
		}
		searchControls.onExitField = { [weak self] in
			guard let self else { return }
			self.window.makeFirstResponder(self.navigatorOutline)
		}
		let sidebarContent = NSStackView(views: [navigatorContainerBar, navigatorSectionScroll,
			searchControls, outlineScroll, changesFilter])
		sidebarContent.orientation = .vertical
		sidebarContent.alignment = .centerX
		sidebarContent.spacing = 0
		sidebarContent.setCustomSpacing(8, after: navigatorContainerBar)
		sidebarContent.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
		sidebarContent.translatesAutoresizingMaskIntoConstraints = false
		navigatorSectionScroll.widthAnchor.constraint(equalTo: sidebarContent.widthAnchor, constant: -16).isActive = true
		changesFilter.widthAnchor.constraint(equalTo: sidebarContent.widthAnchor, constant: -16).isActive = true
		searchControls.widthAnchor.constraint(equalTo: sidebarContent.widthAnchor, constant: -16).isActive = true
		navigatorSectionHeight = navigatorSectionScroll.heightAnchor.constraint(equalToConstant: 0)
		navigatorSectionHeight.isActive = true
		outlineScroll.widthAnchor.constraint(equalTo: sidebarContent.widthAnchor, constant: -16).isActive = true
		outlineScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
		outlineScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

		let sidebarController = NSViewController()
		let sidebar = NSView(frame: NSRect(x: 0, y: 0, width: 284, height: 720))
		sidebarController.view = sidebar
		let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebarController)
		// Share the sidebar background instead of drawing a separate accessory header.
		sidebar.addSubview(sidebarContent)
		NSLayoutConstraint.activate([
			sidebarContent.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
			sidebarContent.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
			sidebarContent.topAnchor.constraint(equalTo: sidebar.safeAreaLayoutGuide.topAnchor),
			sidebarContent.bottomAnchor.constraint(equalTo: sidebar.safeAreaLayoutGuide.bottomAnchor)
		])

		let webConfiguration = WKWebViewConfiguration()
		guard let resourceURL = Bundle.main.resourceURL else { preconditionFailure("missing app resources") }
		webAssetHandler = WebAssetSchemeHandler(root: resourceURL)
		webConfiguration.setURLSchemeHandler(webAssetHandler, forURLScheme: "tucode")
		webConfiguration.userContentController.add(self, contentWorld: .page, name: "tucodeProjection")
		webConfiguration.userContentController.addScriptMessageHandler(
			self, contentWorld: .page, name: "tucodeNative")
		let editor = try editors.makeEditor(in: window.contentView!, configuration: webConfiguration)
		self.editor = editor
		editorAreaView = EditorAreaView(webView: editor.webView)
		editorAreaView.webView.isInspectable = true
		editorAreaView.setAccessibilityIdentifier("tucode.editor.canvas")
		editorAreaView.onTabInput = { [weak self] input in
			self?.sendNativeInput(type: "editorEvent", payload: input)
		}
		editorAreaView.onNewFile = { [weak self] in
			self?.sendNativeInput(type: "command", payload: ["id": "workbench.action.files.newUntitledFile"])
		}
		let editorColumn = NSStackView(views: [editorAreaView])
		editorColumn.orientation = .vertical
		editorColumn.alignment = .centerX
		editorColumn.distribution = .fill
		editorColumn.spacing = 0
		editorColumn.setAccessibilityElement(true)
		editorColumn.setAccessibilityRole(.group)
		editorColumn.setAccessibilityIdentifier("tucode.editor.column")
		editorAreaView.setContentHuggingPriority(.defaultLow, for: .vertical)
		editorAreaView.widthAnchor.constraint(equalTo: editorColumn.widthAnchor).isActive = true

		let editorController = NSViewController()
		editorController.view = NSView(frame: NSRect(x: 0, y: 0, width: 826, height: 720))
		editorColumn.translatesAutoresizingMaskIntoConstraints = false
		editorController.view.addSubview(editorColumn)
		NSLayoutConstraint.activate([
			editorColumn.leadingAnchor.constraint(equalTo: editorController.view.leadingAnchor),
			editorColumn.trailingAnchor.constraint(equalTo: editorController.view.trailingAnchor),
			editorColumn.topAnchor.constraint(equalTo: editorController.view.safeAreaLayoutGuide.topAnchor),
			editorColumn.bottomAnchor.constraint(equalTo: editorController.view.bottomAnchor)
		])
		sidebarItem.allowsFullHeightLayout = true
		sidebarItem.minimumThickness = 284
		sidebarItem.maximumThickness = 284
		sidebarItem.canCollapse = false
		let editorItem = NSSplitViewItem(viewController: editorController)
		editorItem.minimumThickness = 320
		let shell = NSSplitViewController()
		shell.addSplitViewItem(sidebarItem)
		shell.addSplitViewItem(editorItem)
		shell.view.setAccessibilityIdentifier("tucode.navigator.shell")
		return shell
	}

	private func navigatorSymbol(for container: NavigatorContainer) -> String {
		switch container.icon?.id {
		case "files": return "folder"
		case "search": return "magnifyingglass"
		case "source-control": return "tucode.changes"
		case "graph": return "point.3.connected.trianglepath.dotted"
		default: return "square.grid.2x2"
		}
	}

	private func navigatorTable(identifier: String) -> NSTableView {
		let table = NSTableView()
		table.headerView = nil
		table.delegate = self
		table.allowsEmptySelection = true
		table.allowsMultipleSelection = false
		table.intercellSpacing = NSSize(width: 0, height: 2)
		table.rowHeight = 30
		table.selectionHighlightStyle = .none
		table.setAccessibilityIdentifier(identifier)
		let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(identifier))
		column.resizingMask = .autoresizingMask
		table.addTableColumn(column)
		return table
	}

	private func navigatorCell(in table: NSTableView, reuse: String, text: String,
		accessibilityIdentifier: String, font: NSFont) -> NSView {
		let cell = tableCell(in: table, reuse: reuse, inset: 12)
		cell.textField?.stringValue = text
		cell.textField?.font = font
		cell.textField?.setAccessibilityIdentifier(accessibilityIdentifier)
		return cell
	}

	private func tableCell(in table: NSTableView, reuse: String, inset: CGFloat) -> NSTableCellView {
		let identifier = NSUserInterfaceItemIdentifier(reuse)
		return table.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView ?? {
			let value = NSTableCellView()
			value.identifier = identifier
			let label = NSTextField(labelWithString: "")
			label.translatesAutoresizingMaskIntoConstraints = false
			label.lineBreakMode = .byTruncatingTail
			value.textField = label
			value.addSubview(label)
			NSLayoutConstraint.activate([
				label.leadingAnchor.constraint(equalTo: value.leadingAnchor, constant: inset),
				label.trailingAnchor.constraint(equalTo: value.trailingAnchor, constant: -inset),
				label.centerYAnchor.constraint(equalTo: value.centerYAnchor)
			])
			return value
		}()
	}

	private func buildMainMenu() {
		let mainMenu = NSMenu()
		let applicationItem = NSMenuItem()
		mainMenu.addItem(applicationItem)
		let applicationMenu = NSMenu()
		let quit = NSMenuItem(title: "Quit tucode", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
		quit.keyEquivalentModifierMask = .command
		applicationMenu.addItem(quit)
		applicationItem.submenu = applicationMenu

		let viewItem = NSMenuItem()
		mainMenu.addItem(viewItem)
		let viewMenu = NSMenu(title: "View")
		let toggleFullScreen = NSMenuItem(title: "Toggle Full Screen",
			action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
		toggleFullScreen.keyEquivalentModifierMask = [.command, .control]
		viewMenu.addItem(toggleFullScreen)
		viewItem.submenu = viewMenu
		NSApp.mainMenu = mainMenu
		fallbackMenu = mainMenu
	}

	private func startWebEditor() {
		do {
			guard let resources = Bundle.main.resourceURL else {
				throw CocoaError(.fileNoSuchFile)
			}
			let appResourceRoot = resources.appendingPathComponent("app", isDirectory: true)
			var configuration: [String: Any] = [
				"repositoryRoot": root.path(percentEncoded: false),
				"resourceRoot": appResourceRoot.path(percentEncoded: false)
			]
			if let visualCompareTabs {
				configuration["visualCompareTabs"] = visualCompareTabs
			}
			if let workspaceFile {
				configuration["workspaceFile"] = URL(fileURLWithPath: workspaceFile).path(percentEncoded: false)
			}
			let data = try JSONSerialization.data(withJSONObject: configuration)
			let json = String(decoding: data, as: UTF8.self)
			let script = WKUserScript(source: """
				globalThis.__TUCODE_MAC_CONFIG__ = \(json);
				globalThis._VSCODE_FILE_ROOT = globalThis.__TUCODE_MAC_CONFIG__.resourceRoot + '/out/src';
				""",
				injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
			editorAreaView.webView.configuration.userContentController.addUserScript(script)
			let errorBridge = WKUserScript(source: """
				addEventListener('error', event => webkit.messageHandlers.tucodeProjection.postMessage({
					version: 1, requestId: 0, type: 'error', payload: {
						message: String(event.message || event.error || event.target?.src || 'WKWebView resource error')
							+ (event.error?.stack ? '\n' + event.error.stack : '')
					}
				}), true);
				addEventListener('unhandledrejection', event => webkit.messageHandlers.tucodeProjection.postMessage({
					version: 1, requestId: 0, type: 'error', payload: {
						message: String(event.reason?.message || event.reason || 'Unhandled WKWebView rejection')
							+ (event.reason?.stack ? '\n' + event.reason.stack : '')
					}
				}));
				""", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
			editorAreaView.webView.configuration.userContentController.addUserScript(errorBridge)
			guard let index = URL(string: "tucode://app/index.html") else { throw URLError(.badURL) }
			editorAreaView.load(index)
		} catch {
			fail(error.localizedDescription)
		}
	}

	func userContentController(_ userContentController: WKUserContentController,
		didReceive message: WKScriptMessage) {
		guard message.name == "tucodeProjection" else { return }
		do { didReceive(try decodeProjectionMessage(message.body)) }
		catch { fail(error.localizedDescription) }
	}

	func userContentController(_ userContentController: WKUserContentController,
		didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void) {
		if message.name == "tucodeNative", let request = message.body as? [String: Any] {
			if let command = request["cmd"] as? String,
				command == "mac_show_previous_window_tab" || command == "mac_show_next_window_tab" {
				if (window.tabbedWindows?.count ?? 0) > 1 {
					if command == "mac_show_previous_window_tab" { window.selectPreviousTab(nil) }
					else { window.selectNextTab(nil) }
				}
				replyHandler(NSNull(), nil)
				return
			}
			if request["cmd"] as? String == "mac_apply_navigator" {
				guard let args = request["args"] as? [String: Any], let text = args["snapshot"] as? String else {
					replyHandler(nil, "Invalid navigator update"); return
				}
				navigatorDecoder.decode(text) { [weak self] result in
					switch result {
					case .success(let prepared):
						self?.apply(prepared)
						replyHandler(NSNull(), nil)
					case .failure(let error): replyHandler(nil, error.localizedDescription)
					}
				}
				return
			}
			if request["cmd"] as? String == "mac_open_folders" {
				do {
					guard let args = request["args"] as? [String: Any], let paths = args["folders"] as? [String],
					!paths.isEmpty, paths.allSatisfy({ $0.hasPrefix("/") }) else { throw CocoaError(.fileReadInvalidFileName) }
					let folders = try paths.map { path in
						let url = URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath()
						guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
							throw CocoaError(.fileReadUnsupportedScheme)
						}
						return url
					}
					onOpenFolders?(folders, args["nativeTabs"] as? Bool ?? false)
					replyHandler(NSNull(), nil)
				} catch { replyHandler(nil, error.localizedDescription) }
				return
			}
			if request["cmd"] as? String == "mac_focus_window" {
				window.makeKeyAndOrderFront(nil)
				replyHandler(NSNull(), nil)
				return
			}
		}
		if message.name == "tucodeNative", let request = message.body as? [String: Any],
			request["cmd"] as? String == "mac_show_file_dialog" {
			fileDialogs.show(request["args"] ?? [:], in: window, reply: replyHandler)
			return
		}
		guard message.name == "tucodeNative" else {
			replyHandler(nil, "The VS Code host service is unavailable")
			return
		}
		replyHandler(nil, "Unknown native UI command")
	}

	private let editorContextMenu = EditorContextMenu()
	private let editorMainMenu = EditorMainMenu()

	private func didReceive(_ message: ModelMessage) {
		switch message {
		case .ready:
			webEditorReady = true
			errorLabel.isHidden = true
			for message in pendingNativeMessages { evaluateNativeMessage(message) }
			pendingNativeMessages.removeAll()
		case .quickInputSnapshot(let snapshot):
			quickInputField.apply(snapshot)
		case .quickInputUpdate(let update):
			quickInputField.apply(update)
		case .quickInputHidden:
			quickInputField.hideSuggestions()
		case .editorTabsPaint(let paint):
			editorAreaView.apply(paint)
		case .mainMenu(let paint):
			editorMainMenu.apply(paint, keyEquivalent: { [weak self] event in
				self?.handleVSCodeKeyEquivalent(event) ?? false
			}) { [weak self] intent in
				self?.sendNativeInput(type: "mainMenuEvent", payload: intent)
			}
			if window.isKeyWindow { _ = editorMainMenu.activate() }
		case .contextMenu(let paint):
			editorContextMenu.show(paint, in: editorAreaView.webView) { [weak self] intent in
				self?.sendNativeInput(type: "contextMenuEvent", payload: intent)
			}
		case .contextMenuHidden:
			editorContextMenu.hide()
		case .contextMenuChildren(let children):
			editorContextMenu.apply(children)
		case .error(let message):
			fail(message)
		}
	}

	/// AppKit resolves native menus and controls first. The remaining shortcut crosses the existing
	/// shared input boundary and is consumed here, so AppKit does not beep for a command VS Code owns.
	private func handleVSCodeKeyEquivalent(_ event: NSEvent) -> Bool {
		guard event.window === window, window.attachedSheet == nil, NSApp.modalWindow == nil else { return false }
		// Also stop synchronous responder-chain reentry and asynchronous WebKit redispatch.
		if forwardedEditorKeys.contains(event) { return true }
		let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
		guard webEditorReady,
			let code = domCode(for: event.keyCode),
			!modifiers.intersection([.command, .control, .option]).isEmpty || code.hasPrefix("F"),
			let key = event.charactersIgnoringModifiers, !key.isEmpty else { return false }
		// Option-only input may compose text; leave it with the active text editor.
		let nativeFieldHasFocus = (window.firstResponder as? NSTextView)?.isFieldEditor == true
		if (editorHasFocus || nativeFieldHasFocus) && modifiers.intersection([.command, .control]).isEmpty && !code.hasPrefix("F") { return false }
		if editorHasFocus, let responder = window.firstResponder {
			// Deliver the original event to WebKit once, before AppKit's key-equivalent traversal
			// can claim shortcuts such as Control-Tab. WebKit and VS Code own dispatch/defaults.
			forwardedEditorKeys.add(event)
			responder.keyDown(with: event)
			return true
		}
		let target = window.firstResponder === navigatorOutline ? "navigator" : "workbench"
		sendKey(key: key.lowercased(), code: code, target: target, modifiers: modifiers)
		return true
	}

	private func forwardKeyRelease(_ event: NSEvent) {
		// WebKit delivers its own keyup events; only native controls need the bridge.
		guard webEditorReady, !editorHasFocus, let code = domCode(for: event.keyCode) else { return }
		let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
		let key: String
		if event.type == .flagsChanged {
			let flag: NSEvent.ModifierFlags
			switch event.keyCode {
			case 56, 60: flag = .shift; key = "Shift"
			case 59, 62: flag = .control; key = "Control"
			case 58, 61: flag = .option; key = "Alt"
			case 54, 55: flag = .command; key = "Meta"
			default: return
			}
			guard !modifiers.contains(flag) else { return }
		} else { key = event.charactersIgnoringModifiers ?? "" }
		sendKey(key: key, code: code, target: "workbench", modifiers: modifiers, type: "keyUp")
	}

	/// Route standard field-edit equivalents to
	/// AppKit's field editor; the editor owns the text operation and its undo history.
	private func handleNativeFieldEdit(_ event: NSEvent, editor: NSText) -> Bool {
		let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
		// Modified motion/deletion is interpreted by AppKit's text system. These events
		// must reach the field editor before the asynchronous workbench shortcut bridge.
		if !modifiers.intersection([.command, .control, .option]).isEmpty,
			[51, 117, 115, 119, 123, 124, 125, 126].contains(event.keyCode) {
			editor.keyDown(with: event)
			return true
		}
		guard modifiers == .command || modifiers == [.command, .shift] else { return false }
		let selector: Selector
		switch (event.charactersIgnoringModifiers?.lowercased(), modifiers.contains(.shift)) {
		case ("a", false): selector = #selector(NSText.selectAll(_:))
		case ("c", false): selector = #selector(NSText.copy(_:))
		case ("x", false): selector = #selector(NSText.cut(_:))
		case ("v", false): selector = #selector(NSText.paste(_:))
		case ("z", false): selector = Selector(("undo:"))
		case ("z", true): selector = Selector(("redo:"))
		default: return false
		}
		return NSApp.sendAction(selector, to: editor, from: changesFilter)
	}

	private var editorHasFocus: Bool {
		let focusedView = window.firstResponder as? NSView
		return focusedView === editorAreaView.webView
			|| focusedView?.isDescendant(of: editorAreaView.webView) == true
	}

	/// NSEvent reports the hardware position; VS Code's macOS keyboard mapper consumes the matching
	/// browser `code`. This is transport translation only—the resolver still owns the command.
	private func domCode(for keyCode: UInt16) -> String? {
		switch keyCode {
		case 0: "KeyA"; case 1: "KeyS"; case 2: "KeyD"; case 3: "KeyF"
		case 4: "KeyH"; case 5: "KeyG"; case 6: "KeyZ"; case 7: "KeyX"
		case 8: "KeyC"; case 9: "KeyV"; case 11: "KeyB"; case 12: "KeyQ"
		case 13: "KeyW"; case 14: "KeyE"; case 15: "KeyR"; case 16: "KeyY"
		case 17: "KeyT"; case 18: "Digit1"; case 19: "Digit2"; case 20: "Digit3"
		case 21: "Digit4"; case 22: "Digit6"; case 23: "Digit5"; case 24: "Equal"
		case 25: "Digit9"; case 26: "Digit7"; case 27: "Minus"; case 28: "Digit8"
		case 29: "Digit0"; case 30: "BracketRight"; case 31: "KeyO"; case 32: "KeyU"
		case 33: "BracketLeft"; case 34: "KeyI"; case 35: "KeyP"; case 37: "KeyL"
		case 38: "KeyJ"; case 39: "Quote"; case 40: "KeyK"; case 41: "Semicolon"
		case 42: "Backslash"; case 43: "Comma"; case 44: "Slash"; case 45: "KeyN"
		case 46: "KeyM"; case 47: "Period"; case 50: "Backquote"
		case 36: "Enter"; case 48: "Tab"; case 49: "Space"; case 51: "Backspace"; case 53: "Escape"
		case 123: "ArrowLeft"; case 124: "ArrowRight"; case 125: "ArrowDown"; case 126: "ArrowUp"
		case 115: "Home"; case 119: "End"; case 116: "PageUp"; case 121: "PageDown"; case 117: "Delete"
		case 122: "F1"; case 120: "F2"; case 99: "F3"; case 118: "F4"
		case 96: "F5"; case 97: "F6"; case 98: "F7"; case 100: "F8"
		case 101: "F9"; case 109: "F10"; case 103: "F11"; case 111: "F12"
		case 56: "ShiftLeft"; case 60: "ShiftRight"; case 59: "ControlLeft"; case 62: "ControlRight"
		case 58: "AltLeft"; case 61: "AltRight"; case 55: "MetaLeft"; case 54: "MetaRight"
		default: nil
		}
	}

	private func sendKey(key: String, code: String, target: String, modifiers: NSEvent.ModifierFlags,
		type: String = "key") {
		sendNativeInput(type: type, payload: KeyInputIntent(
				key: key,
				code: code,
				target: target,
				ctrlKey: modifiers.contains(.control),
				shiftKey: modifiers.contains(.shift),
				altKey: modifiers.contains(.option),
				metaKey: modifiers.contains(.command)
			))
	}


	private func apply(_ prepared: PreparedNavigatorSnapshot) {
		let snapshot = prepared.snapshot
		let containerChanged = navigatorSnapshot?.activeContainerId != snapshot.activeContainerId
		let filterWasActive = !containerChanged && navigatorSnapshot?.filter?.visible == true
		let focusedView = window.firstResponder as? NSView
		let outlineHadFocus = focusedView === navigatorOutline
			|| focusedView?.isDescendant(of: navigatorOutline) == true
		let previousSnapshot = navigatorSnapshot
		let previousActiveContainerId = navigatorSnapshot?.activeContainerId
		let previousFocusedSectionId = navigatorSnapshot?.focusedSectionId
		let previousContainers = navigatorContainers
		let previousSections = navigatorSections
		let previousFocusedOutlineId = previousSnapshot?.outline.focusedId
		let focusedOutlineId = snapshot.outline.focusedId
		let shouldRevealOutlineFocus = focusedOutlineId != nil
			&& focusedOutlineId != previousFocusedOutlineId
		let preservesOutlineViewport = previousActiveContainerId == snapshot.activeContainerId
			&& previousFocusedSectionId == snapshot.focusedSectionId
		let outlineOrigin = preservesOutlineViewport
			? navigatorOutline.enclosingScrollView?.contentView.bounds.origin : nil

		navigatorSnapshot = snapshot
		applyingNavigatorSnapshot = true
		if containerChanged {
			changesInputRevision = snapshot.filter?.revision ?? 0
			if changesFilter.currentEditor() === window.firstResponder || searchControls.currentEditor != nil { window.makeFirstResponder(navigatorOutline) }
		}
		searchControls.apply(snapshot.search)
		changesFilter.isHidden = navigatorFilterPrefix == nil
		let filterSurface = navigatorFilterPrefix == "scm" ? "changes" : navigatorFilterPrefix ?? "changes"
		changesFilter.setAccessibilityIdentifier("tucode.\(filterSurface).filter")
		changesFilter.placeholderString = "Filter"
		if let filter = snapshot.filter, (filter.revision ?? 0) >= changesInputRevision,
			changesFilter.stringValue != filter.value { changesFilter.stringValue = filter.value }
		if snapshot.filter?.visible == true && !filterWasActive,
			changesFilter.currentEditor() !== window.firstResponder {
			window.makeFirstResponder(changesFilter)
			// Match ViewRootBox.open: preserve the supplied path and type after it.
			(changesFilter.currentEditor() as? NSTextView)?.selectedRange = NSRange(location: changesFilter.stringValue.utf16.count, length: 0)
		}
		if snapshot.filter?.visible != true && filterWasActive && snapshot.filter?.restoreFocus == true { window.makeFirstResponder(navigatorOutline) }
		navigatorContainers = Dictionary(uniqueKeysWithValues: snapshot.containers.map { ($0.id, $0) })
		navigatorSections = Dictionary(uniqueKeysWithValues: snapshot.sections.map { ($0.id, $0) })
		navigatorContainerBarWidth.constant = CGFloat(snapshot.containers.count * 30 + 4)

		var containerData = NSDiffableDataSourceSnapshot<String, String>()
		containerData.appendSections(["containers"])
		containerData.appendItems(snapshot.containers.map(\.id), toSection: "containers")
		let currentContainerIds = Set(snapshot.containers.map(\.id))
		// Keep the clicked button alive across focus/filter updates between mouse-down
		// and mouse-up. Reload selection paint only when the active container changes.
		let selectionChanged = previousActiveContainerId != snapshot.activeContainerId
			? [previousActiveContainerId, snapshot.activeContainerId].compactMap { $0 }.filter(currentContainerIds.contains) : []
		let changedContainers = Array(Set(snapshot.containers.compactMap { previousContainers[$0.id] == $0 ? nil : $0.id }
			.filter { previousContainers[$0] != nil } + selectionChanged))
		if !changedContainers.isEmpty { containerData.reloadItems(changedContainers) }
		if !changedContainers.isEmpty || navigatorContainerDataSource.snapshot().itemIdentifiers != containerData.itemIdentifiers {
			navigatorContainerDataSource.apply(containerData, animatingDifferences: false)
		}

		var sectionData = NSDiffableDataSourceSnapshot<String, String>()
		sectionData.appendSections(["sections"])
		sectionData.appendItems(snapshot.sections.map(\.id), toSection: "sections")
		let changedSections = snapshot.sections.compactMap { previousSections[$0.id] == $0 ? nil : $0.id }
			.filter { previousSections[$0] != nil }
		if !changedSections.isEmpty { sectionData.reloadItems(changedSections) }
		navigatorSectionDataSource.apply(sectionData, animatingDifferences: false)
		let showsSectionHeaders = snapshot.sections.count > 1
		navigatorSectionHeight.constant = showsSectionHeaders ? 38 : 0
		navigatorSectionScroll.isHidden = !showsSectionHeaders

		select(snapshot.focusedSectionId, in: navigatorSectionTable, dataSource: navigatorSectionDataSource)
		let update = snapshot.outline
		navigatorOutlineData.apply(prepared, to: navigatorOutline)
		if let focusedOutlineId, let item = navigatorOutlineData.items[focusedOutlineId] {
			let row = navigatorOutline.row(forItem: item)
			if row >= 0 {
				navigatorOutline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
				if shouldRevealOutlineFocus { navigatorOutline.scrollRowToVisible(row) }
			}
		} else {
			navigatorOutline.deselectAll(nil)
		}
		if !shouldRevealOutlineFocus, (!update.rows.isEmpty || !prepared.differences.isEmpty), let outlineOrigin,
			let scrollView = navigatorOutline.enclosingScrollView {
			navigatorOutline.layoutSubtreeIfNeeded()
			scrollView.contentView.scroll(to: outlineOrigin)
			scrollView.reflectScrolledClipView(scrollView.contentView)
		}
		applyingNavigatorSnapshot = false
		if outlineHadFocus && snapshot.filter?.visible != true { window.makeFirstResponder(navigatorOutline) }
	}

	private func outlineId(_ item: Any?) -> String? {
		(item as? NavigatorOutlineItem)?.id
	}

	func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
		guard let id = outlineId(item), let record = navigatorOutlineData.rows[id] else { return nil }
		let identifier = NSUserInterfaceItemIdentifier("outline-row")
		let cell = outlineView.makeView(withIdentifier: identifier, owner: self) as? NavigatorOutlineCell ?? {
			let value = NavigatorOutlineCell()
			value.identifier = identifier
			let icon = NSImageView()
			icon.translatesAutoresizingMaskIntoConstraints = false
			icon.imageScaling = .scaleProportionallyDown
			let label = NSTextField(labelWithString: "")
			label.translatesAutoresizingMaskIntoConstraints = false
			label.lineBreakMode = .byTruncatingMiddle
			value.imageView = icon
			value.textField = label
			value.statusField.translatesAutoresizingMaskIntoConstraints = false
			value.statusField.alignment = .right
			value.statusField.font = .systemFont(ofSize: 11, weight: .medium)
			value.statusField.setContentCompressionResistancePriority(.required, for: .horizontal)
			value.addSubview(icon)
			value.addSubview(label)
			value.addSubview(value.statusField)
			NSLayoutConstraint.activate([
				icon.leadingAnchor.constraint(equalTo: value.leadingAnchor, constant: 2),
				icon.centerYAnchor.constraint(equalTo: value.centerYAnchor),
				icon.widthAnchor.constraint(equalToConstant: 16),
				icon.heightAnchor.constraint(equalToConstant: 16),
				label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 4),
				label.trailingAnchor.constraint(equalTo: value.statusField.leadingAnchor, constant: -6),
				value.statusField.trailingAnchor.constraint(equalTo: value.trailingAnchor, constant: -4),
				value.statusField.centerYAnchor.constraint(equalTo: value.centerYAnchor),
				label.centerYAnchor.constraint(equalTo: value.centerYAnchor)
			])
			return value
		}()
		cell.projectedText = record.render
		cell.sourcePreview = record.kind == "search-match"
		cell.textField?.setAccessibilityIdentifier("tucode.navigator.outline.row.\(id)")
		cell.statusField.stringValue = record.status ?? ""
		cell.statusField.textColor = record.statusColor.map(nsColor) ?? .secondaryLabelColor
		cell.statusField.setAccessibilityIdentifier("tucode.navigator.outline.status.\(id)")
		cell.projectedFont = .systemFont(ofSize: 12, weight: record.expandable ? .medium : .regular)
		cell.keepProjectedTextVisible()
		cell.imageView?.image = cell.sourcePreview ? nil : record.icon == "diff" ? changesDocumentImage()
			: NativeFileIcon.image(resource: record.resource, label: record.render.accessibleLabel,
				isDirectory: record.isDirectory ?? record.expandable, pointSize: 13, theme: record.fileIconTheme, languageID: record.languageId)
		cell.imageView?.contentTintColor = record.icon == "diff" ? .systemBlue : nil
		cell.setAccessibilityIdentifier("tucode.navigator.outline.row.\(id)")
		cell.setAccessibilityLabel(record.render.accessibleLabel)
		return cell
	}

	func outlineView(_ outlineView: NSOutlineView, shouldExpandItem item: Any) -> Bool {
		guard !applyingNavigatorSnapshot, let id = outlineId(item) else { return true }
		sendNavigatorEvent(type: "outline-toggle", id: id, expanded: true)
		return false
	}

	func outlineView(_ outlineView: NSOutlineView, shouldCollapseItem item: Any) -> Bool {
		guard !applyingNavigatorSnapshot, let id = outlineId(item) else { return true }
		sendNavigatorEvent(type: "outline-toggle", id: id, expanded: false)
		return false
	}

	func outlineViewSelectionDidChange(_ notification: Notification) {
		guard !applyingNavigatorSnapshot, navigatorOutline.selectedRow >= 0,
			let id = outlineId(navigatorOutline.item(atRow: navigatorOutline.selectedRow)) else { return }
		sendNavigatorEvent(type: "outline-focus", id: id)
	}

	@objc private func activateClickedOutlineRow() {
		let currentId = navigatorOutline.clickedRow >= 0 ? outlineId(navigatorOutline.item(atRow: navigatorOutline.clickedRow)) : nil
		guard let id = navigatorOutline.mouseDownItemId ?? currentId else { return }
		sendNavigatorEvent(type: "outline-open", id: id)
	}

	private func nsColor(_ color: RenderColor) -> NSColor {
		let value = color.rgba
		return NSColor(red: CGFloat(value.r) / 255, green: CGFloat(value.g) / 255,
			blue: CGFloat(value.b) / 255, alpha: CGFloat(value.a))
	}

	@objc private func navigatorContainerPressed(_ sender: NSButton) {
		guard navigatorSnapshot != nil, let id = sender.identifier?.rawValue else { return }
		sendNavigatorEvent(type: "select-container", id: id)
	}

	private func select(_ id: String?, in table: NSTableView,
		dataSource: NSTableViewDiffableDataSource<String, String>) {
		guard let id else { table.deselectAll(nil); return }
		guard let row = dataSource.row(forItemIdentifier: id) else { table.deselectAll(nil); return }
		table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
		table.scrollRowToVisible(row)
	}

	func tableViewSelectionDidChange(_ notification: Notification) {
		guard let table = notification.object as? NSTableView else { return }
		if table === navigatorOutline { return }
		guard table === navigatorSectionTable, !applyingNavigatorSnapshot, table.selectedRow >= 0,
			let id = navigatorSectionDataSource.itemIdentifier(forRow: table.selectedRow) else { return }
		sendNavigatorEvent(type: "focus-section", id: id)
	}

	func controlTextDidChange(_ notification: Notification) {
		guard notification.object as? NSSearchField === changesFilter, !applyingNavigatorSnapshot, let prefix = navigatorFilterPrefix else { return }
		changesInputRevision += 1
		sendNavigatorEvent(type: "\(prefix)-filter-change", value: changesFilter.stringValue, revision: changesInputRevision)
	}

	func controlTextDidBeginEditing(_ notification: Notification) {
		guard notification.object as? NSSearchField === changesFilter, !applyingNavigatorSnapshot, let prefix = navigatorFilterPrefix else { return }
		sendNavigatorEvent(type: "\(prefix)-filter-open")
	}

	func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
		guard control === changesFilter, let prefix = navigatorFilterPrefix else { return false }
		switch commandSelector {
		case #selector(NSResponder.cancelOperation(_:)): sendNavigatorEvent(type: "\(prefix)-filter-cancel")
		case #selector(NSResponder.insertNewline(_:)): sendNavigatorEvent(type: "\(prefix)-filter-commit")
		case #selector(NSResponder.insertTab(_:)): sendNavigatorEvent(type: "\(prefix)-filter-complete", direction: "next")
		case #selector(NSResponder.insertBacktab(_:)): sendNavigatorEvent(type: "\(prefix)-filter-complete", direction: "previous")
		default: return false
		}
		return true
	}

	func controlTextDidEndEditing(_ notification: Notification) {
		guard notification.object as? NSSearchField === changesFilter, !changesFilter.isHidden,
			!applyingNavigatorSnapshot, let prefix = navigatorFilterPrefix else { return }
		sendNavigatorEvent(type: "\(prefix)-filter-cancel", focused: false)
	}

	private var navigatorFilterPrefix: String? {
		switch navigatorSnapshot?.activeContainerId {
		case "workbench.view.explorer": return "explorer"
		case "workbench.view.scm": return "scm"
		case "workbench.view.search": return "search"
		default: return nil
		}
	}

	private func sendNavigatorEvent(type: String, id: String? = nil, expanded: Bool? = nil, focused: Bool? = nil, value: String? = nil, direction: String? = nil, revision: Int? = nil) {
		guard navigatorSnapshot != nil else { return }
		sendNativeInput(type: "navigatorEvent", payload: NavigatorIntent(
			eventType: type, id: id, expanded: expanded, focused: focused, value: value, direction: direction, revision: revision
		))
	}

	private func sendNativeInput<Payload: Encodable>(type: String, payload: Payload) {
		do {
			let payloadData = try JSONEncoder().encode(payload)
			let payloadObject = try JSONSerialization.jsonObject(with: payloadData)
			let data = try JSONSerialization.data(withJSONObject: ["type": type, "payload": payloadObject])
			let message = String(decoding: data, as: UTF8.self)
			if webEditorReady { evaluateNativeMessage(message) }
			else { pendingNativeMessages.append(message) }
		} catch {
			fail(error.localizedDescription)
		}
	}

	private func evaluateNativeMessage(_ message: String) {
		editorAreaView.webView.evaluateJavaScript("globalThis.__tucodeNativeInput?.(\(message));") {
			[weak self] _, error in
			if let error { self?.fail(error.localizedDescription) }
		}
	}

	private func fail(_ message: String) {
		let title = webEditorReady
			? "The VS Code editor encountered an error."
			: "The VS Code service could not start."
		errorLabel.stringValue = "\(title)\n\(message)"
		errorLabel.isHidden = false
	}

}

let application = NSApplication.shared
let delegate = ApplicationController()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
