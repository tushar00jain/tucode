// swift-tools-version: 6.0

import PackageDescription
import Foundation

let rustLibraries = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
	.appendingPathComponent("../src-tauri/target/dev-small").standardizedFileURL.path

let package = Package(
	name: "TucodeMac",
	platforms: [.macOS(.v14)],
	products: [
		.executable(name: "TucodeMac", targets: ["TucodeMac"])
	],
	targets: [
		.systemLibrary(name: "CTucode"),
		.executableTarget(name: "TucodeMac", dependencies: ["CTucode"], linkerSettings: [
			.linkedLibrary("tscode_mac"),
			.unsafeFlags(["-L", rustLibraries,
				"-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
				"-Xlinker", "-rpath", "-Xlinker", rustLibraries])
		]),
		.testTarget(name: "TucodeMacTests", dependencies: ["TucodeMac"])
	],
	swiftLanguageModes: [.v5]
)
