import AppKit
import UniformTypeIdentifiers

/// Shared native file paint for tabs, Explorer, and Changes. Labels may contain
/// preview/diff suffixes or parent paths, so prefer the resource's actual name.
enum NativeFileIcon {
	private static let typeIcons = NSCache<NSString, NSImage>()

	static func image(resource: String?, label: String, isDirectory: Bool = false, pointSize: CGFloat = 11,
		theme: String? = "mac-native", languageID: String? = nil, seti: NativeSetiIcons? = .bundled) -> NSImage? {
		let url = resource.flatMap(URL.init(string:))
		let name = (url?.lastPathComponent ?? label).lowercased()
		guard let theme else { return nil }
		if theme == "vs-seti" {
			let light = (NSApp?.effectiveAppearance ?? NSAppearance.currentDrawing()).bestMatch(from: [.aqua, .darkAqua]) != .darkAqua
			if let image = seti?.image(name: name, languageID: languageID, pointSize: pointSize, light: light, isDirectory: isDirectory) { return image }
		}
		// A theme with no definition uses native paint. Explicit None returned above.
		let symbol: String
		let color: NSColor
		if isDirectory {
			symbol = "folder.fill"
			color = .systemBlue
		} else if name == "readme" || name.hasPrefix("readme.") {
			symbol = "book.closed"
			color = NSColor(calibratedRed: 0.61, green: 0.73, blue: 0.79, alpha: 1)
		} else if name == "package" || name == "package.swift" || name.hasSuffix(".swift") {
			symbol = "swift"
			color = NSColor(calibratedRed: 0.78, green: 0.48, blue: 0.29, alpha: 1)
		} else if name == "info" || name.hasPrefix("info.") {
			symbol = "tablecells"
			color = NSColor(calibratedRed: 0.62, green: 0.72, blue: 0.77, alpha: 1)
		} else if name.hasSuffix(".sh") {
			symbol = "terminal"
			color = NSColor(calibratedWhite: 0.68, alpha: 1)
		} else {
			// Type-based icons also work for deleted files and git/preview URIs.
			let fileExtension = (name as NSString).pathExtension
			let localType = fileExtension.isEmpty && url?.isFileURL == true
				? (try? url?.resourceValues(forKeys: [.contentTypeKey]))?.contentType : nil
			let type = UTType(filenameExtension: fileExtension) ?? localType ?? .data
			let key = "\(type.identifier):\(pointSize)" as NSString
			if let cached = typeIcons.object(forKey: key) { return cached }
			let image = NSWorkspace.shared.icon(for: type).copy() as? NSImage
			image?.size = NSSize(width: pointSize + 3, height: pointSize + 3)
			image?.isTemplate = false
			if let image { typeIcons.setObject(image, forKey: key) }
			return image
		}
		guard let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) else { return nil }
		let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
		guard let configured = image.withSymbolConfiguration(configuration) else { return image }
		let tinted = NSImage(size: configured.size)
		tinted.lockFocus()
		configured.draw(in: NSRect(origin: .zero, size: configured.size))
		color.setFill()
		NSRect(origin: .zero, size: configured.size).fill(using: .sourceAtop)
		tinted.unlockFocus()
		tinted.isTemplate = false
		return tinted
	}
}
