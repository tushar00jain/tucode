import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private enum ToolError: Error, CustomStringConvertible {
	case message(String)

	var description: String {
		switch self { case .message(let value): return value }
	}
}

private func runningApplications(_ bundleIdentifier: String) throws -> [NSRunningApplication] {
	let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
	guard !applications.isEmpty else {
		throw ToolError.message("No running application with bundle identifier \(bundleIdentifier)")
	}
	return applications
}

private func windowID(processIdentifiers: Set<pid_t>, label: String) throws -> CGWindowID {
	guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements],
		kCGNullWindowID) as? [[String: Any]] else {
		throw ToolError.message("Could not read the on-screen window list")
	}
	let candidates = windows.compactMap { window -> (CGWindowID, CGFloat)? in
		guard let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t,
			processIdentifiers.contains(ownerPID),
			(window[kCGWindowLayer as String] as? Int) == 0,
			let number = window[kCGWindowNumber as String] as? CGWindowID,
			let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
			bounds.width > 100, bounds.height > 100 else { return nil }
		return (number, bounds.width * bounds.height)
	}
	guard let result = candidates.max(by: { $0.1 < $1.1 }) else {
		throw ToolError.message("No normal on-screen window for \(label)")
	}
	return result.0
}

private func windowID(for bundleIdentifier: String) throws -> CGWindowID {
	try windowID(processIdentifiers: Set(try runningApplications(bundleIdentifier).map(\.processIdentifier)),
		label: bundleIdentifier)
}

private func windowID(for processIdentifier: pid_t) throws -> CGWindowID {
	try windowID(processIdentifiers: [processIdentifier], label: "process \(processIdentifier)")
}

private func windowBounds(processIdentifier: pid_t) throws -> CGRect {
	let identifier = try windowID(for: processIdentifier)
	guard let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow], identifier)
		as? [[String: Any]], let window = windows.first,
		let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
		let bounds = CGRect(dictionaryRepresentation: boundsDictionary) else {
		throw ToolError.message("Could not read bounds for process \(processIdentifier)")
	}
	return bounds
}

private func latestPID(for bundleIdentifier: String) throws -> pid_t {
	let applications = try runningApplications(bundleIdentifier)
	return applications.max {
		($0.launchDate ?? .distantPast) < ($1.launchDate ?? .distantPast)
	}!.processIdentifier
}

private func application(processIdentifier: pid_t) throws -> NSRunningApplication {
	guard let application = NSRunningApplication(processIdentifier: processIdentifier) else {
		throw ToolError.message("No running application with process identifier \(processIdentifier)")
	}
	return application
}

private func activate(processIdentifier: pid_t) throws {
	let application = try application(processIdentifier: processIdentifier)
	if application.isHidden { application.unhide() }
	guard application.activate(options: [.activateAllWindows]) else {
		throw ToolError.message("Could not activate process \(processIdentifier) on the current Space")
	}
}

private func terminate(processIdentifier: pid_t) throws {
	let application = try application(processIdentifier: processIdentifier)
	guard application.terminate() else {
		throw ToolError.message("Could not terminate process \(processIdentifier)")
	}
	let deadline = Date().addingTimeInterval(5)
	while !application.isTerminated && RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		&& Date() < deadline {}
}

private func click(at point: CGPoint) throws {
	guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
		mouseCursorPosition: point, mouseButton: .left),
		let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
			mouseCursorPosition: point, mouseButton: .left) else {
		throw ToolError.message("Could not create a mouse event")
	}
	down.post(tap: .cghidEventTap)
	up.post(tap: .cghidEventTap)
}

private func setFrame(processIdentifier: pid_t, frame: CGRect) throws {
	_ = try application(processIdentifier: processIdentifier)
	let window = try accessibilityWindow(processIdentifier: processIdentifier)
	var position = frame.origin
	var size = frame.size
	guard let positionValue = AXValueCreate(.cgPoint, &position),
		let sizeValue = AXValueCreate(.cgSize, &size),
		AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, positionValue) == .success,
		AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue) == .success else {
		throw ToolError.message(
			"Could not size the window. Allow the terminal Accessibility access in System Settings."
		)
	}
}

private func accessibilityWindow(processIdentifier: pid_t) throws -> AXUIElement {
	_ = try application(processIdentifier: processIdentifier)
	let applicationElement = AXUIElementCreateApplication(processIdentifier)
	var rawWindows: CFTypeRef?
	guard AXUIElementCopyAttributeValue(applicationElement, kAXWindowsAttribute as CFString,
		&rawWindows) == .success,
		let windows = rawWindows as? [AXUIElement], let window = windows.first else {
		throw ToolError.message(
			"Could not access the window. Allow the terminal Accessibility access in System Settings."
		)
	}
	return window
}

private func fullScreen(processIdentifier: pid_t) throws -> Bool {
	let window = try accessibilityWindow(processIdentifier: processIdentifier)
	var rawValue: CFTypeRef?
	guard AXUIElementCopyAttributeValue(window, "AXFullScreen" as CFString,
		&rawValue) == .success, let value = rawValue as? NSNumber else {
		throw ToolError.message(
			"Could not read the window's full-screen state."
		)
	}
	return value.boolValue
}

private func setFullScreen(processIdentifier: pid_t, value: Bool) throws {
	guard try fullScreen(processIdentifier: processIdentifier) != value else { return }
	try activate(processIdentifier: processIdentifier)
	let window = try accessibilityWindow(processIdentifier: processIdentifier)
	var rawButton: CFTypeRef?
	guard AXUIElementCopyAttributeValue(window, "AXFullScreenButton" as CFString,
		&rawButton) == .success, let button = rawButton as! AXUIElement?,
		AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
		throw ToolError.message("Could not press the window's full-screen button.")
	}
}

private func compose(referencePath: String, actualPath: String, outputPath: String) throws {
	guard let reference = NSImage(contentsOfFile: referencePath),
		let actual = NSImage(contentsOfFile: actualPath) else {
		throw ToolError.message("Could not load one of the captured PNG files")
	}
	let headerHeight: CGFloat = 34
	let gap: CGFloat = 12
	let canvasSize = NSSize(width: reference.size.width + gap + actual.size.width,
		height: headerHeight + max(reference.size.height, actual.size.height))
	let image = NSImage(size: canvasSize)
	image.lockFocus()
	NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
	NSRect(origin: .zero, size: canvasSize).fill()
	NSGraphicsContext.current?.imageInterpolation = .none
	reference.draw(at: .zero, from: .zero, operation: .copy, fraction: 1)
	actual.draw(at: NSPoint(x: reference.size.width + gap, y: 0), from: .zero,
		operation: .copy, fraction: 1)
	let attributes: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: 14, weight: .semibold),
		.foregroundColor: NSColor.white
	]
	("Xcode" as NSString).draw(at: NSPoint(x: 10, y: canvasSize.height - 24), withAttributes: attributes)
	("Tucode" as NSString).draw(at: NSPoint(x: reference.size.width + gap + 10,
		y: canvasSize.height - 24), withAttributes: attributes)
	image.unlockFocus()
	guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
		let png = bitmap.representation(using: .png, properties: [:]) else {
		throw ToolError.message("Could not encode the comparison PNG")
	}
	try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
}

private func verifySamePixelSize(referencePath: String, actualPath: String) throws {
	guard let reference = NSImage(contentsOfFile: referencePath)?.cgImage(forProposedRect: nil,
		context: nil, hints: nil),
		let actual = NSImage(contentsOfFile: actualPath)?.cgImage(forProposedRect: nil,
			context: nil, hints: nil) else {
		throw ToolError.message("Could not decode captures for size verification")
	}
	guard reference.width == actual.width, reference.height == actual.height else {
		throw ToolError.message(
			"Capture sizes differ: Xcode \(reference.width)x\(reference.height), "
				+ "Tucode \(actual.width)x\(actual.height)"
		)
	}
}

private struct Raster {
	let width: Int
	let height: Int
	let pixels: [UInt8]
}

private struct BlueComponent {
	let points: [Int]
	let minX: Int
	let minY: Int
	let maxX: Int
	let maxY: Int

	var width: Int { maxX - minX + 1 }
	var height: Int { maxY - minY + 1 }
}

private func raster(at path: String) throws -> Raster {
	guard let source = NSImage(contentsOfFile: path),
		let cgImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
		throw ToolError.message("Could not decode \(path)")
	}
	let width = cgImage.width
	let height = cgImage.height
	var pixels = [UInt8](repeating: 0, count: width * height * 4)
	let created = pixels.withUnsafeMutableBytes { bytes -> Bool in
		guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
			bitsPerComponent: 8, bytesPerRow: width * 4,
			space: CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
		context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
		return true
	}
	guard created else { throw ToolError.message("Could not rasterize \(path)") }
	return Raster(width: width, height: height, pixels: pixels)
}

private func selectedBlueComponent(in raster: Raster) throws -> BlueComponent {
	let count = raster.width * raster.height
	var blue = [Bool](repeating: false, count: count)
	for index in 0..<count {
		let offset = index * 4
		let red = Int(raster.pixels[offset])
		let green = Int(raster.pixels[offset + 1])
		let blueChannel = Int(raster.pixels[offset + 2])
		let alpha = Int(raster.pixels[offset + 3])
		blue[index] = alpha > 180 && blueChannel > 140 && blueChannel > red + 55
			&& blueChannel > green + 20
	}

	var visited = [Bool](repeating: false, count: count)
	var largest: [Int] = []
	for start in 0..<count where blue[start] && !visited[start] {
		var queue = [start]
		visited[start] = true
		var cursor = 0
		while cursor < queue.count {
			let index = queue[cursor]
			cursor += 1
			let x = index % raster.width
			let y = index / raster.width
			if x > 0 {
				let next = index - 1
				if blue[next] && !visited[next] { visited[next] = true; queue.append(next) }
			}
			if x + 1 < raster.width {
				let next = index + 1
				if blue[next] && !visited[next] { visited[next] = true; queue.append(next) }
			}
			if y > 0 {
				let next = index - raster.width
				if blue[next] && !visited[next] { visited[next] = true; queue.append(next) }
			}
			if y + 1 < raster.height {
				let next = index + raster.width
				if blue[next] && !visited[next] { visited[next] = true; queue.append(next) }
			}
		}
		let xs = queue.map { $0 % raster.width }
		let ys = queue.map { $0 / raster.width }
		let componentWidth = (xs.max() ?? 0) - (xs.min() ?? 0) + 1
		let componentHeight = (ys.max() ?? 0) - (ys.min() ?? 0) + 1
		let aspect = Double(componentWidth) / Double(componentHeight)
		if (20...80).contains(componentWidth), (20...80).contains(componentHeight),
			(0.75...1.25).contains(aspect), queue.count > largest.count {
			largest = queue
		}
	}
	guard largest.count > 50 else {
		throw ToolError.message("Could not locate the blue navigator selection")
	}
	let xs = largest.map { $0 % raster.width }
	let ys = largest.map { $0 / raster.width }
	return BlueComponent(points: largest, minX: xs.min()!, minY: ys.min()!,
		maxX: xs.max()!, maxY: ys.max()!)
}

private func normalizedSilhouette(_ component: BlueComponent, rasterWidth: Int,
	stride: Int) -> Set<Int> {
	var rows = [[Int]](repeating: [], count: component.height)
	for point in component.points {
		rows[(point / rasterWidth) - component.minY].append((point % rasterWidth) - component.minX)
	}
	var result = Set<Int>()
	for (y, row) in rows.enumerated() {
		guard let minimum = row.min(), let maximum = row.max() else { continue }
		for x in minimum...maximum { result.insert(y * stride + x) }
	}
	return result
}

private func drawMask(_ component: BlueComponent, rasterWidth: Int, origin: NSPoint, scale: CGFloat) {
	NSColor.systemBlue.setFill()
	for point in component.points {
		let x = CGFloat((point % rasterWidth) - component.minX) * scale
		let y = CGFloat((point / rasterWidth) - component.minY) * scale
		NSRect(x: origin.x + x, y: origin.y + y, width: scale, height: scale).fill()
	}
}

private func analyzeSelection(referencePath: String, actualPath: String, detailPath: String,
	reportPath: String) throws {
	let referenceRaster = try raster(at: referencePath)
	let actualRaster = try raster(at: actualPath)
	let reference = try selectedBlueComponent(in: referenceRaster)
	let actual = try selectedBlueComponent(in: actualRaster)
	let comparisonStride = max(reference.width, actual.width)
	let referenceMask = normalizedSilhouette(reference, rasterWidth: referenceRaster.width,
		stride: comparisonStride)
	let actualMask = normalizedSilhouette(actual, rasterWidth: actualRaster.width,
		stride: comparisonStride)
	let union = referenceMask.union(actualMask)
	let mismatch = union.isEmpty ? 0 : Double(referenceMask.symmetricDifference(actualMask).count)
		/ Double(union.count)
	let sizeDelta = max(abs(reference.width - actual.width), abs(reference.height - actual.height))
	let passed = sizeDelta == 0 && mismatch <= 0.03

	let scale: CGFloat = 6
	let padding: CGFloat = 8
	let header: CGFloat = 28
	let panelWidth = CGFloat(max(reference.width, actual.width)) * scale + padding * 2
	let panelHeight = CGFloat(max(reference.height, actual.height)) * scale + padding * 2 + header
	let detail = NSImage(size: NSSize(width: panelWidth * 2, height: panelHeight))
	detail.lockFocus()
	NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
	NSRect(origin: .zero, size: detail.size).fill()
	drawMask(reference, rasterWidth: referenceRaster.width,
		origin: NSPoint(x: padding, y: padding), scale: scale)
	drawMask(actual, rasterWidth: actualRaster.width,
		origin: NSPoint(x: panelWidth + padding, y: padding), scale: scale)
	let attributes: [NSAttributedString.Key: Any] = [
		.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold),
		.foregroundColor: NSColor.white
	]
	("Xcode \(reference.width)x\(reference.height)" as NSString).draw(
		at: NSPoint(x: padding, y: panelHeight - 21), withAttributes: attributes)
	("Tucode \(actual.width)x\(actual.height)" as NSString).draw(
		at: NSPoint(x: panelWidth + padding, y: panelHeight - 21), withAttributes: attributes)
	detail.unlockFocus()
	guard let tiff = detail.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
		let png = bitmap.representation(using: .png, properties: [:]) else {
		throw ToolError.message("Could not encode the selection-detail PNG")
	}
	try png.write(to: URL(fileURLWithPath: detailPath), options: .atomic)

	let report = """
	Xcode selection:  \(reference.width)x\(reference.height) px, \(reference.points.count) blue pixels
	Tucode selection: \(actual.width)x\(actual.height) px, \(actual.points.count) blue pixels
	Maximum dimension delta: \(sizeDelta) px
	Centered outer-silhouette mismatch: \(String(format: "%.2f", mismatch * 100))%
	Geometry gate: \(passed ? "PASS" : "FAIL")
	"""
	try report.write(toFile: reportPath, atomically: true, encoding: .utf8)
	if !passed {
		throw ToolError.message("Navigator selection does not match Xcode; see \(reportPath)")
	}
}

do {
	let arguments = Array(CommandLine.arguments.dropFirst())
	guard let command = arguments.first else { throw ToolError.message("Missing command") }
	switch command {
	case "pids" where arguments.count == 2:
		let processIdentifiers = NSRunningApplication
			.runningApplications(withBundleIdentifier: arguments[1])
			.map(\.processIdentifier)
			.sorted()
		print(processIdentifiers.map(String.init).joined(separator: " "))
	case "latest-pid" where arguments.count == 2:
		print(try latestPID(for: arguments[1]))
	case "activate" where arguments.count == 2:
		guard let processIdentifier = pid_t(arguments[1]) else {
			throw ToolError.message("activate expects a process identifier")
		}
		try activate(processIdentifier: processIdentifier)
	case "terminate" where arguments.count == 2:
		guard let processIdentifier = pid_t(arguments[1]) else {
			throw ToolError.message("terminate expects a process identifier")
		}
		try terminate(processIdentifier: processIdentifier)
	case "click" where arguments.count == 3:
		guard let x = Double(arguments[1]), let y = Double(arguments[2]) else {
			throw ToolError.message("click expects numeric screen coordinates")
		}
		try click(at: CGPoint(x: x, y: y))
	case "window-id" where arguments.count == 2:
		print(try windowID(for: arguments[1]))
	case "window-id-pid" where arguments.count == 2:
		guard let processIdentifier = pid_t(arguments[1]) else {
			throw ToolError.message("window-id-pid expects a process identifier")
		}
		print(try windowID(for: processIdentifier))
	case "window-bounds-pid" where arguments.count == 2:
		guard let processIdentifier = pid_t(arguments[1]) else {
			throw ToolError.message("window-bounds-pid expects a process identifier")
		}
		let bounds = try windowBounds(processIdentifier: processIdentifier)
		print("\(Int(bounds.minX)) \(Int(bounds.minY)) \(Int(bounds.width)) \(Int(bounds.height))")
	case "set-frame" where arguments.count == 6:
		guard let x = Double(arguments[2]), let y = Double(arguments[3]),
			let width = Double(arguments[4]), let height = Double(arguments[5]) else {
			throw ToolError.message("set-frame dimensions must be numbers")
		}
		try setFrame(processIdentifier: try latestPID(for: arguments[1]),
			frame: CGRect(x: x, y: y, width: width, height: height))
	case "set-frame-pid" where arguments.count == 6:
		guard let processIdentifier = pid_t(arguments[1]), let x = Double(arguments[2]),
			let y = Double(arguments[3]), let width = Double(arguments[4]),
			let height = Double(arguments[5]) else {
			throw ToolError.message("set-frame-pid expects a PID and numeric dimensions")
		}
		try setFrame(processIdentifier: processIdentifier,
			frame: CGRect(x: x, y: y, width: width, height: height))
	case "full-screen-pid" where arguments.count == 2:
		guard let processIdentifier = pid_t(arguments[1]) else {
			throw ToolError.message("full-screen-pid expects a process identifier")
		}
		print(try fullScreen(processIdentifier: processIdentifier) ? "1" : "0")
	case "set-full-screen-pid" where arguments.count == 3:
		guard let processIdentifier = pid_t(arguments[1]),
			let value = ["0": false, "1": true][arguments[2]] else {
			throw ToolError.message("set-full-screen-pid expects a PID and 0 or 1")
		}
		try setFullScreen(processIdentifier: processIdentifier, value: value)
	case "compose" where arguments.count == 4:
		try compose(referencePath: arguments[1], actualPath: arguments[2], outputPath: arguments[3])
	case "verify-size" where arguments.count == 3:
		try verifySamePixelSize(referencePath: arguments[1], actualPath: arguments[2])
	case "analyze-selection" where arguments.count == 5:
		try analyzeSelection(referencePath: arguments[1], actualPath: arguments[2],
			detailPath: arguments[3], reportPath: arguments[4])
	default:
		throw ToolError.message("Expected process/window control, compose, or analyze-selection command")
	}
} catch {
	fputs("visual-compare: \(error)\n", stderr)
	exit(1)
}
