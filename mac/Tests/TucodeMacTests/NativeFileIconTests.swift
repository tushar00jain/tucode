import AppKit
import XCTest
@testable import TucodeMac

final class NativeFileIconTests: XCTestCase {
	private func seti() throws -> NativeSetiIcons {
		let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
			.deletingLastPathComponent().deletingLastPathComponent()
		return try XCTUnwrap(NativeSetiIcons(directory: repository.appendingPathComponent("resources/extensions/theme-seti/icons")))
	}

	func testSetiAssociationsAndNativeFontPaint() throws {
		let icons = try seti()
		XCTAssertEqual(icons.iconID(name: "app.ts", languageID: "typescript", light: false), "_typescript")
		XCTAssertEqual(icons.iconID(name: "app.ts", languageID: "typescript", light: true), "_typescript_light")
		XCTAssertEqual(icons.iconID(name: "KARMA.CONF.JS", languageID: "javascript", light: false), "_karma")
		XCTAssertEqual(icons.iconID(name: "unknown.xyzzy", languageID: nil, light: false), "_default")
		for language in ["typescript", "javascript", "python", "rust", "json", "yaml"] {
			let dark = try XCTUnwrap(icons.image(name: "file", languageID: language, pointSize: 13, light: false))
			let light = try XCTUnwrap(icons.image(name: "file", languageID: language, pointSize: 13, light: true))
			XCTAssertNotNil(dark.tiffRepresentation, language)
			XCTAssertNotEqual(dark.tiffRepresentation, light.tiffRepresentation, language)
			XCTAssertFalse(dark.isTemplate)
			XCTAssertTrue(dark === icons.image(name: "file", languageID: language, pointSize: 13, light: false))
		}
	}

	func testThemeSelectionDoesNotMixNativeAndSetiIcons() throws {
		let icons = try seti()
		for name in ["README.md", "Package.swift", "Info.plist", "run.sh", "image.png", "unknown.xyzzy"] {
			let native = try XCTUnwrap(NativeFileIcon.image(resource: nil, label: name, theme: "mac-native", seti: nil))
			let seti = try XCTUnwrap(NativeFileIcon.image(resource: nil, label: name, theme: "vs-seti", seti: icons))
			XCTAssertNotEqual(native.tiffRepresentation, seti.tiffRepresentation, name)
			XCTAssertNil(NativeFileIcon.image(resource: nil, label: name, theme: nil, seti: icons))
			XCTAssertEqual(native.tiffRepresentation, NativeFileIcon.image(resource: nil, label: name, theme: "mac-native", seti: icons)?.tiffRepresentation)
		}
		let folder = try XCTUnwrap(NativeFileIcon.image(resource: nil, label: "folder", isDirectory: true))
		XCTAssertEqual(folder.tiffRepresentation, NativeFileIcon.image(resource: nil, label: "folder", isDirectory: true, theme: "vs-seti", seti: icons)?.tiffRepresentation, "Missing theme folder definitions use native paint")
		XCTAssertNil(NativeFileIcon.image(resource: nil, label: "folder", isDirectory: true, theme: nil, seti: icons))
	}

	func testSetiDrawsAtDestinationResolution() throws {
		let icons = try seti()
		for pointSize: CGFloat in [11, 13] { // Existing tab and sidebar sizes.
			let image = try XCTUnwrap(icons.image(name: "file", languageID: "typescript", pointSize: pointSize, light: false))
			XCTAssertEqual(image.size, NSSize(width: pointSize + 3, height: pointSize + 3))
			let normal = try raster(image, scale: 1)
			let retina = try raster(image, scale: 2)
			let pixels = normal.width
			XCTAssertEqual(retina.width, pixels * 2)
			let normalData = try XCTUnwrap(normal.data).assumingMemoryBound(to: UInt8.self)
			let retinaData = try XCTUnwrap(retina.data).assumingMemoryBound(to: UInt8.self)
			var detailedPixels = 0
			var left = pixels * 2, right = 0, bottom = pixels * 2, top = 0
			for y in 0..<retina.height {
				for x in 0..<retina.width {
					let alpha = retinaData[y * retina.bytesPerRow + x * 4 + 3]
					if alpha != normalData[(y / 2) * normal.bytesPerRow + (x / 2) * 4 + 3] { detailedPixels += 1 }
					if alpha > 127 { left = min(left, x); right = max(right, x); bottom = min(bottom, y); top = max(top, y) }
				}
			}
			XCTAssertGreaterThan(detailedPixels, 20, "Retina must draw glyph detail, not magnify a 1x bitmap")
			// Bundled TypeScript ink: 606 × 385 units per em, at Seti's declared 150%.
			XCTAssertEqual(CGFloat(right - left + 1), pointSize * 1.5 * 0.606 * 2, accuracy: 2)
			XCTAssertEqual(CGFloat(top - bottom + 1), pointSize * 1.5 * 0.385 * 2, accuracy: 2)
			XCTAssertEqual(CGFloat(left + right + 1) / 2, CGFloat(pixels), accuracy: 1)
			XCTAssertEqual(CGFloat(bottom + top + 1) / 2, CGFloat(pixels), accuracy: 1)
		}
	}

	private func raster(_ image: NSImage, scale: CGFloat) throws -> CGContext {
		let context = try XCTUnwrap(CGContext(data: nil, width: Int(image.size.width * scale),
			height: Int(image.size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
			space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
		context.scaleBy(x: scale, y: scale)
		NSGraphicsContext.saveGraphicsState()
		defer { NSGraphicsContext.restoreGraphicsState() }
		NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
		image.draw(in: NSRect(origin: .zero, size: image.size))
		return context
	}

	func testResourceNotDecoratedLabelDeterminesIcon() throws {
		let icons = try seti()
		for theme in ["vs-seti", "mac-native"] {
		for name in ["README.md", "Package.swift", "Info.plist", "run.sh", "app.ts", "image.png", "unknown.xyzzy"] {
			let resource = "file:///fixture/\(name)"
			let original = try XCTUnwrap(NativeFileIcon.image(resource: resource, label: name, theme: theme, languageID: "typescript", seti: icons))
			for label in ["Preview \(name)", "\(name) (Working Tree)", "\(name)  nested/path"] {
				let decorated = try XCTUnwrap(NativeFileIcon.image(resource: resource, label: label, theme: theme, languageID: "typescript", seti: icons))
				XCTAssertEqual(original.tiffRepresentation, decorated.tiffRepresentation, name)
			}
			let git = NativeFileIcon.image(resource: "git:/fixture/\(name)?ref=HEAD", label: "Diff", theme: theme, languageID: "typescript", seti: icons)
			XCTAssertEqual(original.tiffRepresentation, git?.tiffRepresentation, name)
			XCTAssertFalse(original.isTemplate, "Git status must not tint the file icon")
		}
		}
	}

	func testFallbackAndDirectoryIconsArePresent() throws {
		for name in ["no-extension", "deleted.unknown-extension", "run.sh", "main.swift", "README.md"] {
			let file = try XCTUnwrap(NativeFileIcon.image(resource: "file:///missing/\(name)", label: name, theme: "mac-native"))
			let folder = try XCTUnwrap(NativeFileIcon.image(resource: "file:///missing/\(name)", label: name, isDirectory: true, theme: "mac-native"))
			XCTAssertNotNil(file.tiffRepresentation)
			XCTAssertNotEqual(file.tiffRepresentation, folder.tiffRepresentation)
		}
	}
}
