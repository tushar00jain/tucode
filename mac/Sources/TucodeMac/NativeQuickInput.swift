import AppKit

/// Native events identify a VS Code row; only a returned snapshot changes selection.
private final class QuickInputTable: NSTableView {
	var onHover: ((Int) -> Void)?
	var onActivate: ((Int) -> Void)?
	private var hoverTracking: NSTrackingArea?

	override var acceptsFirstResponder: Bool { false }

	override func updateTrackingAreas() {
		super.updateTrackingAreas()
		if let hoverTracking { removeTrackingArea(hoverTracking) }
		let tracking = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self)
		addTrackingArea(tracking)
		hoverTracking = tracking
	}

	override func mouseMoved(with event: NSEvent) {
		onHover?(row(at: convert(event.locationInWindow, from: nil)))
	}

	override func mouseDown(with event: NSEvent) {
		onActivate?(row(at: convert(event.locationInWindow, from: nil)))
	}
}

/// The field lives in the native toolbar; the results list lives in its anchored popover.
final class NativeQuickInputField: NSSearchField, NSSearchFieldDelegate,
	NSTableViewDataSource, NSTableViewDelegate, NSPopoverDelegate {
	var onOpen: (() -> Void)?
	var onBeginInteraction: (() -> Void)?
	var onIntent: ((QuickInputIntent) -> Void)?
	private var snapshot: QuickInputSnapshot?
	private var applyingSnapshot = false
	private let results = QuickInputTable()
	private let popover = NSPopover()
	private var resultsWidth: NSLayoutConstraint!
	private var resultsHeight: NSLayoutConstraint!
	private var outsideClickMonitor: Any?
	private var deactivateObserver: NSObjectProtocol?

	init() {
		super.init(frame: .zero)
		delegate = self
		target = self
		action = #selector(valueChanged)
		sendsSearchStringImmediately = true
		controlSize = .extraLarge
		font = .systemFont(ofSize: NSFont.systemFontSize(for: controlSize))
		cell?.usesSingleLineMode = true
		focusRingType = .none
		placeholderString = "Search Files and Commands"
		translatesAutoresizingMaskIntoConstraints = false
		setAccessibilityIdentifier("tucode.quickInput.field")

		results.headerView = nil
		results.style = .inset
		results.backgroundColor = .clear
		results.allowsEmptySelection = true
		results.dataSource = self
		results.delegate = self
		results.setAccessibilityIdentifier("tucode.quickInput.results")
		let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result"))
		column.resizingMask = .autoresizingMask
		results.addTableColumn(column)
		results.onHover = { [weak self] in self?.focusRow($0) }
		results.onActivate = { [weak self] in self?.activateRow($0) }
		let scroll = NSScrollView()
		scroll.documentView = results
		scroll.drawsBackground = false
		scroll.hasVerticalScroller = true
		scroll.autohidesScrollers = true
		scroll.borderType = .noBorder
		scroll.translatesAutoresizingMaskIntoConstraints = false
		let controller = NSViewController()
		controller.view = NSView()
		controller.view.setAccessibilityElement(true)
		controller.view.setAccessibilityRole(.group)
		controller.view.setAccessibilityIdentifier("tucode.quickInput.popover")
		controller.view.addSubview(scroll)
		resultsWidth = controller.view.widthAnchor.constraint(equalToConstant: 368)
		resultsHeight = controller.view.heightAnchor.constraint(equalToConstant: 230)
		NSLayoutConstraint.activate([
			resultsWidth, resultsHeight,
			scroll.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor),
			scroll.trailingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.trailingAnchor),
			scroll.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor),
			scroll.bottomAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.bottomAnchor)
		])
		popover.contentViewController = controller
		popover.hasFullSizeContent = true
		// The input is in the parent window, so transient dismissal would close while typing there.
		popover.behavior = .applicationDefined
		popover.animates = false
		popover.delegate = self
		outsideClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] event in
			guard let self, self.popover.isShown else { return event }
			if event.type == .keyDown {
				if self.snapshot?.canSelectMany == true, event.characters == " ", self.stringValue.isEmpty,
					self.currentEditor() === self.window?.firstResponder,
					let index = self.snapshot?.rows.firstIndex(where: { $0.focused }) {
					self.activateRow(index); return nil
				}
				return event
			}
			if event.window !== self.popover.contentViewController?.view.window,
				!(event.window === self.window && self.bounds.contains(self.convert(event.locationInWindow, from: nil))) {
				self.send("focusChanged", focused: false)
			}
			return event
		}
		deactivateObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification,
			object: nil, queue: .main) { [weak self] _ in self?.send("focusChanged", focused: false) }
	}

	deinit {
		if let outsideClickMonitor { NSEvent.removeMonitor(outsideClickMonitor) }
		if let deactivateObserver { NotificationCenter.default.removeObserver(deactivateObserver) }
	}

	required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

	override func mouseDown(with event: NSEvent) {
		if snapshot == nil { onOpen?() }
		super.mouseDown(with: event)
	}

	override func layout() {
		super.layout()
		if popover.isShown, let container = superview {
			sizeResults()
			popover.positioningRect = convert(bounds, to: container)
		}
	}

	func apply(_ next: QuickInputSnapshot) {
		guard next.terminal == "open" else {
			if snapshot?.sessionId == next.sessionId { hideSuggestions() }
			return
		}
		let opening = snapshot?.sessionId != next.sessionId
		let rowsChanged = snapshot?.rows.elementsEqual(next.rows, by: { old, new in
			old.id == new.id && old.separator == new.separator && old.label == new.label
				&& old.description == new.description && old.detail == new.detail && old.selected == new.selected
		}) != true
		snapshot = next
		applyingSnapshot = true
		defer { applyingSnapshot = false }
		placeholderString = next.placeholder
		isEnabled = next.enabled
		// Result snapshots carry model state, but only opening initializes the native editor.
		if opening { stringValue = next.value }
		if rowsChanged { results.reloadData() }
		if let focused = next.rows.firstIndex(where: { $0.focused }) {
			if results.selectedRow != focused {
				results.selectRowIndexes(IndexSet(integer: focused), byExtendingSelection: false)
				results.scrollRowToVisible(focused)
			}
		} else { results.deselectAll(nil) }
		if opening { onBeginInteraction?() }
		if next.hideList { popover.close() }
		else if window?.isVisible == true, let container = superview {
			sizeResults()
			if !popover.isShown {
				// NSSearchField exposes its cell as a leaf accessibility element. Anchor to
				// the containing group so AppKit can expose the popover alongside the field.
				popover.show(relativeTo: convert(bounds, to: container), of: container,
					preferredEdge: container.isFlipped ? .maxY : .minY)
				popover.contentViewController?.view.window?.acceptsMouseMovedEvents = true
				window?.makeKey()
			}
		}
		if opening {
			window?.makeFirstResponder(self)
			applySelection(next.valueSelection)
		}
	}

	/// Explicit service writes, distinct from the echo of native typing.
	func apply(_ update: QuickInputUpdate) {
		guard snapshot?.sessionId == update.sessionId else { return }
		applyingSnapshot = true
		defer { applyingSnapshot = false }
		if let value = update.value, stringValue != value { stringValue = value }
		applySelection(update.selection)
	}

	private func applySelection(_ selection: [Int]?) {
		guard let selection, selection.count == 2 else { return }
		let start = max(0, min(selection[0], stringValue.utf16.count))
		let end = max(start, min(selection[1], stringValue.utf16.count))
		(currentEditor() as? NSTextView)?.selectedRange = NSRange(location: start, length: end - start)
	}

	private func sizeResults() {
		let height = (snapshot?.rows ?? []).reduce(CGFloat(0)) { $0 + rowHeight($1) + results.intercellSpacing.height }
		let size = NSSize(width: bounds.width, height: min(340, max(230, height + 24)))
		resultsWidth.constant = size.width
		resultsHeight.constant = size.height
		if popover.contentSize != size { popover.contentSize = size }
	}

	func hideSuggestions() {
		snapshot = nil
		popover.close()
		abortEditing()
		stringValue = ""
		placeholderString = "Search Files and Commands"
		isEnabled = true
	}

	func popoverDidClose(_ notification: Notification) {
		if !applyingSnapshot { send("cancel") }
	}

	func numberOfRows(in tableView: NSTableView) -> Int { snapshot?.rows.count ?? 0 }

	func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
		guard let record = snapshot?.rows[row] else { return false }
		return record.separator && !record.label.isEmpty
	}

	func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
		snapshot?.rows[row].separator == false
	}

	private func rowHeight(_ row: QuickInputRow) -> CGFloat {
		row.separator ? (row.label.isEmpty ? 8 : 24) : row.description?.isEmpty == false ? 44 : 28
	}

	func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
		guard let record = snapshot?.rows[row] else { return 28 }
		return rowHeight(record)
	}

	func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
		guard let record = snapshot?.rows[row] else { return nil }
		if record.separator && record.label.isEmpty {
			let cell = NSTableCellView()
			let divider = NSBox(frame: NSRect(x: 0, y: 0, width: 100, height: 1))
			divider.boxType = .separator
			divider.translatesAutoresizingMaskIntoConstraints = false
			cell.addSubview(divider)
			NSLayoutConstraint.activate([
				divider.leadingAnchor.constraint(equalTo: cell.leadingAnchor),
				divider.trailingAnchor.constraint(equalTo: cell.trailingAnchor),
				divider.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
				divider.heightAnchor.constraint(equalToConstant: 1)
			])
			return cell
		}
		let label = NSTextField(labelWithString: record.label)
		label.font = record.separator ? .systemFont(ofSize: 11, weight: .semibold) : .systemFont(ofSize: 13)
		label.textColor = record.separator ? .secondaryLabelColor : .labelColor
		label.lineBreakMode = .byTruncatingTail
		let cell = NSTableCellView()
		cell.textField = label
		let stack = NSStackView(views: [label])
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 1
		if let description = record.description, !description.isEmpty {
			let detail = NSTextField(labelWithString: description)
			detail.font = .systemFont(ofSize: 11)
			detail.textColor = .secondaryLabelColor
			detail.lineBreakMode = .byTruncatingMiddle
			stack.addArrangedSubview(detail)
			detail.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true
		}
		stack.translatesAutoresizingMaskIntoConstraints = false
		cell.addSubview(stack)
		NSLayoutConstraint.activate([
			stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: snapshot?.canSelectMany == true && !record.separator ? 24 : 0),
			stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor),
			stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
			label.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor)
		])
		if snapshot?.canSelectMany == true && !record.separator {
			let check = NSButton(checkboxWithTitle: "", target: self, action: #selector(toggleSelection(_:)))
			check.tag = row
			check.state = record.selected == true ? .on : .off
			check.setAccessibilityLabel(record.label)
			check.translatesAutoresizingMaskIntoConstraints = false
			cell.addSubview(check)
			NSLayoutConstraint.activate([check.leadingAnchor.constraint(equalTo: cell.leadingAnchor), check.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
		}
		cell.toolTip = record.detail
		return cell
	}

	func tableViewSelectionDidChange(_ notification: Notification) {
		if !applyingSnapshot { focusRow(results.selectedRow) }
	}

	func focusRow(_ index: Int) {
		guard let rows = snapshot?.rows, rows.indices.contains(index), !rows[index].separator,
			!rows[index].focused else { return }
		send("focus", id: rows[index].id)
	}

	func activateRow(_ index: Int) {
		guard let rows = snapshot?.rows, rows.indices.contains(index), !rows[index].separator else { return }
		if snapshot?.canSelectMany == true { send("select", id: rows[index].id, selected: rows[index].selected != true) }
		else { send("activate", id: rows[index].id) }
	}

	@objc private func toggleSelection(_ sender: NSButton) { activateRow(sender.tag) }

	@objc private func valueChanged() {
		guard !applyingSnapshot else { return }
		guard let snapshot else { return }
		let selection = (currentEditor() as? NSTextView)?.selectedRange
		onIntent?(QuickInputIntent(selection: selection.map { [$0.location, NSMaxRange($0)] },
			sessionId: snapshot.sessionId, eventType: "value", value: stringValue, id: nil, direction: nil))
	}

	func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
		switch selector {
		case #selector(NSResponder.cancelOperation(_:)): send("cancel")
		case #selector(NSResponder.insertNewline(_:)): send("accept")
		case #selector(NSResponder.moveDown(_:)): send("navigate", direction: "next")
		case #selector(NSResponder.moveUp(_:)): send("navigate", direction: "previous")
		default: return false
		}
		return true
	}

	private func send(_ type: String, value: String? = nil, id: String? = nil, direction: String? = nil, focused: Bool? = nil, selected: Bool? = nil) {
		guard let snapshot else { return }
		onIntent?(QuickInputIntent(selected: selected, sessionId: snapshot.sessionId, eventType: type, value: value, id: id, direction: direction, focused: focused))
	}
}
