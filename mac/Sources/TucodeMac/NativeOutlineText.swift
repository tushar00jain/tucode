import AppKit

/// Native filename paint shared by Explorer and Changes. The supplied match-background runs
/// become Xcode-style bold matches and subdued surrounding text; no matching happens here.
enum NativeOutlineText {
	static func attributed(_ records: RenderRecords, font: NSFont, sourcePreview: Bool = false) -> NSAttributedString {
		let result = NSMutableAttributedString(string: "")
		let paragraph = NSMutableParagraphStyle()
		paragraph.lineBreakMode = sourcePreview ? .byTruncatingTail : .byTruncatingMiddle
		let hasMatches = records.runs.contains { $0.style.bg != nil }
		let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor,
			.paragraphStyle: paragraph]
		for run in records.runs {
			let text = sourcePreview ? run.text : run.text.unicodeScalars.filter { !(0xE000...0xF8FF).contains(Int($0.value)) }.map(String.init).joined()
			var attributes = base
			if sourcePreview {
				if let fg = run.style.fg { attributes[.foregroundColor] = color(fg) }
				if let bg = run.style.bg { attributes[.backgroundColor] = color(bg) }
				if run.style.strikethrough == true { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
			} else if run.style.bg != nil {
				attributes[.font] = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
			} else if hasMatches {
				attributes[.foregroundColor] = NSColor.secondaryLabelColor
			}
			result.append(NSAttributedString(string: text, attributes: attributes))
		}
		if sourcePreview { return result }
		if result.string.trimmingCharacters(in: .whitespaces).isEmpty {
			return NSAttributedString(string: records.accessibleLabel, attributes: base)
		}
		// Retain the outline's existing visibleText trimming without flattening its attributes.
		let text = result.string as NSString
		let first = text.rangeOfCharacter(from: .whitespaces.inverted).location
		let last = NSMaxRange(text.rangeOfCharacter(from: .whitespaces.inverted, options: .backwards))
		if last < result.length { result.deleteCharacters(in: NSRange(location: last, length: result.length - last)) }
		if first > 0 { result.deleteCharacters(in: NSRange(location: 0, length: first)) }
		return result
	}

	private static func color(_ value: RenderColor) -> NSColor {
		let rgba = value.rgba
		return NSColor(red: CGFloat(rgba.r) / 255, green: CGFloat(rgba.g) / 255,
			blue: CGFloat(rgba.b) / 255, alpha: rgba.a)
	}
}

/// AppKit reapplies cell backgroundStyle during selection. Reapply attributed paint so a selected
/// row retains match emphasis and the adaptive filename foreground stays readable.
final class NavigatorOutlineCell: NSTableCellView {
	let statusField = NSTextField(labelWithString: "")
	var projectedText: RenderRecords?
	var projectedFont: NSFont = .systemFont(ofSize: 12)
	var sourcePreview = false
	override var backgroundStyle: NSView.BackgroundStyle {
		didSet { keepProjectedTextVisible() }
	}
	func keepProjectedTextVisible() {
		guard let projectedText else { return }
		textField?.maximumNumberOfLines = 1
		textField?.cell?.usesSingleLineMode = true
		textField?.attributedStringValue = NativeOutlineText.attributed(projectedText, font: projectedFont, sourcePreview: sourcePreview)
		textField?.alphaValue = 1
	}
}
