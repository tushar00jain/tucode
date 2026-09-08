import AppKit

/// Search control values serialized by the workbench; not a native search model.
struct NativeSearchState: Codable {
	let revision: Int
	let query: String
	let replace: String
	let includes: String
	let excludes: String
	let caseSensitive: Bool
	let wholeWord: Bool
	let regex: Bool
	let preserveCase: Bool
	let replaceVisible: Bool
	let detailsVisible: Bool
	let searching: Bool
	let message: String
}

/// Native fields and buttons only. Every edit/action goes back through the existing bridge.
final class NativeSearchControls: NSStackView, NSSearchFieldDelegate {
	var onEvent: ((String, String?, Int?) -> Void)?
	var onExitField: (() -> Void)?
	private var fields: [String: NSSearchField] = [:]
	private var buttons: [String: NSButton] = [:]
	private let status = NSTextField(labelWithString: "")
	private var inputRevision = 0
	private var applying = false
	private var replaceRow: NSStackView!
	private var detailsRow: NSStackView!

	var currentEditor: NSText? {
		fields.values.compactMap { $0.currentEditor() }.first { $0 === window?.firstResponder }
	}

	init() {
		super.init(frame: .zero)
		orientation = .vertical
		alignment = .leading
		spacing = 4
		translatesAutoresizingMaskIntoConstraints = false
		let query = field("query", placeholder: "Search")
		addArrangedSubview(query)
		let options = NSStackView(views: [
			button("case", title: "Aa", help: "Match Case"),
			button("word", title: "ab", help: "Match Whole Word"),
			button("regex", title: ".*", help: "Use Regular Expression"),
			button("replace", title: "Replace", help: "Show Replace"),
			button("details", title: "…", help: "Files to Include / Exclude")
		])
		options.spacing = 4
		addArrangedSubview(options)
		let replaceInput = NSStackView(views: [field("replace", placeholder: "Replace"),
			button("preserve-case", title: "AB", help: "Preserve Case")])
		replaceInput.spacing = 4
		let replaceSelected = NSButton(title: "Replace Selected", target: self, action: #selector(replaceSelection))
		replaceSelected.bezelStyle = .rounded
		replaceSelected.controlSize = .small
		replaceSelected.setAccessibilityIdentifier("tucode.search.replaceSelected")
		replaceRow = NSStackView(views: [replaceInput, replaceSelected])
		replaceRow.orientation = .vertical
		replaceRow.alignment = .leading
		replaceRow.spacing = 4
		replaceInput.widthAnchor.constraint(equalTo: replaceRow.widthAnchor).isActive = true
		addArrangedSubview(replaceRow)
		detailsRow = NSStackView(views: [field("includes", placeholder: "Files to include"),
			field("excludes", placeholder: "Files to exclude")])
		detailsRow.orientation = .vertical
		detailsRow.alignment = .leading
		detailsRow.spacing = 4
		addArrangedSubview(detailsRow)
		status.font = .systemFont(ofSize: 11)
		status.textColor = .secondaryLabelColor
		status.lineBreakMode = .byTruncatingTail
		status.maximumNumberOfLines = 1
		status.setAccessibilityIdentifier("tucode.search.status")
		addArrangedSubview(status)
		for view in [query, replaceRow!, detailsRow!, status] {
			view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
		}
		for view in detailsRow.arrangedSubviews { view.widthAnchor.constraint(equalTo: detailsRow.widthAnchor).isActive = true }
		isHidden = true
	}

	required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

	private func field(_ key: String, placeholder: String) -> NSSearchField {
		let field = NSSearchField()
		field.identifier = NSUserInterfaceItemIdentifier(key)
		field.placeholderString = placeholder
		field.font = .systemFont(ofSize: 12)
		field.delegate = self
		field.sendsSearchStringImmediately = true
		(field.cell as? NSSearchFieldCell)?.searchButtonCell = nil
		(field.cell as? NSSearchFieldCell)?.cancelButtonCell = nil
		field.setAccessibilityIdentifier("tucode.search.\(key)")
		fields[key] = field
		return field
	}

	private func button(_ key: String, title: String, help: String) -> NSButton {
		let button = NSButton(title: title, target: self, action: #selector(activateOption))
		button.identifier = NSUserInterfaceItemIdentifier(key)
		button.setButtonType(.pushOnPushOff)
		button.bezelStyle = .rounded
		button.controlSize = .small
		button.toolTip = help
		button.setAccessibilityLabel(help)
		button.setAccessibilityIdentifier("tucode.search.\(key).toggle")
		buttons[key] = button
		return button
	}

	func apply(_ state: NativeSearchState?) {
		isHidden = state == nil
		guard let state else { return }
		applying = true
		defer { applying = false }
		if state.revision >= inputRevision {
			inputRevision = state.revision
			for (key, value) in ["query": state.query, "replace": state.replace, "includes": state.includes, "excludes": state.excludes] {
				if fields[key]?.stringValue != value { fields[key]?.stringValue = value }
			}
		}
		for (key, enabled) in ["case": state.caseSensitive, "word": state.wholeWord, "regex": state.regex,
			"preserve-case": state.preserveCase, "replace": state.replaceVisible, "details": state.detailsVisible] {
			buttons[key]?.state = enabled ? .on : .off
		}
		replaceRow.isHidden = !state.replaceVisible
		detailsRow.isHidden = !state.detailsVisible
		status.stringValue = state.message
	}

	func controlTextDidChange(_ notification: Notification) {
		guard !applying, let field = notification.object as? NSSearchField, let key = field.identifier?.rawValue else { return }
		inputRevision += 1
		onEvent?("search-\(key)-change", field.stringValue, inputRevision)
	}

	func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
		if command == #selector(NSResponder.insertNewline(_:)) {
			onEvent?("search-submit", nil, nil)
			return true
		}
		if command == #selector(NSResponder.cancelOperation(_:)) {
			onExitField?()
			return true
		}
		return false
	}

	@objc private func activateOption(_ sender: NSButton) {
		guard !applying, let key = sender.identifier?.rawValue else { return }
		onEvent?("search-toggle-\(key)", nil, nil)
	}

	@objc private func replaceSelection() { onEvent?("search-replace-selected", nil, nil) }
}
