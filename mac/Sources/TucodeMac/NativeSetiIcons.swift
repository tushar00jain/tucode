import AppKit
import CoreText

/// Native paint of the bundled Seti font and associations; no CSS or browser renderer.
final class NativeSetiIcons {
	static let bundled = Bundle.main.resourceURL.flatMap {
		NativeSetiIcons(directory: $0.appendingPathComponent("app/resources/extensions/theme-seti/icons"))
	}
	private let theme: [String: Any]
	private let descriptor: CTFontDescriptor
	private let fontScale: CGFloat
	private let images = NSCache<NSString, NSImage>()

	init?(directory: URL) {
		guard let json = try? Data(contentsOf: directory.appendingPathComponent("vs-seti-icon-theme.json")),
			let theme = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
			let data = try? Data(contentsOf: directory.appendingPathComponent("seti.woff")),
			let descriptor = CTFontManagerCreateFontDescriptorFromData(data as CFData) else { return nil }
		self.theme = theme
		self.descriptor = descriptor
		let fontSize = (theme["fonts"] as? [[String: Any]])?.first?["size"] as? String ?? "150%"
		self.fontScale = CGFloat(Double(fontSize.dropLast()) ?? 150) / 100
	}

	func iconID(name: String, languageID: String?, light: Bool, isDirectory: Bool = false) -> String? {
		let overrides = light ? theme["light"] as? [String: Any] : nil
		func association(_ table: String, _ key: String) -> String? {
			(overrides?[table] as? [String: String])?[key] ?? (theme[table] as? [String: String])?[key]
		}
		let name = name.lowercased()
		if isDirectory { return association("folderNames", name) ?? (overrides?["folder"] ?? theme["folder"]) as? String }
		if let id = association("fileNames", name) { return id }
		// Seti filename associations precede compound extensions, then the VS Code language ID.
		let segments = name.split(separator: ".", omittingEmptySubsequences: false)
		for index in segments.indices.dropFirst() {
			if let id = association("fileExtensions", segments[index...].joined(separator: ".")) { return id }
		}
		return languageID.flatMap { association("languageIds", $0) } ?? (overrides?["file"] ?? theme["file"]) as? String
	}

	func image(name: String, languageID: String?, pointSize: CGFloat, light: Bool, isDirectory: Bool = false) -> NSImage? {
		guard let id = iconID(name: name, languageID: languageID, light: light, isDirectory: isDirectory) else { return nil }
		let key = "\(id):\(pointSize)" as NSString
		if let image = images.object(forKey: key) { return image }
		guard let definition = (theme["iconDefinitions"] as? [String: [String: String]])?[id],
			let character = definition["fontCharacter"], let code = UInt16(character.dropFirst(), radix: 16),
			let hex = definition["fontColor"], let rgb = UInt32(hex.dropFirst(), radix: 16) else { return nil }
		let font = CTFontCreateWithFontDescriptor(descriptor, pointSize * fontScale, nil)
		var characterCode = code
		var glyph: CGGlyph = 0
		guard CTFontGetGlyphsForCharacters(font, &characterCode, &glyph, 1), glyph != 0 else { return nil }
		var advance = CGSize.zero
		CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
		let ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font)
		let color = NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255,
			green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
		let size = pointSize + 3
		let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
			guard let context = NSGraphicsContext.current?.cgContext else { return false }
			context.saveGState()
			context.textMatrix = .identity
			context.setFillColor(color.cgColor)
			// Preserve Seti's font metrics instead of stretching every outline to the box.
			// AppKit supplies the destination backing scale, including Retina displays.
			var position = CGPoint(x: rect.midX - advance.width / 2, y: rect.midY - (ascent - descent) / 2)
			var renderedGlyph = glyph
			CTFontDrawGlyphs(font, &renderedGlyph, &position, 1, context)
			context.restoreGState()
			return true
		}
		image.isTemplate = false
		images.setObject(image, forKey: key)
		return image
	}
}
