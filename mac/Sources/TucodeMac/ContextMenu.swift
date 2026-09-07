import AppKit
import WebKit

struct ContextMenuItem: Decodable {
	let id: Int?
	let label: String?
	let enabled: Bool?
	let checked: Bool?
	let radio: Bool?
	let keyLabel: String?
	let separator: Bool?
	let children: [ContextMenuItem]?
	let lazy: Bool?
	let iconResource: String?
	var commandId: String? = nil
	var selector: String? = nil
	var applicationTarget: Bool? = nil
	var key: String? = nil
	var modifiers: UInt? = nil
}

struct ContextMenuChildren: Decodable {
	let requestId: Int
	let id: Int
	let items: [ContextMenuItem]
}

struct ContextMenuPaint: Decodable {
	let requestId: Int
	let x: Double
	let y: Double
	let viewportWidth: Double
	let items: [ContextMenuItem]
	let nativeAnchor: NativeMenuAnchor?
}

struct NativeMenuAnchor: Codable {
	let x: Double
	let y: Double
	init(_ point: NSPoint) { x = point.x; y = point.y }
}

struct ContextMenuIntent: Encodable {
	struct Modifiers: Encodable {
		let shiftKey: Bool
		let ctrlKey: Bool
		let altKey: Bool
		let metaKey: Bool
	}
	let requestId: Int
	let id: Int?
	let modifiers: Modifiers?
	var expandId: Int? = nil
}

/// Presentation only: item tags identify the original JavaScript actions.
final class EditorContextMenu: NSObject {
	private var menu: NSMenu?
	private var generation = 0
	private var target: ContextMenuTarget?
	private var requestId: Int?

	func apply(_ children: ContextMenuChildren) {
		guard requestId == children.requestId else { return }
		target?.apply(children)
	}

	func hide() {
		generation += 1
		menu?.cancelTracking()
		target = nil
		requestId = nil
	}

	func show(_ paint: ContextMenuPaint, in webView: WKWebView,
		completion: @escaping (ContextMenuIntent) -> Void) {
		hide()
		let token = generation
		// Start outside WebKit's callback/main dispatch queue so lazy replies can arrive
		// during tracking. Default mode also lets a cancelled menu finish before another opens.
		RunLoop.main.perform(inModes: [.default]) { [weak self, weak webView] in
			guard let self, let webView, token == self.generation else {
				completion(ContextMenuIntent(requestId: paint.requestId, id: nil, modifiers: nil))
				return
			}
			guard webView.window != nil, paint.viewportWidth > 0 else {
				completion(ContextMenuIntent(requestId: paint.requestId, id: nil, modifiers: nil))
				return
			}
			let target = ContextMenuTarget { id in
				completion(ContextMenuIntent(requestId: paint.requestId, id: nil, modifiers: nil, expandId: id))
			}
			self.target = target
			self.requestId = paint.requestId
			let menu = target.build(paint.items)
			self.menu = menu
			// AppKit points, not backing pixels. Account for WebKit page zoom and flipped views.
			let scale = webView.bounds.width / paint.viewportWidth
			let point = NSPoint(x: webView.bounds.minX + paint.x * scale,
				y: webView.isFlipped ? webView.bounds.minY + paint.y * scale : webView.bounds.maxY - paint.y * scale)
			if let anchor = paint.nativeAnchor, let content = webView.window?.contentView {
				menu.popUp(positioning: nil, at: content.convert(NSPoint(x: anchor.x, y: anchor.y), from: nil), in: content)
			} else { menu.popUp(positioning: nil, at: point, in: webView) }
			let result = ContextMenuIntent(requestId: paint.requestId,
				id: target.selection, modifiers: target.modifiers)
			if token == self.generation { self.menu = nil; self.target = nil; self.requestId = nil }
			completion(result)
		}
		CFRunLoopWakeUp(CFRunLoopGetMain())
	}

}

struct MainMenuPaint: Decodable {
	let generation: Int
	let items: [ContextMenuItem]
}

struct MainMenuIntent: Encodable {
	let generation: Int
	let id: Int
}

/// Uses the same native item painter as popup menus. VS Code continues to resolve shortcuts.
final class EditorMainMenu {
	private var target: ContextMenuTarget?
	private var menu: NSMenu?

	func apply(_ paint: MainMenuPaint, keyEquivalent: @escaping (NSEvent) -> Bool,
		activate: @escaping (MainMenuIntent) -> Void) {
		let select: (Int) -> Void = { id in activate(MainMenuIntent(generation: paint.generation, id: id)) }
		if let target, let menu {
			target.update(paint.items, in: menu, activate: select)
		} else {
			let target = ContextMenuTarget(load: { _ in }, activate: select, keyEquivalent: keyEquivalent)
			self.target = target
			let menu = target.build(paint.items)
			self.menu = menu
		}
	}

	func activate() -> Bool {
		guard let menu else { return false }
		NSApp.mainMenu = menu
		return true
	}
}

private final class ContextMenuTarget: NSObject, NSMenuDelegate {
	var selection: Int?
	var modifiers: ContextMenuIntent.Modifiers?
	private let load: (Int) -> Void
	private var activate: ((Int) -> Void)?
	private let keyEquivalent: ((NSEvent) -> Bool)?
	private var commands: [Int: ContextMenuItem] = [:]
	private var submenus: [Int: NSMenu] = [:]
	private var requested = Set<Int>()

	init(load: @escaping (Int) -> Void, activate: ((Int) -> Void)? = nil,
		keyEquivalent: ((NSEvent) -> Bool)? = nil) {
		self.load = load
		self.activate = activate
		self.keyEquivalent = keyEquivalent
	}

	func menuNeedsUpdate(_ menu: NSMenu) {
		if activate != nil {
			for item in menu.items {
				guard item.action == #selector(select(_:)), let model = commands[item.tag] else { continue }
				if let editor = NSApp.keyWindow?.firstResponder as? NSText,
					let selector = fieldSelector(model.commandId) {
					item.isEnabled = editor.responds(to: selector)
				} else { item.isEnabled = model.enabled ?? false }
			}
		}
		guard let id = submenus.first(where: { $0.value === menu })?.key,
			requested.insert(id).inserted else { return }
		load(id)
	}

	func apply(_ children: ContextMenuChildren) {
		guard let menu = submenus[children.id] else { return }
		menu.removeAllItems()
		fill(children.items, into: menu)
		if menu.items.isEmpty { menu.addItem(placeholder("(Empty)")) }
		menu.update()
	}

	private func placeholder(_ title: String) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		item.isEnabled = false
		return item
	}

	func build(_ items: [ContextMenuItem]) -> NSMenu {
		let menu = NSMenu()
		menu.autoenablesItems = false
		if activate != nil { menu.delegate = self }
		fill(items, into: menu)
		return menu
	}

	func update(_ items: [ContextMenuItem], in menu: NSMenu, activate: @escaping (Int) -> Void) {
		self.activate = activate
		commands.removeAll()
		fill(items, into: menu, reusing: true)
	}

	private func fill(_ items: [ContextMenuItem], into menu: NSMenu, reusing: Bool = false) {
		for (index, item) in items.enumerated() {
			let existing = reusing && index < menu.numberOfItems ? menu.item(at: index) : nil
			let separator = item.separator == true
			let native: NSMenuItem
			if let existing, existing.isSeparatorItem == separator { native = existing }
			else {
				if let existing { menu.removeItem(existing) }
				native = separator ? .separator() : NSMenuItem(title: "", action: nil, keyEquivalent: "")
				menu.insertItem(native, at: index)
			}
			if separator { continue }
			native.title = item.label ?? ""
			native.action = nil
			native.target = nil
			native.keyEquivalent = item.key ?? ""
			native.keyEquivalentModifierMask = NSEvent.ModifierFlags(rawValue: item.modifiers ?? 0)
			native.isEnabled = item.enabled ?? false
			native.state = item.checked == true ? .on : .off
			if item.radio == true { native.onStateImage = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil) }
			if let resource = item.iconResource {
				let icon = NSWorkspace.shared.icon(forFile: resource).copy() as? NSImage
				icon?.size = NSSize(width: 16, height: 16)
				native.image = icon
			}
			if item.lazy == true, let id = item.id {
				let submenu = build([])
				submenu.addItem(placeholder("Loading…"))
				submenu.delegate = self
				submenus[id] = submenu
				native.submenu = submenu
			} else if let children = item.children {
				if reusing, let submenu = native.submenu { fill(children, into: submenu, reusing: true) }
				else { native.submenu = build(children) }
			} else if let selector = item.selector {
				native.submenu = nil
				native.action = NSSelectorFromString(selector)
				native.target = item.applicationTarget == true ? NSApp : nil
			} else if let id = item.id {
				native.submenu = nil
				commands[id] = item
				native.tag = id
				native.target = self
				native.action = #selector(select(_:))
			}
			native.submenu?.title = item.label ?? ""
			if native.keyEquivalent.isEmpty, let label = item.keyLabel, !label.isEmpty {
				// Match VS Code's native menus for multi-stroke/non-native bindings.
				native.title += " [\(label)]"
			}
		}
		while menu.numberOfItems > items.count { menu.removeItem(at: menu.numberOfItems - 1) }
	}

	private func fieldSelector(_ command: String?) -> Selector? {
		switch command {
		case "undo": Selector(("undo:"))
		case "redo": Selector(("redo:"))
		case "editor.action.clipboardCutAction": #selector(NSText.cut(_:))
		case "editor.action.clipboardCopyAction": #selector(NSText.copy(_:))
		case "editor.action.clipboardPasteAction": #selector(NSText.paste(_:))
		case "editor.action.selectAll": #selector(NSText.selectAll(_:))
		default: nil
		}
	}

	@objc private func select(_ item: NSMenuItem) {
		if let activate {
			if let editor = NSApp.keyWindow?.firstResponder as? NSText,
				let selector = fieldSelector(commands[item.tag]?.commandId) {
				NSApp.sendAction(selector, to: editor, from: item)
			} else if let event = NSApp.currentEvent, event.type == .keyDown,
				keyEquivalent?(event) == true {
				// Menu accelerators use the same VS Code key route as other shortcuts,
				// preserving the resolver's current context and multi-stroke sequence.
				return
			} else { activate(item.tag) }
			return
		}
		selection = item.tag
		let flags = NSApp.currentEvent?.modifierFlags ?? []
		modifiers = ContextMenuIntent.Modifiers(shiftKey: flags.contains(.shift),
			ctrlKey: flags.contains(.control), altKey: flags.contains(.option), metaKey: flags.contains(.command))
	}
}
