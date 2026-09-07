// swift-tools-version: 6.0

import PackageDescription
import Foundation

let rustTarget = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
	.appendingPathComponent("../src-tauri/target").standardizedFileURL.path

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
			.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
			.unsafeFlags(["-L", rustTarget + "/dev-small",
				"-Xlinker", "-rpath", "-Xlinker", rustTarget + "/dev-small"], .when(configuration: .debug)),
			.unsafeFlags(["-L", rustTarget + "/release"], .when(configuration: .release))
		]),
		.testTarget(name: "TucodeMacTests", dependencies: ["TucodeMac"])
	],
	swiftLanguageModes: [.v5]
)
