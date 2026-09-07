import AppKit
import XCTest
@testable import TucodeMac

final class NativeOutlineTextTests: XCTestCase {
	private func records() throws -> RenderRecords {
		let data = Data("""
		{"root":{},"accessibleLabel":"🧪café.txt","runs":[
		 {"text":"🧪","style":{"fg":{"rgba":{"r":0,"g":255,"b":0,"a":1}}}},
		 {"text":"café","style":{"bg":{"rgba":{"r":226,"g":192,"b":141,"a":0.4}}}},
		 {"text":".txt","style":{}}]}
		""".utf8)
		return try JSONDecoder().decode(RenderRecords.self, from: data)
	}

	func testUTF16MatchRunsUseNativeXcodeEmphasis() throws {
		let font = NSFont.systemFont(ofSize: 12, weight: .medium)
		let text = NativeOutlineText.attributed(try records(), font: font)
		XCTAssertEqual(text.string, "🧪café.txt")
		XCTAssertEqual(text.length, 10)
		for offset in 0..<text.length {
			let matched = (2..<6).contains(offset)
			let expectedFont = matched ? NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) : font
			XCTAssertEqual(text.attribute(.font, at: offset, effectiveRange: nil) as? NSFont, expectedFont)
			XCTAssertEqual(text.attribute(.foregroundColor, at: offset, effectiveRange: nil) as? NSColor,
				matched ? .labelColor : .secondaryLabelColor)
			XCTAssertNil(text.attribute(.backgroundColor, at: offset, effectiveRange: nil))
		}
	}

	func testSelectionAndCellReuseRetainOnlyCurrentMatchPaint() throws {
		let cell = NavigatorOutlineCell()
		let label = NSTextField(labelWithString: "")
		cell.textField = label
		cell.addSubview(label)
		cell.projectedText = try records()
		cell.projectedFont = .systemFont(ofSize: 12)
		cell.keepProjectedTextVisible()
		let original = label.attributedStringValue
		for style: NSView.BackgroundStyle in [.emphasized, .normal, .raised, .lowered] {
			cell.backgroundStyle = style
			XCTAssertEqual(label.attributedStringValue, original)
			XCTAssertEqual(label.alphaValue, 1)
		}
		cell.projectedText = try JSONDecoder().decode(RenderRecords.self,
			from: Data(#"{"root":{},"accessibleLabel":"nested/deep","runs":[{"text":"nested/deep","style":{"bold":true}}]}"#.utf8))
		cell.keepProjectedTextVisible()
		XCTAssertEqual(label.stringValue, "nested/deep")
		XCTAssertNil(label.attributedStringValue.attribute(.backgroundColor, at: 0, effectiveRange: nil))
		XCTAssertEqual(label.attributedStringValue.attribute(.font, at: 0, effectiveRange: nil) as? NSFont, cell.projectedFont)
		XCTAssertEqual(label.attributedStringValue.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, .labelColor)
	}

	func testLongFilenamesRemainSingleLineWithMiddleTruncation() throws {
		let cell = NavigatorOutlineCell()
		let label = NSTextField(labelWithString: "")
		cell.textField = label
		cell.addSubview(label)
		cell.projectedText = try JSONDecoder().decode(RenderRecords.self, from: Data(#"{"root":{},"accessibleLabel":"markdown-preview-attempt4.log","runs":[{"text":"markdown-preview-","style":{}},{"text":"attempt4","style":{"bg":{"rgba":{"r":226,"g":192,"b":141,"a":0.4}}}},{"text":".log","style":{}}]}"#.utf8))
		cell.keepProjectedTextVisible()
		XCTAssertEqual(label.maximumNumberOfLines, 1)
		XCTAssertEqual(label.cell?.usesSingleLineMode, true)
		label.attributedStringValue.enumerateAttribute(.paragraphStyle,
			in: NSRange(location: 0, length: label.attributedStringValue.length)) { value, _, _ in
			XCTAssertEqual((value as? NSParagraphStyle)?.lineBreakMode, .byTruncatingMiddle)
		}
		XCTAssertEqual(label.stringValue, "markdown-preview-attempt4.log")
	}

	func testSearchPreviewPreservesSuppliedWhitespaceAndReplacementPaint() throws {
		let records = try JSONDecoder().decode(RenderRecords.self, from: Data(#"{"root":{},"accessibleLabel":"match","runs":[{"text":"  …before ","style":{}},{"text":"old","style":{"fg":{"rgba":{"r":255,"g":0,"b":0,"a":1}},"bg":{"rgba":{"r":50,"g":0,"b":0,"a":0.4}},"strikethrough":true}},{"text":"new  ","style":{"fg":{"rgba":{"r":0,"g":255,"b":0,"a":1}}}}]}"#.utf8))
		let font = NSFont.systemFont(ofSize: 12)
		let text = NativeOutlineText.attributed(records, font: font, sourcePreview: true)
		XCTAssertEqual(text.string, "  …before oldnew  ")
		let offset = (text.string as NSString).range(of: "old").location
		XCTAssertEqual(text.attribute(.font, at: offset, effectiveRange: nil) as? NSFont, font)
		XCTAssertEqual(text.attribute(.strikethroughStyle, at: offset, effectiveRange: nil) as? Int, NSUnderlineStyle.single.rawValue)
		XCTAssertEqual((text.attribute(.foregroundColor, at: offset, effectiveRange: nil) as? NSColor)?.redComponent, 1)
		XCTAssertEqual((text.attribute(.backgroundColor, at: offset, effectiveRange: nil) as? NSColor)?.alphaComponent, 0.4)
		XCTAssertEqual((text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.lineBreakMode, .byTruncatingTail)
	}
}
