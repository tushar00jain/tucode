import AppKit

struct NativeHistoryState: Codable {
	let graphWidth: Double
	let repository: String
	let refs: String
	let loading: Bool
	let pageOnScroll: Bool
	let viewMode: String
	let enabled: Bool
}
struct NativeHistoryGraph: Codable, Equatable {
	let width: Double
	let height: Double
	let shapes: [Shape]
	struct Shape: Codable, Equatable {
		let kind: String
		let commands: [[Double]]?
		let cx: Double?
		let cy: Double?
		let radius: Double?
		let color: RenderColor?
		let fill: RenderColor?
		let strokeWidth: Double
		let dashed: Bool?
	}
}

/// A separate, unindented outline column keeps the supplied lanes aligned through child rows.
/// Only paint coordinates cross this boundary: no repository or lane decisions live in AppKit.
final class NativeHistoryGraphView: NSView {
	var graph: NativeHistoryGraph? { didSet { needsDisplay = true } }
	override var isFlipped: Bool { true }
	override func draw(_ dirtyRect: NSRect) {
		guard let graph, graph.height > 0 else { return }
		let scale = bounds.height / graph.height
		func point(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: x, y: y * scale) }
		func color(_ paint: RenderColor?) -> NSColor {
			guard let rgba = paint?.rgba else { return .clear }
			return NSColor(red: CGFloat(rgba.r) / 255, green: CGFloat(rgba.g) / 255,
				blue: CGFloat(rgba.b) / 255, alpha: rgba.a)
		}
		for shape in graph.shapes {
			let path: NSBezierPath
			if shape.kind == "circle", let x = shape.cx, let y = shape.cy, let radius = shape.radius {
				path = NSBezierPath(ovalIn: NSRect(x: x - radius, y: y * scale - radius, width: radius * 2, height: radius * 2))
				color(shape.fill).setFill(); path.fill()
			} else {
				path = NSBezierPath()
				for command in shape.commands ?? [] {
					if command.count == 3 && command[0] == 0 { path.move(to: point(command[1], command[2])) }
					else if command.count == 3 && command[0] == 1 { path.line(to: point(command[1], command[2])) }
					else if command.count == 7 && command[0] == 2 {
						path.curve(to: point(command[5], command[6]), controlPoint1: point(command[1], command[2]), controlPoint2: point(command[3], command[4]))
					}
				}
			}
			path.lineWidth = shape.strokeWidth
			path.lineCapStyle = .round
			if shape.dashed == true { path.setLineDash([4, 2], count: 2, phase: 0) }
			color(shape.color).setStroke(); path.stroke()
		}
	}
}

final class NativeHistoryControls: NSStackView {
	var onAction: ((String) -> Void)?
	private var buttons: [String: NSButton] = [:]
	init() {
		super.init(frame: .zero)
		orientation = .vertical
		alignment = .leading
		spacing = 4
		translatesAutoresizingMaskIntoConstraints = false
		let selection = NSStackView(views: [button("repository", "Repository"), button("refs", "Auto")])
		let actions = NSStackView(views: [button("refresh", "Refresh"), button("head", "HEAD"), button("mode", "Tree")])
		selection.spacing = 4; actions.spacing = 4
		addArrangedSubview(selection); addArrangedSubview(actions)
		selection.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
		isHidden = true
	}
	required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
	private func button(_ id: String, _ title: String) -> NSButton {
		let button = NSButton(title: title, target: self, action: #selector(activate(_:)))
		button.identifier = NSUserInterfaceItemIdentifier(id)
		button.controlSize = .small
		button.bezelStyle = .rounded
		button.lineBreakMode = .byTruncatingTail
		button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		button.setAccessibilityIdentifier("tucode.history.\(id)")
		buttons[id] = button
		return button
	}
	@objc private func activate(_ sender: NSButton) { if let id = sender.identifier?.rawValue { onAction?(id) } }
	func apply(_ state: NativeHistoryState?) {
		isHidden = state == nil
		guard let state else { return }
		buttons["repository"]?.title = state.repository
		buttons["refs"]?.title = state.refs
		buttons["refs"]?.toolTip = state.refs
		buttons["refresh"]?.title = state.loading ? "Loading…" : "Refresh"
		buttons["mode"]?.title = state.viewMode == "tree" ? "List" : "Tree"
		for (id, button) in buttons { button.isEnabled = id == "repository" || (state.enabled && !state.loading) }
	}
}
