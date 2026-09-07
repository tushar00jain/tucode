import AppKit
import WebKit

private class EditorTabButton: NSButton {
	// The containing tab owns context-menu gestures, including clicks on either button.
	override func rightMouseDown(with event: NSEvent) { superview?.rightMouseDown(with: event) }
	override func mouseDown(with event: NSEvent) {
		if event.modifierFlags.contains(.control) { superview?.mouseDown(with: event) }
		else { super.mouseDown(with: event) }
	}
}

// Let NSCollectionView track selection and dragging from the label. The close button
// keeps normal NSButton tracking, and accessibility presses still use its target/action.
private final class EditorTabSelectButton: EditorTabButton {
	override func mouseDown(with event: NSEvent) { superview?.mouseDown(with: event) }
}

private final class EditorTabItemView: NSView {
	private(set) var id = ""
	private let selectButton = EditorTabSelectButton()
	private let closeButton = EditorTabButton()
	fileprivate private(set) var active = false
	var showsSeparator = false { didSet { needsDisplay = true } }
	private var trackingArea: NSTrackingArea?
	private var paintedTab: EditorTabData?
	var onSelect: (() -> Void)?
	var onClose: (() -> Void)?
	var onContextMenu: ((NSPoint) -> Void)?

	override func rightMouseDown(with event: NSEvent) { onContextMenu?(event.locationInWindow) }
	override func mouseDown(with event: NSEvent) {
		if event.modifierFlags.contains(.control) { onContextMenu?(event.locationInWindow); return }
		super.mouseDown(with: event)
	}

	override init(frame frameRect: NSRect) {
		super.init(frame: frameRect)
		wantsLayer = true
		selectButton.isBordered = false
		selectButton.alignment = .center
		selectButton.font = .systemFont(ofSize: 11, weight: .medium)
		selectButton.imagePosition = .imageLeading
		selectButton.imageHugsTitle = true
		selectButton.imageScaling = .scaleNone
		selectButton.lineBreakMode = .byTruncatingMiddle
		selectButton.target = self
		selectButton.action = #selector(selectTab)
		closeButton.title = ""
		closeButton.isBordered = false
		closeButton.imageScaling = .scaleProportionallyDown
		closeButton.contentTintColor = .secondaryLabelColor
		closeButton.alphaValue = 0
		closeButton.target = self
		closeButton.action = #selector(closeTab)
		for child in [selectButton, closeButton] {
			child.translatesAutoresizingMaskIntoConstraints = false
			addSubview(child)
		}
		NSLayoutConstraint.activate([
			selectButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
			selectButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
			selectButton.topAnchor.constraint(equalTo: topAnchor),
			selectButton.bottomAnchor.constraint(equalTo: bottomAnchor),
			closeButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
			closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
			closeButton.widthAnchor.constraint(equalToConstant: 16),
			closeButton.heightAnchor.constraint(equalToConstant: 16)
		])
	}

	required init?(coder: NSCoder) { nil }

	override func updateTrackingAreas() {
		super.updateTrackingAreas()
		if let trackingArea { removeTrackingArea(trackingArea) }
		let area = NSTrackingArea(rect: bounds, options: [.activeInKeyWindow, .mouseEnteredAndExited],
			owner: self, userInfo: nil)
		addTrackingArea(area)
		trackingArea = area
	}

	override func mouseEntered(with event: NSEvent) { closeButton.alphaValue = 1 }
	override func mouseExited(with event: NSEvent) { closeButton.alphaValue = 0 }

	func update(_ tab: EditorTabData) {
		guard paintedTab != tab else { return }
		paintedTab = tab
		id = tab.id
		active = tab.active
		needsDisplay = true
		selectButton.title = Self.visibleLabel(tab.label) + (tab.dirty ? " •" : "")
		selectButton.toolTip = tab.tooltip
		selectButton.contentTintColor = tab.active
			? NSColor(calibratedWhite: 0.84, alpha: 1)
			: NSColor(calibratedWhite: 0.66, alpha: 1)
		selectButton.image = NativeFileIcon.image(resource: tab.resource, label: tab.label, theme: tab.fileIconTheme, languageID: tab.languageId)
		selectButton.setAccessibilitySelected(tab.active)
		selectButton.setAccessibilityIdentifier("tucode.editor.tab.\(tab.id)")
		selectButton.setAccessibilityLabel(tab.label)
		closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close \(tab.label)")
		closeButton.setAccessibilityIdentifier("tucode.editor.tab.close.\(tab.id)")
		closeButton.setAccessibilityLabel("Close \(tab.label)")
	}

	override func draw(_ dirtyRect: NSRect) {
		super.draw(dirtyRect)
		if active {
			let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 2), xRadius: 12, yRadius: 12)
			NSColor(srgbRed: 84 / 255, green: 84 / 255, blue: 84 / 255, alpha: 1).setFill()
			pill.fill()
			NSColor(srgbRed: 115 / 255, green: 115 / 255, blue: 115 / 255, alpha: 1).setStroke()
			pill.lineWidth = 1
			pill.stroke()
		} else if showsSeparator {
			NSColor(srgbRed: 76 / 255, green: 75 / 255, blue: 75 / 255, alpha: 1).setFill()
			NSRect(x: bounds.maxX - 1, y: 7, width: 1, height: 15).fill()
		}
	}

	private static func visibleLabel(_ label: String) -> String {
		guard !label.hasPrefix(".") else { return label }
		let stem = (label as NSString).deletingPathExtension
		return stem.isEmpty ? label : stem
	}

	@objc private func selectTab() { onSelect?() }
	@objc private func closeTab() { onClose?() }
}

private final class EditorTabCollectionItem: NSCollectionViewItem {
	override func loadView() { view = EditorTabItemView(frame: .zero) }

	override var draggingImageComponents: [NSDraggingImageComponent] {
		guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return [] }
		view.cacheDisplay(in: view.bounds, to: bitmap)
		let image = NSImage(size: view.bounds.size)
		image.addRepresentation(bitmap)
		let component = NSDraggingImageComponent(key: .icon)
		component.contents = image
		component.frame = view.bounds
		return [component]
	}
}

/// AppKit owns the horizontal layout, mouse tracking, autoscroll and move animations.
/// The local order is only a drag preview; the editor group owns the committed order.
private final class EditorTabCollectionView: NSCollectionView {
	var railRect = NSRect.zero { didSet { needsDisplay = true } }
	override func draw(_ dirtyRect: NSRect) {
		super.draw(dirtyRect)
		guard !railRect.isEmpty else { return }
		NSColor(srgbRed: 52 / 255, green: 51 / 255, blue: 51 / 255, alpha: 1).setFill()
		NSBezierPath(roundedRect: railRect, xRadius: 14, yRadius: 14).fill()
	}
}

// Synchronous AppKit data-source/delegate callbacks need a native adapter. It does
// not choose editors or commit their order: all actions go through the existing bridge.
private final class EditorTabRail: NSObject, NSCollectionViewDataSource, NSCollectionViewDelegate {
	let collectionView = EditorTabCollectionView()
	private static let tabType = NSPasteboard.PasteboardType("com.tucode.editor-tab")
	private static let itemID = NSUserInterfaceItemIdentifier("EditorTab")
	private let flow = NSCollectionViewFlowLayout()
	private var displayTabs: [EditorTabData] = []
	private var projectedTabs: [EditorTabData] = []
	private var paintedViewport = NSSize(width: -1, height: -1)
	private var draggedID: String?
	private var acceptedDrop = false
	private var groupId = 0
	private var onInput: ((EditorTabIntent) -> Void)?
	var isReordering: Bool { draggedID != nil }

	override init() {
		super.init()
		flow.scrollDirection = .horizontal
		flow.minimumLineSpacing = 0
		flow.minimumInteritemSpacing = 0
		collectionView.collectionViewLayout = flow
		collectionView.backgroundColors = [.clear]
		collectionView.isSelectable = true
		collectionView.allowsMultipleSelection = false
		collectionView.allowsEmptySelection = true
		collectionView.dataSource = self
		collectionView.delegate = self
		collectionView.register(EditorTabCollectionItem.self, forItemWithIdentifier: Self.itemID)
		collectionView.registerForDraggedTypes([Self.tabType])
		collectionView.setDraggingSourceOperationMask(.move, forLocal: true)
		collectionView.setDraggingSourceOperationMask([], forLocal: false)
	}

	func apply(_ newTabs: [EditorTabData], groupId: Int, viewportWidth: CGFloat, viewportHeight: CGFloat,
		onInput: @escaping (EditorTabIntent) -> Void) {
		if self.groupId != groupId { cancelReordering() }
		self.groupId = groupId
		self.onInput = onInput
		let viewport = NSSize(width: viewportWidth, height: viewportHeight)
		let orderChanged = projectedTabs.map(\.id) != newTabs.map(\.id)
		let resized = paintedViewport != viewport
		guard projectedTabs != newTabs || resized else { return }
		if orderChanged || resized { cancelReordering() }
		let displayOrderChanged = displayTabs.map(\.id) != newTabs.map(\.id)
		projectedTabs = newTabs
		if isReordering {
			let byID = Dictionary(uniqueKeysWithValues: newTabs.map { ($0.id, $0) })
			displayTabs = displayTabs.compactMap { byID[$0.id] }
		} else { displayTabs = newTabs }
		let available = max(0, viewportWidth - 20)
		flow.itemSize = NSSize(width: displayTabs.isEmpty ? 116 : min(214, max(116, available / CGFloat(displayTabs.count))), height: 28)
		flow.sectionInset = NSEdgeInsets(top: 11, left: 16, bottom: 10, right: 4)
		if resized {
			paintedViewport = viewport
			collectionView.setFrameSize(viewport)
		}
		if orderChanged && displayOrderChanged { collectionView.reloadData() }
		else { refreshVisibleItems() }
		collectionView.selectionIndexPaths = Set(displayTabs.indices.filter { displayTabs[$0].active }.map { IndexPath(item: $0, section: 0) })
		collectionView.needsLayout = true
		collectionView.layoutSubtreeIfNeeded()
		collectionView.railRect = NSRect(x: flow.sectionInset.left, y: flow.sectionInset.top,
			width: flow.itemSize.width * CGFloat(displayTabs.count), height: flow.itemSize.height)
	}

	func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int { displayTabs.count }

	func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
		let item = collectionView.makeItem(withIdentifier: Self.itemID, for: indexPath)
		configure(item, at: indexPath)
		return item
	}

	private func configure(_ item: NSCollectionViewItem, at indexPath: IndexPath) {
		guard displayTabs.indices.contains(indexPath.item), let view = item.view as? EditorTabItemView else { return }
		let tab = displayTabs[indexPath.item]
		view.update(tab)
		view.showsSeparator = !isReordering && indexPath.item + 1 < displayTabs.count && !displayTabs[indexPath.item + 1].active
		view.onSelect = { [weak self] in self?.send("select", id: tab.id) }
		view.onClose = { [weak self] in self?.send("close", id: tab.id) }
		view.onContextMenu = { [weak self] point in self?.send("context-menu", id: tab.id, anchor: NativeMenuAnchor(point)) }
	}

	private func refreshVisibleItems() {
		for item in collectionView.visibleItems() {
			if let indexPath = collectionView.indexPath(for: item) { configure(item, at: indexPath) }
		}
	}

	func collectionView(_ collectionView: NSCollectionView, didSelectItemsAt indexPaths: Set<IndexPath>) {
		if let index = indexPaths.first?.item, displayTabs.indices.contains(index) { send("select", id: displayTabs[index].id) }
	}

	func frameForTab(_ id: String) -> NSRect? {
		guard let index = displayTabs.firstIndex(where: { $0.id == id }) else { return nil }
		return collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame
	}

	func collectionView(_ collectionView: NSCollectionView, pasteboardWriterForItemAt indexPath: IndexPath) -> NSPasteboardWriting? {
		guard displayTabs.count > 1, displayTabs.indices.contains(indexPath.item) else { return nil }
		let item = NSPasteboardItem()
		item.setString(displayTabs[indexPath.item].id, forType: Self.tabType)
		return item
	}

	func collectionView(_ collectionView: NSCollectionView, draggingSession session: NSDraggingSession,
		willBeginAt screenPoint: NSPoint, forItemsAt indexPaths: Set<IndexPath>) {
		guard let index = indexPaths.first?.item, displayTabs.indices.contains(index) else { return }
		draggedID = displayTabs[index].id
		acceptedDrop = false
		session.animatesToStartingPositionsOnCancelOrFail = true
		refreshVisibleItems()
	}

	func collectionView(_ collectionView: NSCollectionView, validateDrop info: NSDraggingInfo,
		proposedIndexPath proposed: AutoreleasingUnsafeMutablePointer<NSIndexPath>, dropOperation: UnsafeMutablePointer<NSCollectionView.DropOperation>) -> NSDragOperation {
		guard (info.draggingSource as? NSCollectionView) === collectionView, let id = draggedID,
			info.draggingPasteboard.string(forType: Self.tabType) == id,
			let oldIndex = displayTabs.firstIndex(where: { $0.id == id }),
			let sourceIndex = projectedTabs.firstIndex(where: { $0.id == id }) else { return [] }
		let point = collectionView.convert(info.draggingLocation, from: nil)
		let index = min(displayTabs.count - 1, max(0, Int((point.x - flow.sectionInset.left) / flow.itemSize.width)))
		if index != oldIndex { movePreview(from: oldIndex, to: index) }
		// AppKit expects an insertion gap in the source order, not the final item index.
		let insertionIndex = index > sourceIndex ? index + 1 : index
		proposed.pointee = IndexPath(item: insertionIndex, section: 0) as NSIndexPath
		dropOperation.pointee = .before
		return .move
	}

	private func movePreview(from oldIndex: Int, to index: Int) {
		displayTabs.insert(displayTabs.remove(at: oldIndex), at: index)
		NSAnimationContext.runAnimationGroup { context in
			context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.16
			collectionView.performBatchUpdates({ self.collectionView.moveItem(at: IndexPath(item: oldIndex, section: 0), to: IndexPath(item: index, section: 0)) })
		}
		refreshVisibleItems()
	}

	func collectionView(_ collectionView: NSCollectionView, acceptDrop info: NSDraggingInfo,
		indexPath: IndexPath, dropOperation: NSCollectionView.DropOperation) -> Bool {
		guard (info.draggingSource as? NSCollectionView) === collectionView, let id = draggedID,
			info.draggingPasteboard.string(forType: Self.tabType) == id,
			let index = displayTabs.firstIndex(where: { $0.id == id }) else { return false }
		acceptedDrop = true
		info.animatesToDestination = true
		if let frame = frameForTab(id) {
			info.enumerateDraggingItems(options: [], for: collectionView, classes: [NSPasteboardItem.self], searchOptions: [:]) { item, _, _ in
				item.draggingFrame = frame
			}
		}
		send("move", id: id, index: index)
		return true
	}

	func collectionView(_ collectionView: NSCollectionView, draggingSession session: NSDraggingSession,
		endedAt screenPoint: NSPoint, dragOperation operation: NSDragOperation) {
		if !acceptedDrop { cancelReordering() }
		draggedID = nil
		refreshVisibleItems()
	}

	private func send(_ type: String, id: String, index: Int? = nil, anchor: NativeMenuAnchor? = nil) {
		onInput?(EditorTabIntent(eventType: type, tabId: id, groupId: groupId, anchor: anchor, index: index))
	}

	func cancelReordering() {
		guard let id = draggedID else { return }
		draggedID = nil
		if !acceptedDrop, let from = displayTabs.firstIndex(where: { $0.id == id }),
			let to = projectedTabs.firstIndex(where: { $0.id == id }), from != to { movePreview(from: from, to: to) }
	}
}

final class EditorAreaView: NSView {
	var onTabInput: ((EditorTabIntent) -> Void)?
	var onNewFile: (() -> Void)?
	let webView: WKWebView

	private let tabScroll = NSScrollView()
	private let addTabButton = NSButton(title: "+", target: nil, action: nil)
	private let tabDocument = EditorTabRail()
	private var tabsById: [String: EditorTabData] = [:]
	private var tabOrder: [String] = []
	private var groupId: Int?

	init(webView: WKWebView) {
		self.webView = webView
		super.init(frame: .zero)
		translatesAutoresizingMaskIntoConstraints = false

		tabScroll.documentView = tabDocument.collectionView
		tabScroll.drawsBackground = false
		tabScroll.borderType = .noBorder
		tabScroll.automaticallyAdjustsContentInsets = false
		tabScroll.hasHorizontalScroller = true
		tabScroll.hasVerticalScroller = false
		tabScroll.autohidesScrollers = true
		tabScroll.scrollerStyle = .overlay
		tabScroll.translatesAutoresizingMaskIntoConstraints = false
		tabScroll.setAccessibilityIdentifier("tucode.editor.tabs")
		addTabButton.isBordered = false
		addTabButton.font = .systemFont(ofSize: 19, weight: .ultraLight)
		addTabButton.contentTintColor = .secondaryLabelColor
		addTabButton.target = self
		addTabButton.action = #selector(newFile)
		addTabButton.toolTip = "New Text File"
		addTabButton.setAccessibilityIdentifier("tucode.editor.newFile")
		addTabButton.setAccessibilityLabel("New Text File")
		addTabButton.translatesAutoresizingMaskIntoConstraints = false

		webView.translatesAutoresizingMaskIntoConstraints = false
		webView.setAccessibilityIdentifier("tucode.editor.contents")
		webView.setValue(false, forKey: "drawsBackground")

		// Establish horizontal orientation before Auto Layout measures the initially empty editor.
		let separator = NSBox(frame: NSRect(x: 0, y: 0, width: 100, height: 1))
		separator.boxType = .separator
		separator.translatesAutoresizingMaskIntoConstraints = false
		for child in [tabScroll, addTabButton, separator, webView] { addSubview(child) }
		NSLayoutConstraint.activate([
			tabScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
			tabScroll.trailingAnchor.constraint(equalTo: addTabButton.leadingAnchor, constant: -4),
			tabScroll.topAnchor.constraint(equalTo: topAnchor),
			tabScroll.heightAnchor.constraint(equalToConstant: 49),
			addTabButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
			addTabButton.centerYAnchor.constraint(equalTo: tabScroll.centerYAnchor),
			addTabButton.widthAnchor.constraint(equalToConstant: 28),
			addTabButton.heightAnchor.constraint(equalToConstant: 28),
			separator.leadingAnchor.constraint(equalTo: leadingAnchor),
			separator.trailingAnchor.constraint(equalTo: trailingAnchor),
			separator.topAnchor.constraint(equalTo: tabScroll.bottomAnchor),
			separator.heightAnchor.constraint(equalToConstant: 1),
			webView.leadingAnchor.constraint(equalTo: leadingAnchor),
			webView.trailingAnchor.constraint(equalTo: trailingAnchor),
			webView.topAnchor.constraint(equalTo: separator.bottomAnchor),
			webView.bottomAnchor.constraint(equalTo: bottomAnchor)
		])
	}

	required init?(coder: NSCoder) { nil }

	@objc private func newFile() { onNewFile?() }

	override func layout() {
		super.layout()
		applyTabs(reveal: tabsById.first(where: { $0.value.active })?.key)
	}

	func load(_ url: URL) {
		webView.load(URLRequest(url: url))
	}

	func apply(_ paint: EditorTabsPaint) {
		groupId = paint.groupId
		if let order = paint.order {
			tabOrder = order
			let liveIds = Set(order)
			tabsById = tabsById.filter { liveIds.contains($0.key) }
		}
		for tab in paint.tabs { tabsById[tab.id] = tab }
		applyTabs(reveal: paint.revealTargetId)
	}

	private func applyTabs(reveal: String? = nil) {
		let tabs = tabOrder.compactMap { tabsById[$0] }
		let clip = tabScroll.contentView
		guard let groupId else { return }
		tabDocument.apply(tabs, groupId: groupId, viewportWidth: clip.bounds.width, viewportHeight: clip.bounds.height,
			onInput: { [weak self] in self?.onTabInput?($0) })
		if !tabDocument.isReordering, let reveal, let active = tabDocument.frameForTab(reveal) {
			let visible = clip.bounds
			var x = visible.origin.x
			if active.minX < visible.minX + 8 { x = active.minX - 8 }
			else if active.maxX > visible.maxX - 8 { x = active.maxX - visible.width + 8 }
			x = min(max(0, tabDocument.collectionView.bounds.width - visible.width), max(0, x))
			if x != visible.origin.x {
				clip.scroll(to: NSPoint(x: x, y: 0))
				tabScroll.reflectScrolledClipView(clip)
			}
		}
	}

}
