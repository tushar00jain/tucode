import XCTest
import AppKit

@MainActor
final class EventLoopUITests: XCTestCase {
	private var launchedApp: XCUIApplication?

	override func tearDownWithError() throws {
		if let launchedApp, launchedApp.state != .notRunning {
			launchedApp.terminate()
			_ = launchedApp.wait(for: .notRunning, timeout: 5)
		}
		launchedApp = nil
	}

	func testCommandCenterOpensExistingQuickAccess() throws {
		continueAfterFailure = false
		let (app, field) = try launchQuickInputFixture()
		XCTAssertTrue(wait(for: NSPredicate(format: "hittable == true"), on: field, timeout: 5))
		XCTAssertTrue(waitForQuickInput(app, open: false))
		XCTAssertEqual(app.windows.firstMatch.frame.width, 1120, accuracy: 1,
			"the app layout must not shrink the window to the sidebar's fitting width")
		let editorTabs = app.scrollViews["tucode.editor.tabs"]
		XCTAssertTrue(editorTabs.exists)
		XCTAssertGreaterThan(editorTabs.frame.width, 600, "the editor must keep its share of the content width")
		let collapsedFrame = field.frame
		let column = app.descendants(matching: .any).matching(identifier: "tucode.editor.column").firstMatch
		XCTAssertTrue(column.searchFields["tucode.quickInput.field"].exists,
			"the editor column must host the persistent field")
		XCTAssertTrue(column.frame.contains(collapsedFrame))
		field.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "placeholderValue CONTAINS %@", "Search files"), on: field, timeout: 3))
		XCTAssertTrue(column.searchFields["tucode.quickInput.field"].isHittable)
		XCTAssertEqual(app.searchFields.matching(identifier: "tucode.quickInput.field").count, 1)
		XCTAssertFalse(app.buttons["tucode.commandCenter"].exists)
		XCTAssertEqual(field.value as? String, "", "Command Center opens file Quick Access, not the command-only provider")
		field.typeText("Package.swift")
		let status = suggestion(app, containing: "Package.swift")
		XCTAssertTrue(waitForText(status, containing: "Package.swift", timeout: 3), app.debugDescription)
		let popup = suggestionsPopover(app)
		XCTAssertEqual(popup.frame.width, field.frame.width - 2, accuracy: 2,
			"results must match the visible input width, not size to the shortest result")
		XCTAssertGreaterThanOrEqual(popup.frame.height, 230,
			"Quick Open must retain a usable results viewport when only a few files match")
		XCTAssertGreaterThanOrEqual(popup.frame.minY, field.frame.maxY - 2,
			"results must be separate and below the input")
		let expanded = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		expanded.name = "Expanded Native Quick Open"; expanded.lifetime = .keepAlways; add(expanded)
		field.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false))
		XCTAssertTrue(field.isHittable, "the same input remains available after cancel")
		XCTAssertTrue(column.searchFields["tucode.quickInput.field"].isHittable)
		let appearance = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		appearance.name = "Native Command Center"; appearance.lifetime = .keepAlways; add(appearance)
		app.typeKey("p", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "placeholderValue CONTAINS %@", "command"), on: field, timeout: 3))
		field.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false))
		app.typeKey("p", modifierFlags: [.command])
		XCTAssertTrue(wait(for: NSPredicate(format: "placeholderValue CONTAINS %@", "Search files"), on: field, timeout: 3))
		field.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false))
		field.click()
		field.typeKey("a", modifierFlags: .command)
		field.typeText("Package.swift")
		XCTAssertTrue(waitForText(suggestion(app, containing: "Package.swift"), containing: "Package.swift", timeout: 3), app.debugDescription)
		suggestion(app, containing: "Package.swift").click()
		XCTAssertTrue(waitForQuickInput(app, open: false))
		XCTAssertTrue(waitUntilHittable(app.buttons.matching(NSPredicate(
			format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "tucode.editor.tab.", "Package")).firstMatch), app.debugDescription)
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testEditorColumnLayoutAndQuickOpenAcceptance() throws {
		continueAfterFailure = false
		let (app, field) = try launchQuickInputFixture()
		XCTAssertTrue(waitUntilHittable(field))
		XCTAssertTrue(waitUntilHittable(app.staticTexts["Package.swift"]))
		let editorTabs = app.scrollViews["tucode.editor.tabs"]
		let editorCanvas = app.descendants(matching: .any).matching(identifier: "tucode.editor.column").firstMatch
		let collapsedFrame = field.frame
		XCTAssertEqual(field.frame.width, 368, accuracy: 2)
		XCTAssertEqual(field.frame.midX, editorCanvas.frame.midX, accuracy: 1)
		XCTAssertLessThan(field.frame.maxY, editorTabs.frame.minY)
		let window = app.windows.firstMatch
		let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -2, dy: 0))
		edge.press(forDuration: 0.1, thenDragTo: edge.withOffset(CGVector(dx: -160, dy: 0)))
		XCTAssertLessThan(window.frame.width, 1020)
		XCTAssertEqual(field.frame.width, collapsedFrame.width, accuracy: 1)
		XCTAssertEqual(field.frame.height, collapsedFrame.height, accuracy: 1)
		XCTAssertEqual(field.frame.midX, editorCanvas.frame.midX, accuracy: 1)
		let layout = XCTAttachment(screenshot: window.screenshot())
		layout.name = "Search centered in resized editor column"; layout.lifetime = .keepAlways; add(layout)
		app.typeKey("p", modifierFlags: .command)
		XCTAssertTrue(wait(for: NSPredicate(format: "placeholderValue CONTAINS %@", "Search files"), on: field, timeout: 3))
		field.typeText("Package.swift")
		field.typeKey(.return, modifierFlags: [])
		let tab = app.buttons.matching(NSPredicate(
			format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "tucode.editor.tab.", "Package")).firstMatch
		XCTAssertTrue(waitUntilHittable(tab), "Command-P and Return must open the file after resizing")
		XCTAssertEqual(field.frame.midX, editorCanvas.frame.midX, accuracy: 1)
	}

	func testQuickInputPopoverHoverAndKeyboard() throws {
		continueAfterFailure = false
		let (app, field) = try launchQuickInputFixture()
		XCTAssertTrue(waitUntilHittable(field))
		XCTAssertTrue(waitUntilHittable(app.staticTexts["Package.swift"]))
		app.typeKey("p", modifierFlags: .command)
		XCTAssertTrue(waitForQuickInput(app))
		field.typeText("Projectio.swift")
		field.typeKey(.leftArrow, modifierFlags: .command)
		for _ in 0..<9 { field.typeKey(.rightArrow, modifierFlags: []) }
		field.typeText("n")
		XCTAssertTrue(wait(for: NSPredicate(format: "value == %@", "Projection.swift"), on: field), "Unexpected query: \(field.value ?? "nil")")
		XCTAssertTrue(waitUntilHittable(app.tables["tucode.quickInput.results"].staticTexts["Projection.swift"]))
		field.typeText("X")
		XCTAssertEqual(field.value as? String, "ProjectionX.swift",
			"result refreshes must preserve native text and the middle caret")
		field.typeKey("a", modifierFlags: .command)
		field.typeText("sw")
		let table = app.tables["tucode.quickInput.results"]
		let firstResult = table.tableRows.element(boundBy: 1) // row zero is the file-results heading
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: firstResult, timeout: 5),
			"typing must focus the first file result below the section heading")
		field.typeKey(.downArrow, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == false"), on: firstResult, timeout: 3))
		field.typeText("ift")
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: firstResult, timeout: 5),
			"refining the query must reset focus to the first result, not wrap past the heading to the last")
		let host = table.tableRows.containing(.staticText, identifier: "Projection.swift").firstMatch
		XCTAssertTrue(waitUntilHittable(host), app.debugDescription)
		field.hover() // Ensure a real pointer movement even if the previous run ended on this row.
		host.hover()
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: host, timeout: 3),
			"hover must return through VS Code focus and paint the native row selection")
		XCTAssertEqual(field.value as? String, "swift", "hover must not replace the typed query")
		XCTAssertEqual(suggestionsPopover(app).frame.width, field.frame.width - 2, accuracy: 2)
		field.typeKey(.downArrow, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == false"), on: host, timeout: 3))
		field.hover()
		host.hover()
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: host, timeout: 3))
		field.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false))
		let editor = app.textViews.firstMatch
		XCTAssertTrue(waitUntilHittable(editor), "the editor must remain visible after accepting a result")
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "import Foundation", timeout: 5))
		let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		screenshot.name = "Editor after native search acceptance"
		screenshot.lifetime = .keepAlways
		add(screenshot)
	}

	func testCommandPaletteWorkflow() throws {
		continueAfterFailure = false
		let app = try launchApp()

		let macFolder = app.staticTexts["mac"]
		XCTAssertTrue(waitUntilHittable(macFolder), "Explorer rows were not painted from the shared model")
		XCTAssertFalse(app.staticTexts["tucode.navigator.section.workbench.explorer.fileView"].exists,
			"a singleton Explorer section should not paint a redundant heading")
		XCTAssertFalse(app.staticTexts["tucode.navigator.empty"].exists,
			"the native Navigator should not paint a placeholder row")

		let searchSelector = app.buttons["tucode.navigator.container.workbench.view.search"]
		XCTAssertTrue(waitUntilHittable(searchSelector), "native Search selector was not hittable")
		searchSelector.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: macFolder),
			"Search did not replace the Explorer body")

		let explorerSelector = app.buttons["tucode.navigator.container.workbench.view.explorer"]
		XCTAssertTrue(waitUntilHittable(explorerSelector), "native Explorer selector was not hittable")
		explorerSelector.click()
		XCTAssertTrue(waitUntilHittable(macFolder), "Explorer did not return through the same native selector")
		let appFolder = app.staticTexts["App"]
		XCTAssertTrue(expand(macFolder, revealing: appFolder), "Explorer expansion did not publish the mac directory children")
		let appOutlineRow = app.outlineRows.containing(NSPredicate(format: "value == %@", "App")).firstMatch
		let infoPlistRow = app.outlineRows.containing(
			NSPredicate(format: "value == %@", "Info.plist")).firstMatch
		XCTAssertTrue(expand(appFolder, revealing: infoPlistRow),
			"nested Explorer expansion did not paint the VS Code-rendered file row")
		XCTAssertTrue(appOutlineRow.isSelected, "Explorer selection moved away from the expanded folder")
		appFolder.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: infoPlistRow),
			"Explorer collapse did not remove the model-owned child row")
		XCTAssertTrue(appOutlineRow.isSelected, "Explorer selection moved away from the collapsed folder")

		let initialFrame = app.windows.firstMatch.frame
		app.typeKey("p", modifierFlags: [.command, .shift])
		let shortcutError = app.staticTexts["tucode.bootstrap.error"]
		if shortcutError.waitForExistence(timeout: 1) {
			XCTFail("Command Palette shortcut failed: \(shortcutError.label) \(String(describing: shortcutError.value))")
		}

		let field = app.searchFields["tucode.quickInput.field"]
		XCTAssertTrue(waitForQuickInput(app),
			"real Command Palette command did not produce a native quick-input field")
		let panelFrame = field.frame
		let windowFrame = app.windows.firstMatch.frame
		XCTAssertGreaterThanOrEqual(panelFrame.minX, windowFrame.minX,
			"Command Palette extended beyond the left edge of the app")
		XCTAssertLessThanOrEqual(panelFrame.maxX, windowFrame.maxX,
			"Command Palette extended beyond the right edge of the app")
		XCTAssertEqual(field.value as? String, ">",
			"native field did not paint the value from QuickInputProjection")

		let firstRow = suggestionsPopover(app).staticTexts.firstMatch
		let populated = XCTNSPredicateExpectation(
			predicate: NSPredicate(format: "label.length > 0 OR value.length > 0"),
			object: firstRow
		)
		XCTAssertEqual(XCTWaiter.wait(for: [populated], timeout: 15), .completed,
			"real command provider did not publish a non-empty projected command row")
		let projectedFrame = app.windows.firstMatch.frame
		XCTAssertEqual(projectedFrame.origin.x, initialFrame.origin.x, accuracy: 1,
			"opening projected UI moved the application window horizontally")
		XCTAssertEqual(projectedFrame.origin.y, initialFrame.origin.y, accuracy: 1,
			"opening projected UI moved the application window vertically")
		XCTAssertEqual(projectedFrame.width, initialFrame.width, accuracy: 1,
			"opening projected UI changed the application window width")
		XCTAssertEqual(projectedFrame.height, initialFrame.height, accuracy: 1,
			"opening projected UI changed the application window height")

		verifyPaletteInputAndAcceptance(app, field: field)
	}

	func testQuickInputCommandPaletteNavigation() throws {
		continueAfterFailure = false
		let (app, field) = try launchQuickInputFixture()
		XCTAssertTrue(waitUntilHittable(app.staticTexts["Package.swift"]))
		app.typeKey("p", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForQuickInput(app))
		XCTAssertEqual(field.value as? String, ">")
		verifyPaletteInputAndAcceptance(app, field: field)
	}

	private func verifyPaletteInputAndAcceptance(_ app: XCUIApplication, field: XCUIElement) {
		field.typeText("copy path active")
		let updated = XCTNSPredicateExpectation(
			predicate: NSPredicate(format: "value == %@", ">copy path active"),
			object: field
		)
		XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 15), .completed,
			"typed AppKit text was overwritten during result updates")

		XCTAssertTrue(waitForText(suggestion(app, containing: "Copy Path of Active File"), containing: "Copy Path of Active File"),
			"command provider did not publish the filtered command back to the native results")

		app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on:
			suggestionsPopover(app).tableRows.containing(NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", "Copy Relative Path of Active File", "Copy Relative Path of Active File")).firstMatch),
			"Down Arrow did not move native suggestion selection: \(suggestionsPopover(app).debugDescription)")
		app.typeKey(XCUIKeyboardKey.upArrow.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on:
			suggestionsPopover(app).tableRows.containing(NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", "Copy Path of Active File", "Copy Path of Active File")).firstMatch),
			"Up Arrow did not move native suggestion selection")

		app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false),
			"Escape did not cancel the shared Quick Input session and collapse its results")

		app.typeKey("p", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForQuickInput(app), "Command Palette did not reopen in the same app session")
		XCTAssertEqual(field.value as? String, ">", "reopened projection retained the previous query")
		field.typeText("toggle auto save")
		XCTAssertTrue(waitForText(suggestion(app, containing: "Toggle Auto Save"), containing: "Toggle Auto Save"),
			"command provider did not publish the command selected for acceptance")
		app.typeKey(XCUIKeyboardKey.return.rawValue, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false),
			"Return did not accept the focused command and collapse its results")

		app.typeKey("q", modifierFlags: .command)
		XCTAssertTrue(app.wait(for: .notRunning, timeout: 5),
			"Command-Q did not remain owned by the native application menu")
	}

	func testNativeChangesRepositoriesAndPersistentFilter() throws {
		try verifyNativeChanges(multiRoot: false)
	}

	func testNativeChangesMultipleWorkspaceRoots() throws {
		try verifyNativeChanges(multiRoot: true)
	}

	func testFileIconThemeSelection() throws {
		continueAfterFailure = false
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let app = try launchApp(repository: URL(fileURLWithPath: fixturePath).appendingPathComponent("mac"))
		let package = app.staticTexts["Package.swift"]
		XCTAssertTrue(wait(for: NSPredicate(format: "hittable == true"), on: package, timeout: 5))
		let field = app.searchFields["tucode.quickInput.field"]
		func expectText(_ text: String) {
			let status = suggestion(app, containing: text)
			XCTAssertTrue(waitForText(status, containing: text, timeout: 3),
				"Expected \(text); input: \(String(describing: field.value)); status: \(String(describing: status.value))")
		}
		func expectHidden() {
			XCTAssertTrue(waitForQuickInput(app, open: false))
		}
		func openPicker() {
			app.typeKey("p", modifierFlags: [.command, .shift])
			XCTAssertTrue(waitForQuickInput(app))
			field.click()
			// Quick Access may restore the last query. Replace it explicitly, including its prefix.
			field.typeKey("a", modifierFlags: .command)
			field.typeText(">Preferences: File Icon Theme")
			expectText("File Icon Theme")
			field.typeKey(.return, modifierFlags: [])
			XCTAssertTrue(wait(for: NSPredicate(format: "value == %@", ""), on: field, timeout: 3))
		}
		func select(_ theme: String) {
			field.typeText(theme)
			expectText(theme)
			field.typeKey(.return, modifierFlags: [])
			expectHidden()
			let appearance = XCTAttachment(screenshot: app.screenshot())
			appearance.name = "File icons — \(theme)"; appearance.lifetime = .keepAlways; add(appearance)
		}
		openPicker()
		expectText("Mac Native")
		select("Seti")
		app.terminate(); app.launch()
		XCTAssertTrue(wait(for: NSPredicate(format: "hittable == true"), on: package, timeout: 5))
		openPicker()
		expectText("Seti") // Selection must persist across relaunch.
		field.typeText("Mac Native")
		expectText("Mac Native")
		field.typeKey(.escape, modifierFlags: [])
		expectHidden()
		openPicker()
		expectText("Seti") // Canceling preview must restore the selected theme.
		select("None")
		openPicker(); select("Mac Native")
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testNativeSearchQueryAndPinnedFilter() throws {
		continueAfterFailure = false
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let fixture = URL(fileURLWithPath: fixturePath).appendingPathComponent("mac")
		let app = try launchApp(repository: fixture)
		let search = app.buttons["tucode.navigator.container.workbench.view.search"]
		XCTAssertTrue(waitUntilHittable(search)); search.click()
		let query = app.searchFields["tucode.search.query"]
		let filter = app.searchFields["tucode.search.filter"]
		XCTAssertTrue(waitUntilHittable(query))
		XCTAssertGreaterThan(query.frame.minY - search.frame.maxY, 4,
			"the query border must have visible clearance below the navigator selector")
		XCTAssertTrue(waitUntilHittable(filter), "Search must retain its bottom Filter field")
		query.click(); query.typeText("import "); query.typeKey(.return, modifierFlags: [])
		let host = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "Projection.swift")).firstMatch
		let editor = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "EditorAreaView.swift")).firstMatch
		XCTAssertTrue(waitUntilHittable(host), app.debugDescription)
		XCTAssertTrue(waitUntilHittable(editor), app.debugDescription)
		XCTAssertLessThan(query.frame.maxY, host.frame.minY, "Content query belongs above results")
		XCTAssertGreaterThan(filter.frame.minY, host.frame.maxY, "Result filter belongs below results")
		let appearance = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		appearance.name = "Native Search controls and results"
		appearance.lifetime = .keepAlways
		add(appearance)
		query.click(); query.typeKey("a", modifierFlags: .command); query.typeText("no-native-search-match")
		query.typeKey("a", modifierFlags: .command); query.typeText("import "); query.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(host), "Replacing a query must publish only the latest results")
		XCTAssertTrue(waitUntilHittable(editor))
		let replaceToggle = app.descendants(matching: .any).matching(identifier: "tucode.search.replace.toggle").firstMatch
		replaceToggle.click()
		let replacement = app.searchFields["tucode.search.replace"]
		XCTAssertTrue(waitUntilHittable(replacement))
		replacement.click(); replacement.typeText("replacement probe")
		app.descendants(matching: .any).matching(identifier: "tucode.search.preserve-case.toggle").firstMatch.click()
		replaceToggle.click(); replaceToggle.click()
		XCTAssertTrue(waitUntilHittable(replacement))
		XCTAssertEqual(replacement.value as? String, "replacement probe", "Hiding Replace must retain the model's replacement term")
		replacement.click(); replacement.typeKey("a", modifierFlags: .command); replacement.typeKey(.delete, modifierFlags: [])
		replaceToggle.click()

		filter.click(); filter.typeText("Projection")
		XCTAssertTrue(waitUntilHittable(host))
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: editor))
		filter.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(editor))
		XCTAssertTrue(filter.isHittable)
		XCTAssertEqual(query.value as? String, "import ", "Canceling the result filter must preserve the content query")
		filter.click(); filter.typeText("Projection"); filter.typeKey(.return, modifierFlags: [])
		let tab = app.buttons.matching(NSPredicate(format: "label == %@", "Projection.swift")).firstMatch
		XCTAssertFalse(tab.exists, "Committing the filter must not open a result")
		host.click(); host.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(tab.waitForExistence(timeout: 5))
	}

	func testNativeChangesListMode() throws {
		continueAfterFailure = false
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let fixture = URL(fileURLWithPath: fixturePath).appendingPathComponent("changes")
		let app = try launchApp(arguments: ["--workspace", fixture.appendingPathComponent("list.code-workspace").path], repository: fixture)
		let changes = app.buttons["tucode.navigator.container.workbench.view.scm"]
		XCTAssertTrue(waitUntilHittable(changes)); changes.click()
		XCTAssertTrue(waitUntilHittable(app.staticTexts["repo-a"]))
		XCTAssertTrue(waitUntilHittable(app.staticTexts["repo-b"]))
		let deep = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "deep.txt  nested/one/two")).firstMatch
		XCTAssertTrue(waitUntilHittable(deep), "list mode must show the filename and repository-relative folder")
		let filter = app.searchFields["tucode.changes.filter"]
		filter.click(); filter.typeText("repo-b/nested/")
		XCTAssertTrue(waitUntilHittable(deep))
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: app.staticTexts["repo-a"]), "Filter value: \(String(describing: filter.value))")
		filter.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(app.staticTexts["repo-a"]))
		filter.click(); filter.typeText("repo-a")
		filter.typeKey("a", modifierFlags: .command); filter.typeText("repo-b/")
		XCTAssertEqual(filter.value as? String, "repo-b/", "Cmd-A must select native Filter text")
		filter.typeKey("p", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForQuickInput(app), "global Command Palette shortcut must work from Filter")
		app.typeKey(.escape, modifierFlags: [])
	}

	private func verifyNativeChanges(multiRoot: Bool) throws {
		continueAfterFailure = false
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let fixture = URL(fileURLWithPath: fixturePath).appendingPathComponent("changes")
		let arguments = multiRoot ? ["--workspace", fixture.appendingPathComponent("changes.code-workspace").path] : []
		let app = try launchApp(arguments: arguments, repository: fixture)
		let changes = app.buttons["tucode.navigator.container.workbench.view.scm"]
		XCTAssertTrue(waitUntilHittable(changes)); changes.click()
		let filter = app.searchFields["tucode.changes.filter"]
		XCTAssertTrue(waitUntilHittable(filter), "Changes must always show its bottom Filter field")
		let repoA = app.staticTexts["repo-a"]
		let repoB = app.staticTexts["repo-b"]
		XCTAssertTrue(waitUntilHittable(repoA), "\(String(describing: app.staticTexts["tucode.bootstrap.error"].value))\n\(app.debugDescription)")
		XCTAssertTrue(waitUntilHittable(repoB), app.debugDescription)
		XCTAssertTrue(app.staticTexts["Staged Changes (1)"].firstMatch.exists)
		let fileName = app.staticTexts.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.row.resource:", "repo-a", "/index/", "same.txt")).firstMatch
		let badge = app.staticTexts.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.status.resource:", "repo-a", "/index/", "same.txt")).firstMatch
		XCTAssertTrue(waitUntilHittable(fileName)); XCTAssertTrue(waitUntilHittable(badge))
		XCTAssertEqual(fileName.value as? String, "same.txt")
		XCTAssertEqual(badge.value as? String, "M")
		XCTAssertGreaterThan(badge.frame.minX, fileName.frame.maxX)
		let nestedBadge = app.staticTexts.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.status.resource:", "repo-a", "deep.txt")).firstMatch
		let untrackedBadge = app.staticTexts.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.status.resource:", "repo-a", "new.txt")).firstMatch
		XCTAssertEqual(nestedBadge.value as? String, "M")
		XCTAssertEqual(untrackedBadge.value as? String, "U")
		XCTAssertEqual(badge.frame.maxX, nestedBadge.frame.maxX, accuracy: 1)
		XCTAssertEqual(badge.frame.maxX, untrackedBadge.frame.maxX, accuracy: 1)
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "value ENDSWITH %@", "one/two")).firstMatch.exists)
		let outline = app.outlines["tucode.navigator.outline"]
		XCTAssertGreaterThan(filter.frame.midY, outline.frame.midY)
		let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		screenshot.name = multiRoot ? "Native Changes — multiple workspace roots" : "Native Changes — child repositories"
		screenshot.lifetime = .keepAlways
		add(screenshot)
		filter.click(); filter.typeText("repo-a/nested/")
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: repoB), "Filter value: \(String(describing: filter.value))")
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "deep.txt")).firstMatch.exists)
		filter.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(repoB))
		XCTAssertTrue(filter.isHittable, "Escape must retain the bottom field")
		outline.typeText("/")
		app.typeText("repo-b/")
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: repoA))
		let stagedB = app.descendants(matching: .any).matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.row.resource:", "repo-b", "/index/", "same.txt")).firstMatch
		XCTAssertTrue(waitUntilHittable(stagedB), "filtered repo-b staged file missing; value=\(String(describing: filter.value))\n\(app.debugDescription)")
		stagedB.click()
		let diffTab = app.buttons.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND label CONTAINS %@", "tucode.editor.tab.", "same.txt")).firstMatch
		XCTAssertTrue(waitUntilHittable(diffTab), "click while Filter has focus did not open the selected repository's diff; \(app.staticTexts["tucode.bootstrap.error"].exists ? String(describing: app.staticTexts["tucode.bootstrap.error"].value) : "no model error")\n\(app.debugDescription)")
		let repoBTabId = diffTab.identifier
		XCTAssertTrue(waitUntilHittable(repoA))
		XCTAssertTrue(filter.isHittable)
		let stagedA = app.descendants(matching: .any).matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.row.resource:", "repo-a", "/index/", "same.txt")).firstMatch
		XCTAssertTrue(waitUntilHittable(stagedA)); stagedA.click()
		let repoATab = app.buttons.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier != %@ AND label CONTAINS %@", "tucode.editor.tab.", repoBTabId, "same.txt")).firstMatch
		XCTAssertTrue(waitUntilHittable(repoATab), "same.txt in repo-a must open a distinct diff editor")
		app.buttons["tucode.navigator.container.workbench.view.explorer"].click()
		XCTAssertFalse(filter.isHittable)
		let explorerFilter = app.searchFields["tucode.explorer.filter"]
		XCTAssertTrue(waitUntilHittable(explorerFilter), "Explorer must retain the shared bottom field\n\(app.debugDescription)")
		XCTAssertGreaterThan(explorerFilter.frame.midY, outline.frame.midY)
		let explorerFile = app.staticTexts.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.row.", "repo-a", "same.txt")).firstMatch
		XCTAssertTrue(expand(outline.staticTexts["repo-a"], revealing: explorerFile))
		let explorerBadge = app.staticTexts.matching(NSPredicate(format:
			"identifier BEGINSWITH %@ AND identifier CONTAINS %@ AND identifier ENDSWITH %@",
			"tucode.navigator.outline.status.", "repo-a", "same.txt")).firstMatch
		XCTAssertEqual(explorerBadge.value as? String, "M")
		XCTAssertGreaterThan(explorerBadge.frame.minX, explorerFile.frame.maxX)
		outline.typeText("/")
		let explorerPrefix = multiRoot ? "" : "changes/"
		XCTAssertTrue(wait(for: NSPredicate(format: "value == %@", explorerPrefix), on: explorerFilter))
		explorerFilter.typeText("repo-a/nested/")
		XCTAssertTrue(wait(for: NSPredicate(format: "value == %@", "\(explorerPrefix)repo-a/nested/"), on: explorerFilter),
			"Opening / must place the caret after the workspace prefix, not select and replace it")
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: repoB))
		explorerFilter.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(repoB))
		XCTAssertTrue(explorerFilter.isHittable, "Escape keeps Explorer's bottom field visible")
		explorerFilter.click()
		explorerFilter.typeKey("a", modifierFlags: .command)
		explorerFilter.typeText("\(explorerPrefix)repo-b/")
		changes.click()
		XCTAssertTrue(waitUntilHittable(filter))
		XCTAssertTrue(wait(for: NSPredicate(format: "value == %@", ""), on: filter), "Explorer query must not leak into Changes")
		filter.click(); filter.typeText("repo-a/")
		app.buttons["tucode.navigator.container.workbench.view.explorer"].click()
		XCTAssertTrue(waitUntilHittable(explorerFilter))
		XCTAssertTrue(wait(for: NSPredicate(format: "value == %@", explorerPrefix), on: explorerFilter), "Switching restores Explorer's previous root")
	}

	func testCompactExplorerFolderKeepsHierarchy() throws {
		continueAfterFailure = false
		// An isolated workspace prevents persisted expansion from resolving Tests before the click.
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"],
			"run through mac/test-foreground.sh to prepare the repository-local workspace")
		let fixture = URL(fileURLWithPath: fixturePath, isDirectory: true)
		let app = try launchApp(repository: fixture)
		let macFolder = app.staticTexts["mac"]
		XCTAssertTrue(waitUntilHittable(macFolder))
		XCTAssertFalse(app.staticTexts["Show All Commands"].exists)
		XCTAssertFalse(app.staticTexts["Go to File"].exists)
		let testsFolder = app.staticTexts["Tests"]
		let packageFile = app.staticTexts["Package.swift"]
		XCTAssertTrue(expand(macFolder, revealing: packageFile))
		XCTAssertTrue(waitUntilHittable(testsFolder))
		XCTAssertTrue(waitUntilHittable(packageFile))
		let initialIndent = testsFolder.frame.minX
		testsFolder.click()
		// Resolving Tests compresses its sole child into the same upstream row.
		let compactFolder = app.staticTexts.matching(NSPredicate(
			format: "value CONTAINS %@ OR label CONTAINS %@", "TucodeMacTests", "TucodeMacTests")).firstMatch
		XCTAssertTrue(waitUntilHittable(compactFolder))
		XCTAssertEqual(compactFolder.frame.minX, initialIndent, accuracy: 1,
			"resolving a compact folder changed its indentation")
		XCTAssertLessThan(compactFolder.frame.minY, packageFile.frame.minY,
			"resolving a compact folder moved it after its parent's files")
		macFolder.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: compactFolder))
		macFolder.click()
		XCTAssertTrue(waitUntilHittable(compactFolder))
		XCTAssertEqual(compactFolder.frame.minX, initialIndent, accuracy: 1)
		XCTAssertLessThan(compactFolder.frame.minY, packageFile.frame.minY)
		macFolder.doubleClick()
		XCTAssertTrue(wait(for: NSPredicate(format: "hittable == true"), on: compactFolder, timeout: 3),
			"two clicks must collapse then expand; the second click must not be discarded")
		macFolder.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: compactFolder))
		macFolder.doubleClick()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: compactFolder, timeout: 3),
			"two clicks must expand then collapse; the second click must not be discarded")
		macFolder.click()
		XCTAssertTrue(waitUntilHittable(compactFolder),
			"a subsequent single click must still expand normally")
		packageFile.click()
		let tab = app.buttons.matching(NSPredicate(format: "label == %@", "Package.swift")).firstMatch
		XCTAssertTrue(tab.waitForExistence(timeout: 5))
		tab.hover()
		closeTab("Package.swift", in: app).click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: tab))
		XCTAssertFalse(app.staticTexts["Show All Commands"].exists)
		XCTAssertFalse(app.staticTexts["Go to File"].exists)
	}

	func testNativeExplorerUsesSharedFilterSortAndNesting() throws {
		continueAfterFailure = false
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let fixture = URL(fileURLWithPath: fixturePath, isDirectory: true).appendingPathComponent("native-explorer")
		let app = try launchApp(repository: fixture)
		let file = app.staticTexts["z-native.txt"]
		let folder = app.staticTexts["mac"]
		XCTAssertTrue(waitUntilHittable(file))
		XCTAssertTrue(waitUntilHittable(folder))
		XCTAssertFalse(app.staticTexts["hidden-native.txt"].exists, "FilesFilter did not apply files.exclude")
		XCTAssertLessThan(file.frame.minY, folder.frame.minY, "FileSorter did not apply filesFirst")
		let nested = app.staticTexts["bundle.js"]
		XCTAssertFalse(nested.exists, "nested file escaped its collapsed parent")
		app.staticTexts["bundle.ts"].click()
		app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(nested), "native expansion did not use ExplorerItem file nesting")
		app.typeKey(XCUIKeyboardKey.leftArrow.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: nested))
	}

	func testWindowResizesFromEdgeAndCornerWithoutMoving() throws {
		continueAfterFailure = false
		let app = try launchApp()
		let window = app.windows.firstMatch
		XCTAssertTrue(window.waitForExistence(timeout: 5), "application window did not appear")

		let initial = window.frame
		let rightEdge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
			.withOffset(CGVector(dx: -2, dy: 0))
		rightEdge.press(forDuration: 0.2, thenDragTo: rightEdge.withOffset(CGVector(dx: 60, dy: 0)))
		let horizontal = window.frame
		XCTAssertGreaterThan(horizontal.width, initial.width + 40,
			"dragging the right edge did not resize the window horizontally")
		XCTAssertEqual(horizontal.origin.x, initial.origin.x, accuracy: 1,
			"dragging the right edge moved the window")
		XCTAssertEqual(horizontal.origin.y, initial.origin.y, accuracy: 1,
			"dragging the right edge moved the window vertically")

		let corner = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
			.withOffset(CGVector(dx: -2, dy: -2))
		corner.press(forDuration: 0.2, thenDragTo: corner.withOffset(CGVector(dx: 50, dy: 50)))
		let diagonal = window.frame
		XCTAssertGreaterThan(diagonal.width, horizontal.width + 30,
			"dragging the bottom-right corner did not resize the window horizontally")
		XCTAssertGreaterThan(diagonal.height, horizontal.height + 30,
			"dragging the bottom-right corner did not resize the window vertically")
		XCTAssertEqual(diagonal.origin.x, horizontal.origin.x, accuracy: 1,
			"dragging the bottom-right corner moved the window")
		XCTAssertEqual(diagonal.origin.y, horizontal.origin.y, accuracy: 1,
			"dragging the bottom-right corner moved the window")
	}

	func testEditorOnlySurfaceRegressions() throws {
		continueAfterFailure = false
		let app = try launchApp()
		// The preceding editor workflow can leave mac expanded and push test below the viewport.
		let macFolder = app.staticTexts["mac"]
		XCTAssertTrue(waitUntilHittable(macFolder), "Explorer rows were not painted")
		if app.staticTexts["Package.swift"].exists { macFolder.click() }

		// Selecting a projected source-list row used to let AppKit replace the filename's
		// foreground with the row background. Exercise a real file open and inspect the selected
		// label itself, rather than only its model-owned accessibility value.
		let testFolder = app.staticTexts["test"]
		XCTAssertTrue(waitUntilHittable(testFolder), "Explorer rows were not painted")
		let nativeFolder = app.staticTexts["native"]
		XCTAssertTrue(expand(testFolder, revealing: nativeFolder), "test directory children were not painted")
		let fixturesFolder = app.staticTexts["fixtures"]
		XCTAssertTrue(expand(nativeFolder, revealing: fixturesFolder), "native test directory children were not painted")
		let fixtureName = "EditorClickFixture.swift"
		let fixtureLabel = app.outlines["tucode.navigator.outline"].staticTexts[fixtureName]
		let fixtureRow = app.outlineRows.containing(
			NSPredicate(format: "value == %@", fixtureName)).firstMatch
		XCTAssertTrue(expand(fixturesFolder, revealing: fixtureLabel), "long fixture was not visible after expanding test fixtures")
		XCTAssertTrue(waitUntilHittable(fixtureLabel), "long fixture was below the Explorer viewport")
		fixtureRow.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: fixtureRow, timeout: 2),
			"clicking the long fixture did not select its Explorer row through the model")
		XCTAssertTrue(waitUntilHittable(fixtureLabel), "selected Explorer filename disappeared")
		XCTAssertTrue(hasVisibleContrast(fixtureLabel.screenshot()),
			"selected Explorer filename painted with no visible contrast")

		// WebKit exposes WKWebView under different XCUI element types across macOS releases;
		// address the native accessibility identifier without assuming that type.
		let editor = app.descendants(matching: .any)
			.matching(identifier: "tucode.editor.contents").firstMatch
		XCTAssertTrue(editor.waitForExistence(timeout: 5), "WKWebView editor surface was not present")

		// Every one of the fixture's 200 lines contains long source text and the file extends
		// beyond the viewport. A click halfway down cannot hit an empty line or the area below EOF.
		XCTAssertTrue(waitForReadableSourceLines(in: editor, minimum: 8, timeout: 5),
			"long fixture source lines were not initially visible")
		let beforeScreenshot = editor.screenshot()
		let sourceBeforeClick = readableSourcePixelCount(beforeScreenshot)
		XCTAssertGreaterThan(sourceBeforeClick, 500,
			"long fixture did not paint enough source text to exercise the regression")
		// Click halfway down the source-filled viewport and within the fixture's long glyph run.
		editor.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.50)).click()
		let afterScreenshot = editor.screenshot()
		let sourceAfterClick = readableSourcePixelCount(afterScreenshot)
		XCTAssertGreaterThanOrEqual(Double(sourceAfterClick), Double(sourceBeforeClick) * 0.80,
			"clicking into the WK editor removed most source-text pixels")

		// The same long fixture provides enough rows to make the scaled minimap measurable.
		XCTAssertTrue(waitForVisibleMinimap(in: editor),
			"the WK editor did not paint a visible scaled minimap preview")
	}

	func testMarkdownPreviewWorkflow() throws {
		continueAfterFailure = false
		let fixturePath = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let fixture = URL(fileURLWithPath: fixturePath).appendingPathComponent("markdown")
		let app = try launchApp(repository: fixture)
		let companion = app.staticTexts["companion.swift"]
		XCTAssertTrue(waitUntilHittable(companion)); companion.click()
		let source = app.staticTexts["preview.md"]
		XCTAssertTrue(waitUntilHittable(source)); source.click()
		let editor = app.textViews.firstMatch
		XCTAssertTrue(waitUntilHittable(editor))
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "# Markdown preview fixture"))
		app.typeKey("v", modifierFlags: [.command, .shift])
		let previewTab = app.buttons.matching(NSPredicate(format: "label == %@", "Preview preview.md")).firstMatch
		XCTAssertTrue(waitUntilHittable(previewTab), app.debugDescription)
		let heading = markdownText("Markdown preview fixture", in: app)
		XCTAssertTrue(waitUntilHittable(heading), "Markdown heading was not rendered\n\(app.debugDescription)")
		XCTAssertTrue(markdownText("strong text", in: app).exists, app.debugDescription)
		XCTAssertTrue(app.webViews.tables.firstMatch.exists, "Markdown table was not rendered as a table")
		// WebKit exposes the syntax-colored spans as separate accessibility text nodes.
		for token in ["const", "previewValue", "=", "42", ";"] {
			XCTAssertTrue(markdownText(token, in: app).waitForExistence(timeout: 5), "fenced code token was not rendered: \(token)")
		}
		let companionTab = app.buttons.matching(NSPredicate(format: "label == %@", "companion.swift")).firstMatch
		let sourceTab = app.buttons.matching(NSPredicate(format: "label == %@", "preview.md")).firstMatch
		XCTAssertTrue(companionTab.exists && sourceTab.exists, "same-group preview discarded existing native tabs")
		let destination = markdownText("Preview scroll destination", in: app)
		XCTAssertFalse(destination.isHittable, "scroll fixture must extend beyond the initial viewport")
		heading.hover()
		heading.scroll(byDeltaX: 0, deltaY: -1800)
		XCTAssertTrue(waitUntilHittable(destination), "preview did not scroll to its final section")
		sourceTab.click(); editor.click()
		app.typeKey("p", modifierFlags: [.command, .shift])
		let palette = app.searchFields["tucode.quickInput.field"]
		XCTAssertTrue(waitForQuickInput(app)); palette.typeText("Markdown: Open Preview")
		XCTAssertTrue(waitForText(suggestion(app, containing: "Markdown: Open Preview"), containing: "Markdown: Open Preview"))
		app.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false))
		XCTAssertTrue(previewTab.isSelected, "Command Palette did not activate the existing preview")
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Preview preview.md")).count, 1)
		sourceTab.click(); editor.click()
		app.typeKey(.upArrow, modifierFlags: .command)
		enterInsertMode(in: app, editor: editor)
		app.typeText("# Live preview update\n\n")
		previewTab.click()
		XCTAssertTrue(markdownText("Live preview update", in: app).waitForExistence(timeout: 5), "preview did not observe unsaved model changes")
		sourceTab.click(); editor.click()
		app.typeKey("k", modifierFlags: .command)
		app.typeKey("v", modifierFlags: [])
		XCTAssertTrue(waitUntilHittable(previewTab))
		XCTAssertTrue(waitUntilHittable(editor), "side preview did not retain a visible source editor")
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: companionTab, timeout: 5), "native tab strip did not follow the preview's side group")
		editor.click()
		app.typeKey(.upArrow, modifierFlags: .command)
		enterInsertMode(in: app, editor: editor)
		app.typeText("# Visible live update\n\n")
		XCTAssertTrue(markdownText("Visible live update", in: app).waitForExistence(timeout: 5), "visible side preview did not observe unsaved source edits")
		let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		screenshot.name = "Markdown preview and source in separate groups"
		screenshot.lifetime = .keepAlways
		add(screenshot)
	}

	private func markdownText(_ value: String, in app: XCUIApplication) -> XCUIElement {
		app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR value == %@", value, value)).firstMatch
	}

	func testNewFileButtonRemainsVisible() throws {
		continueAfterFailure = false
		let app = try launchApp()
		let add = app.buttons["tucode.editor.newFile"]
		XCTAssertTrue(waitUntilHittable(add), "the plus button must exist in the empty editor")
		add.click()
		let first = app.buttons.matching(NSPredicate(format: "label == %@", "Untitled-1")).firstMatch
		XCTAssertTrue(waitUntilHittable(first), "plus must run the existing New Text File command")
		XCTAssertTrue(first.isSelected)
		app.typeKey("n", modifierFlags: .command)
		let second = app.buttons.matching(NSPredicate(format: "label == %@", "Untitled-2")).firstMatch
		XCTAssertTrue(waitUntilHittable(second), "the existing keybinding must share the same untitled lifecycle")
		add.click()
		let third = app.buttons.matching(NSPredicate(format: "label == %@", "Untitled-3")).firstMatch
		XCTAssertTrue(waitUntilHittable(third))
		let window = app.windows.firstMatch
		let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -2, dy: 0))
		edge.press(forDuration: 0.1, thenDragTo: edge.withOffset(CGVector(dx: -160, dy: 0)))
		XCTAssertTrue(add.isHittable, "the plus button must remain visible in a narrow window")
		for tab in [third, second, first] {
			tab.hover()
			closeTab(tab.label, in: app).click()
			XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: tab))
			XCTAssertTrue(add.isHittable, "closing tabs must never hide the plus button")
		}
		add.click()
		XCTAssertTrue(waitUntilHittable(first), "plus must work again after the last tab closes")
	}

	func testTabReorderingAndEditorNavigation() throws {
		continueAfterFailure = false
		let app = try launchApp()
		let (sources, hostRow) = revealMacSource("Projection.swift", in: app)
		hostRow.click()
		let host = app.buttons.matching(NSPredicate(format: "label == %@", "Projection.swift")).firstMatch
		XCTAssertTrue(waitUntilHittable(host))
		app.staticTexts["EditorAreaView.swift"].click()
		let area = app.buttons.matching(NSPredicate(format: "label == %@", "EditorAreaView.swift")).firstMatch
		XCTAssertTrue(waitUntilHittable(area))
		sources.click()
		let packageRow = app.outlineRows.containing(NSPredicate(format: "value == %@", "Package.swift")).firstMatch
		XCTAssertTrue(waitUntilHittable(packageRow), "Package.swift must be visible before clicking")
		packageRow.click()
		let package = app.buttons.matching(NSPredicate(format: "label == %@", "Package.swift")).firstMatch
		XCTAssertTrue(waitUntilHittable(package))
		XCTAssertLessThan(host.frame.minX, area.frame.minX)
		XCTAssertLessThan(area.frame.minX, package.frame.minX)
		let originalY = host.frame.midY
		host.press(forDuration: 0.15, thenDragTo: area)
		XCTAssertTrue(wait(for: NSPredicate { _, _ in area.frame.minX < host.frame.minX && host.frame.minX < package.frame.minX }, on: host),
			"a tab must move exactly one position to the right")
		host.press(forDuration: 0.15, thenDragTo: package)
		XCTAssertTrue(wait(for: NSPredicate { _, _ in area.frame.minX < package.frame.minX && package.frame.minX < host.frame.minX }, on: host))
		XCTAssertEqual(host.frame.midY, originalY, accuracy: 1, "the dropped tab must snap back into the rail")
		host.click()
		let editor = app.textViews.firstMatch
		editor.click()
		app.typeKey(.leftArrow, modifierFlags: [.command, .option])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: package), "Previous Editor must follow the committed drop")
		XCTAssertTrue(waitForText(editor, containing: "// swift-tools-version", timeout: 3))
		app.typeKey(.leftArrow, modifierFlags: [.command, .option])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: area))
		app.typeKey(.rightArrow, modifierFlags: [.command, .option])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: package))
		app.typeKey(.rightArrow, modifierFlags: [.command, .option])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: host))
		XCTAssertTrue(waitForText(editor, containing: "import Foundation", timeout: 3))
		app.typeKey(.rightArrow, modifierFlags: [.command, .option])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: area), "Next Editor must wrap to the new first tab")
		host.press(forDuration: 0.15, thenDragTo: area)
		XCTAssertTrue(wait(for: NSPredicate { _, _ in host.frame.minX < area.frame.minX && area.frame.minX < package.frame.minX }, on: host))
		host.click(); editor.click()
		app.typeKey(.rightArrow, modifierFlags: [.command, .option])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: area), "a second drop must also reach the editor service")
		let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		screenshot.name = "Collection tab rail after reordering"; screenshot.lifetime = .keepAlways; add(screenshot)
		host.hover()
		closeTab("Projection.swift", in: app).click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: host), "closing a moved tab must retain its identity")
	}

	func testEditorAreaWorkflow() throws {
		continueAfterFailure = false
		let app = try launchApp()
		let (sourcesFolder, hostProcessRow) = revealMacSource("Projection.swift", in: app)
		hostProcessRow.click()
		let hostProcessTab = app.buttons.matching(
			NSPredicate(format: "label == %@", "Projection.swift")).firstMatch
		XCTAssertTrue(hostProcessTab.waitForExistence(timeout: 5), "single-click did not open a native tab")
		let editorText = app.textViews.firstMatch
		XCTAssertTrue(editorText.waitForExistence(timeout: 2), "WK editor contents were not painted")
		editorText.click()
		XCTAssertTrue(waitForText(editorText, containing: "import Foundation", timeout: 2),
			"WK editor did not contain the opened file text")

		let editorAreaFile = app.staticTexts["EditorAreaView.swift"]
		XCTAssertTrue(editorAreaFile.waitForExistence(timeout: 5), "second Explorer file was not visible")
		editorAreaFile.click()
		let editorAreaTab = app.buttons.matching(NSPredicate(format: "label == %@", "EditorAreaView.swift")).firstMatch
		XCTAssertTrue(editorAreaTab.waitForExistence(timeout: 5), "second projected tab did not appear")
		let currentEditor = app.textViews.firstMatch
		currentEditor.click()
		XCTAssertTrue(waitForText(currentEditor, containing: "import AppKit", timeout: 2),
			"second file contents were not painted")

		hostProcessTab.click()
		XCTAssertTrue(editorText.waitForExistence(timeout: 5), "tab selection did not restore its contents")
		hostProcessRow.click()
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Projection.swift")).count, 1,
			"opening the active file duplicated its tab")
		editorAreaTab.click()
		let closeEditorArea = closeTab("EditorAreaView.swift", in: app)
		XCTAssertTrue(closeEditorArea.waitForExistence(timeout: 5), "tab close action was missing")
		closeEditorArea.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: editorAreaTab),
			"tab close did not round-trip through the shared editor area")
		XCTAssertTrue(hostProcessTab.isSelected, "closing the active tab did not select its fallback")

		sourcesFolder.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: hostProcessRow, timeout: 2),
			"Sources folder did not collapse for the rapid-open check")
		let packageSwiftRow = app.outlineRows.containing(
			NSPredicate(format: "value == %@", "Package.swift")).firstMatch
		let launchRow = app.outlineRows.containing(NSPredicate(format: "value == %@", "launch.sh")).firstMatch
		XCTAssertTrue(packageSwiftRow.isHittable && launchRow.isHittable,
			"rapid-open files were not both visible before clicking")
		packageSwiftRow.click()
		launchRow.click()

		let packageSwiftTab = app.buttons.matching(
			NSPredicate(format: "label == %@", "Package.swift")).firstMatch
		let launchTab = app.buttons.matching(NSPredicate(format: "label == %@", "launch.sh")).firstMatch
		XCTAssertTrue(packageSwiftTab.waitForExistence(timeout: 2), "first rapid file did not open")
		XCTAssertTrue(launchTab.waitForExistence(timeout: 2), "second rapid file did not open")
		let closeLaunch = closeTab("launch.sh", in: app)
		XCTAssertTrue(closeLaunch.exists, "second rapid file had no close action")
		closeLaunch.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: launchTab, timeout: 2),
			"closing the latest rapid file was delayed")
		currentEditor.click()
		XCTAssertTrue(waitForText(currentEditor,
			containing: "// swift-tools-version", timeout: 2),
			"closing the latest file did not immediately restore the previous file")
	}

	func testNativeBreadcrumbFolderMenus() throws {
		let app = try launchWithPackageSwiftOpen()
		let breadcrumb = app.webViews.staticTexts.matching(NSPredicate(format: "value == %@", "mac")).firstMatch
		XCTAssertTrue(breadcrumb.waitForExistence(timeout: 5))
		breadcrumb.click()
		let sources = app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title == %@", "Sources")).firstMatch
		XCTAssertTrue(sources.waitForExistence(timeout: 5), "breadcrumb did not open a native folder menu")
		app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sources, timeout: 2))
		breadcrumb.click()
		XCTAssertTrue(sources.waitForExistence(timeout: 5))
		// UITests has multiple children, so single-child Explorer resolution cannot preload it.
		let testsFolder = app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title == %@", "UITests")).firstMatch
		testsFolder.hover()
		XCTAssertTrue(app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title == %@", "TucodeMacUITests.xcodeproj"))
			.firstMatch.waitForExistence(timeout: 5), "uncached folder replies stalled while the menu was open")
		sources.hover()
		let module = app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title == %@", "TucodeMac")).firstMatch
		XCTAssertTrue(module.waitForExistence(timeout: 5), "folder submenu did not load Explorer children")
		module.hover()
		let file = app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title == %@ AND identifier == %@", "Projection.swift", "select:")).firstMatch
		XCTAssertTrue(file.waitForExistence(timeout: 5), "nested submenu did not load on demand")
		let appearance = XCTAttachment(screenshot: app.screenshot())
		appearance.name = "Native breadcrumb folder submenus"
		appearance.lifetime = .keepAlways
		add(appearance)
		file.click()
		XCTAssertTrue(waitForText(app.textViews["Projection.swift"], containing: "struct QuickInputRow", timeout: 5),
			"native selection did not open the file through VS Code")
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testExplorerContextMenuRepeatedClicksAndNormalMouseActions() throws {
		continueAfterFailure = false
		let (app, _) = try launchQuickInputFixture()
		let outline = app.outlines["tucode.navigator.outline"]
		let package = outline.staticTexts["Package.swift"]
		XCTAssertTrue(waitUntilHittable(package))
		let copyPath = app.menuItems.matching(NSPredicate(format: "title == %@", "Copy Path")).firstMatch
		for _ in 0..<2 {
			package.rightClick()
			XCTAssertTrue(copyPath.waitForExistence(timeout: 3), "the full Explorer menu must open on the right click alone")
			XCTAssertTrue(app.menuItems.matching(NSPredicate(format: "title == %@", "Copy Relative Path")).firstMatch.exists)
			app.typeKey(.escape, modifierFlags: [])
			XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: copyPath, timeout: 3))
		}
		let packagePoint = package.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
		packagePoint.rightClick()
		XCTAssertTrue(copyPath.waitForExistence(timeout: 3))
		packagePoint.rightClick()
		app.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: copyPath, timeout: 3))
		package.rightClick()
		XCTAssertTrue(copyPath.waitForExistence(timeout: 3), "repeated right clicks must not leave menu tracking stuck")
		copyPath.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: copyPath, timeout: 3))
		package.click()
		XCTAssertTrue(waitUntilHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Package.swift")).firstMatch),
			"left-click file opening must still work after context menus")
		let sources = outline.staticTexts.matching(NSPredicate(format: "value == %@ OR value == %@", "Sources", "Sources/TucodeMac")).firstMatch
		XCTAssertTrue(waitUntilHittable(sources))
		sources.click()
		let host = outline.staticTexts["Projection.swift"]
		XCTAssertTrue(host.waitForExistence(timeout: 3), "left-click folder expansion must still work")
		sources.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: host, timeout: 3), "left-click folder collapse must still work")
		sources.rightClick()
		XCTAssertTrue(copyPath.waitForExistence(timeout: 3), "folder menus must contain the existing path actions")
		app.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: copyPath, timeout: 3))
		sources.click()
		XCTAssertTrue(host.waitForExistence(timeout: 3))
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testTabContextMenuRepeatedClicksAndClose() throws {
		continueAfterFailure = false
		let (app, _) = try launchQuickInputFixture()
		let file = app.outlines["tucode.navigator.outline"].staticTexts["Package.swift"]
		XCTAssertTrue(waitUntilHittable(file)); file.click()
		let tab = app.buttons.matching(NSPredicate(format: "label == %@", "Package.swift")).firstMatch
		XCTAssertTrue(waitUntilHittable(tab))
		let close = app.menuItems.matching(NSPredicate(format: "title == %@", "Close")).firstMatch
		for _ in 0..<2 {
			tab.rightClick()
			XCTAssertTrue(close.waitForExistence(timeout: 3), "right-clicking the tab button must open the VS Code menu")
			app.typeKey(.escape, modifierFlags: [])
			XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: close, timeout: 3))
			tab.click()
		}
		tab.rightClick()
		XCTAssertTrue(close.waitForExistence(timeout: 3)); close.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: tab, timeout: 3), "the existing Close action must close the clicked tab")
		file.click()
		XCTAssertTrue(waitUntilHittable(tab), "file opening must still work after a tab context-menu action")
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testNativeEditorContextMenu() throws {
		let app = try launchWithPackageSwiftOpen()
		let editor = app.textViews.firstMatch
		XCTAssertTrue(editor.waitForExistence(timeout: 5))
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version", timeout: 5))
		let breadcrumb = app.webViews.staticTexts.matching(NSPredicate(format: "value == %@", "mac")).firstMatch
		XCTAssertTrue(breadcrumb.waitForExistence(timeout: 3), "current defaults did not show the upstream breadcrumbs")
		let appearance = XCTAttachment(screenshot: app.screenshot())
		appearance.name = "Editor breadcrumbs and upstream fonts"
		appearance.lifetime = .keepAlways
		add(appearance)
		enterInsertMode(in: app, editor: editor)
		editor.rightClick()
		let copy = app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title BEGINSWITH %@", "Copy")).firstMatch
		XCTAssertTrue(copy.waitForExistence(timeout: 3), "VS Code right-click did not open an AppKit menu")
		app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: copy, timeout: 2))
		let marker = "TUCODE_NATIVE_MENU_PROBE"
		app.typeText(marker)
		XCTAssertTrue(waitForText(editor, containing: marker, timeout: 2), "Escape did not preserve editor focus")
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: marker, timeout: 2))
		app.typeKey("a", modifierFlags: .command)
		editor.rightClick()
		XCTAssertTrue(copy.waitForExistence(timeout: 3))
		copy.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: copy, timeout: 2))
		XCTAssertTrue(wait(for: NSPredicate { _, _ in
			NSPasteboard.general.string(forType: .string)?.contains("swift-tools-version") == true
		}, on: app, timeout: 2), "Copy did not populate the system clipboard")
		// Replace the selection, then prove the original Copy/Paste actions restore its contents.
		app.typeText(marker)
		XCTAssertTrue(waitForTextToDisappear(editor, text: "swift-tools-version", timeout: 2))
		app.typeKey("a", modifierFlags: .command)
		editor.rightClick()
		let paste = app.windows.firstMatch.menuItems.matching(NSPredicate(format: "title BEGINSWITH %@", "Paste")).firstMatch
		XCTAssertTrue(paste.waitForExistence(timeout: 3))
		paste.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: paste, timeout: 2))
		// VS Code exposes the text around the caret to accessibility; paste leaves it at EOF.
		app.typeKey(.upArrow, modifierFlags: .command)
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version", timeout: 2), editor.debugDescription)
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testUnhandledShortcutsLeaveEditorResponsive() throws {
		let app = try launchWithPackageSwiftOpen()
		let editor = app.textViews.firstMatch
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version"))
		editor.click()
		for _ in 0..<3 {
			app.typeKey("=", modifierFlags: .command)
			app.typeKey("=", modifierFlags: [.command, .shift])
			app.typeKey("-", modifierFlags: .command)
			app.typeKey("j", modifierFlags: [.command, .control, .option, .shift])
		}
		XCTAssertEqual(app.state, .runningForeground)
		enterInsertMode(in: app, editor: editor)
		editor.typeText("TUCODE_SHORTCUT_SURVIVED")
		XCTAssertTrue(waitForText(editor, containing: "TUCODE_SHORTCUT_SURVIVED"))
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: "TUCODE_SHORTCUT_SURVIVED"))
		app.typeKey("p", modifierFlags: .command)
		XCTAssertTrue(waitForQuickInput(app))
		let field = app.searchFields["tucode.quickInput.field"]
		field.typeKey("=", modifierFlags: [.command, .shift])
		field.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(waitForQuickInput(app, open: false))
		let folder = app.outlines["tucode.navigator.outline"].staticTexts["mac"]
		folder.click()
		app.typeKey("=", modifierFlags: [.command, .shift])
		app.typeKey("p", modifierFlags: .command)
		XCTAssertTrue(waitForQuickInput(app))
		field.typeKey(.escape, modifierFlags: [])
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testNativeFileOpenAndSaveWorkflow() throws {
		continueAfterFailure = false
		let fixture = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let app = try launchApp(repository: URL(fileURLWithPath: fixture).appendingPathComponent("mac"))
		XCTAssertTrue(waitUntilHittable(app.staticTexts["Package.swift"]))
		let pickerFolder = "\(fixture)/native-picker"
		let sheet = app.sheets.firstMatch
		let editor = app.textViews.firstMatch

		func goTo(_ path: String) {
			navigateFilePanel(in: app, to: path)
		}
		func open(_ path: String) {
			app.typeKey("o", modifierFlags: .command)
			XCTAssertTrue(sheet.waitForExistence(timeout: 5), app.debugDescription)
			goTo(path)
			sheet.buttons["Open"].click()
			XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		}

		// Cancel resolves without opening an editor, including when invoked through the palette.
		app.typeKey("p", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForQuickInput(app))
		let field = app.searchFields["tucode.quickInput.field"]
		field.typeText("File: Open File")
		field.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		sheet.buttons["Cancel"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))

		open("\(pickerFolder)/open source.swift")
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version"))
		editor.click()
		app.typeKey("s", modifierFlags: [.command, .shift])
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		sheet.buttons["Cancel"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == %@", "open source.swift")).firstMatch.exists)

		// Save As to a new path, then close and reopen to prove persisted contents.
		app.menuBars.menuBarItems["File"].click()
		app.menuItems["Save As..."].click()
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		goTo("\(pickerFolder)/saved copy.swift")
		sheet.buttons["Save"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		let savedTab = app.buttons.matching(NSPredicate(format: "label == %@", "saved copy.swift")).firstMatch
		XCTAssertTrue(savedTab.waitForExistence(timeout: 5), app.debugDescription)
		closeTab("saved copy.swift", in: app).click()
		open("\(pickerFolder)/saved copy.swift")
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version"))

		// Untitled Save uses the same native panel and the upstream working-copy service.
		app.typeKey("n", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: "swift-tools-version"))
		editor.click()
		enterInsertMode(in: app, editor: editor)
		editor.typeText("TUCODE_NATIVE_SAVE")
		app.typeKey("s", modifierFlags: .command)
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		goTo("\(pickerFolder)/new document.txt")
		sheet.buttons["Save"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == %@", "new document.txt")).firstMatch.waitForExistence(timeout: 5))
		closeTab("new document.txt", in: app).click()
		open("\(pickerFolder)/new document.txt")
		XCTAssertTrue(waitForText(editor, containing: "TUCODE_NATIVE_SAVE"))

		// AppKit must confirm replacement before VS Code writes an existing destination.
		app.typeKey("s", modifierFlags: [.command, .shift])
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		goTo("\(pickerFolder)/replace me.txt")
		sheet.buttons["Save"].click()
		let replace = app.sheets.buttons["Replace"].firstMatch
		XCTAssertTrue(replace.waitForExistence(timeout: 5), app.debugDescription)
		replace.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == %@", "replace me.txt")).firstMatch.waitForExistence(timeout: 5))
		closeTab("replace me.txt", in: app).click()
		open("\(pickerFolder)/replace me.txt")
		XCTAssertTrue(waitForText(editor, containing: "TUCODE_NATIVE_SAVE"))
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testCommandOOpensFilesAndFoldersInNativeWindowTabs() throws {
		continueAfterFailure = false
		let fixture = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let app = try launchApp(repository: URL(fileURLWithPath: fixture).appendingPathComponent("mac"),
			userDataDirectory: "\(fixture)/native-tabs-user-data")
		XCTAssertTrue(waitUntilHittable(app.staticTexts["Package.swift"]))
		app.menuBars.menuBarItems["File"].click()
		XCTAssertTrue(app.menuItems["Open..."].exists, app.debugDescription)
		XCTAssertFalse(app.menuItems["Open File..."].exists)
		app.typeKey(.escape, modifierFlags: [])
		let sheet = app.sheets.firstMatch

		// The upstream Mac Command-O action accepts files as well as folders.
		app.typeKey("o", modifierFlags: .command)
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		navigateFilePanel(in: app, to: "\(fixture)/mac/Package.swift")
		sheet.buttons["Open"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		let editor = app.textViews.firstMatch
		XCTAssertTrue(editor.waitForExistence(timeout: 5))
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version"))

		app.typeKey("o", modifierFlags: .command)
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		navigateFilePanel(in: app, to: "\(fixture)/native-picker")
		sheet.buttons["Open"].click()
		let folderRow = app.outlines["tucode.navigator.outline"].staticTexts["open source.swift"].firstMatch
		XCTAssertTrue(waitUntilHittable(folderRow), app.debugDescription)
		let originalTab = app.tabs["mac"].firstMatch
		let folderTab = app.tabs["native-picker"].firstMatch
		XCTAssertTrue(originalTab.waitForExistence(timeout: 5), app.debugDescription)
		XCTAssertTrue(folderTab.exists, app.debugDescription)
		folderRow.click()
		let folderEditor = app.textViews.matching(NSPredicate(format: "label == %@", "open source.swift")).firstMatch
		XCTAssertTrue(folderEditor.waitForExistence(timeout: 5))
		folderEditor.click()
		XCTAssertTrue(waitForText(folderEditor, containing: "swift-tools-version"))
		// The fixture's user keybindings must reach AppKit through the VS Code command IDs.
		app.typeKey("[", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: originalTab), app.debugDescription)
		let originalEditor = app.textViews.matching(NSPredicate(format: "label == %@", "Package.swift")).firstMatch
		XCTAssertTrue(originalEditor.waitForExistence(timeout: 5))
		originalEditor.click()
		XCTAssertTrue(waitForText(originalEditor, containing: "swift-tools-version"))
		app.typeKey("]", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: folderTab), app.debugDescription)
		XCTAssertTrue(waitUntilHittable(folderRow))
		// Both directions wrap within the native tab group.
		app.typeKey("]", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: originalTab), app.debugDescription)
		app.typeKey("[", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: folderTab), app.debugDescription)

		// Opening from the second window must inherit the same application settings.
		folderEditor.click()
		app.typeKey("o", modifierFlags: .command)
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		navigateFilePanel(in: app, to: "\(fixture)/third-folder")
		sheet.buttons["Open"].click()
		let thirdRow = app.outlines["tucode.navigator.outline"].staticTexts["third.swift"].firstMatch
		XCTAssertTrue(waitUntilHittable(thirdRow), app.debugDescription)
		let thirdTab = app.tabs["third-folder"].firstMatch
		XCTAssertTrue(thirdTab.exists, app.debugDescription)
		XCTAssertTrue(originalTab.exists && folderTab.exists, app.debugDescription)
		thirdRow.click()
		let thirdEditor = app.textViews.matching(NSPredicate(format: "label == %@", "third.swift")).firstMatch
		XCTAssertTrue(thirdEditor.waitForExistence(timeout: 5))
		thirdEditor.click()
		app.typeKey("[", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: folderTab), app.debugDescription)
		folderEditor.click()
		app.typeKey("[", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: originalTab), app.debugDescription)
		originalEditor.click()
		app.typeKey("[", modifierFlags: [.command, .shift])
		XCTAssertTrue(wait(for: NSPredicate(format: "value == 1"), on: thirdTab), app.debugDescription)

		// Close an entire connection, then read and save through a surviving one.
		thirdTab.buttons["_closeButton"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: thirdTab))
		folderTab.click()
		folderEditor.click()
		enterInsertMode(in: app, editor: folderEditor)
		folderEditor.typeText("SURVIVING_WINDOW")
		app.typeKey("s", modifierFlags: .command)
		XCTAssertTrue(waitForText(folderEditor, containing: "SURVIVING_WINDOW"))
		closeTab("open source.swift", in: app).click()
		folderRow.click()
		XCTAssertTrue(waitForText(folderEditor, containing: "SURVIVING_WINDOW"))
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testWindowConnectionSurvivesClosingAnotherWindow() throws {
		continueAfterFailure = false
		let fixture = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let app = try launchApp(repository: URL(fileURLWithPath: fixture).appendingPathComponent("mac"))
		let original = app.windows["mac — tucode"]
		let package = original.outlines["tucode.navigator.outline"].staticTexts["Package.swift"]
		XCTAssertTrue(waitUntilHittable(package))
		app.menuBars.menuBarItems["File"].click()
		app.menuItems["Open Folder..."].click()
		let sheet = app.sheets.firstMatch
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		navigateFilePanel(in: app, to: "\(fixture)/third-folder")
		sheet.buttons["Open"].click()
		let second = app.windows["third-folder — tucode"]
		XCTAssertTrue(second.waitForExistence(timeout: 10))
		let file = second.outlines["tucode.navigator.outline"].staticTexts["third.swift"]
		XCTAssertTrue(waitUntilHittable(file))
		file.click()
		XCTAssertTrue(waitUntilHittable(second.textViews.firstMatch))
		second.textViews.firstMatch.click()
		XCTAssertTrue(waitForText(second.textViews.firstMatch, containing: "swift-tools-version"))
		XCTAssertEqual(app.windows.count, 2)
		second.buttons[XCUIIdentifierCloseWindow].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: second))
		package.click()
		original.textViews.firstMatch.click()
		XCTAssertTrue(waitForText(original.textViews.firstMatch, containing: "swift-tools-version"))
		app.typeKey("p", modifierFlags: .command)
		XCTAssertTrue(waitForQuickInput(app))
		original.searchFields["tucode.quickInput.field"].typeText("Projection.swift")
		XCTAssertTrue(waitUntilHittable(app.tables["tucode.quickInput.results"].staticTexts["Projection.swift"]))
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testOpenFolderKeepsIndependentWorkspaceWindows() throws {
		continueAfterFailure = false
		let fixture = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let app = try launchApp(repository: URL(fileURLWithPath: fixture).appendingPathComponent("mac"))
		let original = app.windows["mac — tucode"]
		let package = original.outlines["tucode.navigator.outline"].staticTexts["Package.swift"]
		XCTAssertTrue(waitUntilHittable(package))
		package.click()
		let firstEditor = original.textViews.firstMatch
		XCTAssertTrue(firstEditor.waitForExistence(timeout: 5))
		firstEditor.click()
		XCTAssertTrue(waitForText(firstEditor, containing: "swift-tools-version"), app.debugDescription)
		enterInsertMode(in: app, editor: firstEditor)
		firstEditor.typeText("FIRST_WINDOW_EDIT")
		XCTAssertTrue(waitForText(firstEditor, containing: "FIRST_WINDOW_EDIT"))

		app.menuBars.menuBarItems["File"].click()
		app.menuItems["Open Folder..."].click()
		let sheet = app.sheets.firstMatch
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		sheet.buttons["Cancel"].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: sheet))
		XCTAssertEqual(app.windows.count, 1)
		XCTAssertTrue(waitForText(firstEditor, containing: "FIRST_WINDOW_EDIT"))

		// The palette uses the same upstream Open Folder action as the native menu.
		app.typeKey("p", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForQuickInput(app))
		let field = original.searchFields["tucode.quickInput.field"]
		field.typeText("File: Open Folder")
		field.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(sheet.waitForExistence(timeout: 5))
		navigateFilePanel(in: app, to: "\(fixture)/native-picker")
		sheet.buttons["Open"].click()
		let second = app.windows["native-picker — tucode"]
		XCTAssertTrue(second.waitForExistence(timeout: 10), app.debugDescription)
		let source = second.outlines["tucode.navigator.outline"].staticTexts["open source.swift"]
		XCTAssertTrue(waitUntilHittable(source))
		XCTAssertEqual(app.windows.count, 2)
		XCTAssertTrue(original.exists)
		XCTAssertFalse(second.outlines["tucode.navigator.outline"].staticTexts["Package.swift"].exists)
		source.click()
		let secondEditor = second.textViews.firstMatch
		XCTAssertTrue(secondEditor.waitForExistence(timeout: 5))
		secondEditor.click()
		XCTAssertTrue(waitForText(secondEditor, containing: "swift-tools-version"), app.debugDescription)
		enterInsertMode(in: app, editor: secondEditor)
		secondEditor.typeText("SECOND_WINDOW_EDIT")
		XCTAssertTrue(waitForText(secondEditor, containing: "SECOND_WINDOW_EDIT"))
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(secondEditor, text: "SECOND_WINDOW_EDIT"))

		// Bring the first window forward by its uncovered title bar; menus must change owners.
		original.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01)).click()
		firstEditor.click()
		XCTAssertTrue(waitForText(firstEditor, containing: "FIRST_WINDOW_EDIT"))
		app.menuBars.menuBarItems["Edit"].click()
		app.menuItems["Undo"].click()
		firstEditor.click()
		XCTAssertTrue(waitForText(firstEditor, containing: "swift-tools-version"))
		XCTAssertTrue(waitForTextToDisappear(firstEditor, text: "FIRST_WINDOW_EDIT"))

		// Closing one clean workspace must leave the other workspace running and editable.
		second.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)).click()
		second.buttons[XCUIIdentifierCloseWindow].click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: second))
		XCTAssertEqual(app.state, .runningForeground)
		XCTAssertTrue(original.exists)
		firstEditor.click()
		enterInsertMode(in: app, editor: firstEditor)
		firstEditor.typeText("AFTER_SECOND_WINDOW_CLOSE")
		XCTAssertTrue(waitForText(firstEditor, containing: "AFTER_SECOND_WINDOW_CLOSE"))
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(firstEditor, text: "AFTER_SECOND_WINDOW_CLOSE"))
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
	}

	func testVimViewerAndBrowserStatusbar() throws {
		continueAfterFailure = false
		let (app, _) = try launchQuickInputFixture()
		XCTAssertTrue(waitUntilHittable(app.staticTexts["Package.swift"]))
		app.staticTexts["Package.swift"].click()
		let editor = app.textViews.firstMatch
		XCTAssertTrue(editor.waitForExistence(timeout: 3))
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version", timeout: 3), app.debugDescription)
		let status = app.buttons["-- VIEWER --"]
		XCTAssertTrue(status.waitForExistence(timeout: 3), app.debugDescription)
		XCTAssertGreaterThanOrEqual(status.frame.minY, editor.frame.maxY - 1)
		editor.typeText("READONLY_PROBE")
		app.typeKey(.rightArrow, modifierFlags: [])
		XCTAssertTrue(waitForTextToDisappear(editor, text: "READONLY_PROBE", timeout: 2), app.debugDescription)
		app.typeKey("v", modifierFlags: [])
		XCTAssertTrue(app.buttons["-- NORMAL --"].waitForExistence(timeout: 3))
		app.typeKey("i", modifierFlags: [])
		XCTAssertTrue(app.buttons["-- INSERT --"].waitForExistence(timeout: 3))
		editor.typeText("VIM_PROBE")
		XCTAssertTrue(waitForText(editor, containing: "VIM_PROBE", timeout: 2))
		app.typeKey(.escape, modifierFlags: [])
		XCTAssertTrue(app.buttons["-- NORMAL --"].waitForExistence(timeout: 3))
		app.typeKey("u", modifierFlags: [])
		XCTAssertTrue(waitForTextToDisappear(editor, text: "VIM_PROBE", timeout: 2))
		editor.typeText("/Package")
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "/", "Package")).firstMatch.waitForExistence(timeout: 3), app.debugDescription)
		app.typeKey(.escape, modifierFlags: [])
		editor.typeText(":q")
		app.typeKey(.return, modifierFlags: [])
		XCTAssertTrue(status.waitForExistence(timeout: 3))
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists)
		let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
		screenshot.name = "Browser Vim status bar"; screenshot.lifetime = .keepAlways; add(screenshot)
	}

	func testEditorUndoRedoUsesVSCodeKeybindings() throws {
		continueAfterFailure = false
		let app = try launchApp()
		let macFolder = app.staticTexts["mac"]
		XCTAssertTrue(waitUntilHittable(macFolder), "Explorer rows were not painted")
		let packageRow = app.outlineRows.containing(
			NSPredicate(format: "value == %@", "Package.swift")).firstMatch
		XCTAssertTrue(expand(macFolder, revealing: packageRow), "Package.swift was not visible")
		let macRow = app.outlineRows.containing(NSPredicate(format: "value == %@", "mac")).firstMatch
		app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == false"), on: macRow, timeout: 2),
			"Down Arrow did not round-trip through the shared Explorer projection")
		app.typeKey(XCUIKeyboardKey.upArrow.rawValue, modifierFlags: [])
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: macRow, timeout: 2),
			"Up Arrow did not round-trip through the shared Explorer projection")
		for _ in 0..<12 { app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: []) }
		let selectedRow = app.outlineRows.matching(NSPredicate(format: "selected == true")).firstMatch
		XCTAssertTrue(waitUntilHittable(selectedRow),
			"Explorer focus moved outside the visible AppKit rows during repeated navigation")
		for _ in 0..<12 { app.typeKey(XCUIKeyboardKey.upArrow.rawValue, modifierFlags: []) }
		XCTAssertTrue(wait(for: NSPredicate(format: "selected == true"), on: macRow, timeout: 2),
			"repeated navigation did not return to the model-focused Explorer row")
		packageRow.click()

		let editor = app.textViews.firstMatch
		XCTAssertTrue(editor.waitForExistence(timeout: 5), "WK editor contents were not painted")
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "swift-tools-version", timeout: 5),
			"Package.swift contents did not resolve")
		let marker = "TUCODE_UNDO_PROBE"
		app.typeKey("v", modifierFlags: [])
		app.typeKey("i", modifierFlags: [])
		editor.typeText(marker)
		XCTAssertTrue(waitForText(editor, containing: marker, timeout: 2),
			"typing did not reach the VS Code editor")

		app.typeKey("z", modifierFlags: .command)
		let runtimeError = app.staticTexts["tucode.bootstrap.error"]
		if runtimeError.waitForExistence(timeout: 1) {
			XCTFail("Command-Z surfaced an editor error: \(runtimeError.label)")
		}
		XCTAssertTrue(waitForTextToDisappear(editor, text: marker, timeout: 2),
			"Command-Z did not run VS Code Undo")
		app.typeKey("z", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForText(editor, containing: marker, timeout: 2),
			"Command-Shift-Z did not run VS Code Redo")
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: marker, timeout: 2),
			"final Undo did not restore the clean model")
		XCTAssertFalse(app.staticTexts["tucode.bootstrap.error"].exists,
			"an editor command surfaced a bootstrap error")
	}

	func testTenFileOpenCloseWorkflow() throws {
		continueAfterFailure = false
		let app = try launchApp()
		let sourceFiles = ["EditorAreaView.swift", "EditorProtocol.swift", "Projection.swift", "main.swift"]
		let (sourcesFolder, firstSourceRow) = revealMacSource(sourceFiles[0], in: app)
		for name in sourceFiles {
			let row = app.outlineRows.containing(NSPredicate(format: "value == %@", name)).firstMatch
			XCTAssertTrue(row.isHittable, "\(name) was not visible before the open burst")
			row.click()
		}
		let lastSourceTab = app.buttons.matching(
			NSPredicate(format: "label == %@", sourceFiles.last!)).firstMatch
		XCTAssertTrue(lastSourceTab.waitForExistence(timeout: 2), "the first open burst did not complete")

		sourcesFolder.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: firstSourceRow, timeout: 2),
			"Sources folder did not collapse")

		let macFiles = [
			"Package.swift", "README.md", "capture-visual-comparison.sh", "launch.sh", "package.sh", "test-foreground.sh"
		]
		for name in macFiles.prefix(2) {
			let row = app.outlineRows.containing(NSPredicate(format: "value == %@", name)).firstMatch
			XCTAssertTrue(row.isHittable, "\(name) was not visible before the open burst")
			row.click()
		}
		// AppKit's outline/scroll containers are not themselves AX hit targets. Deliver the
		// wheel over a visible row, exactly where a user scrolls the Explorer.
		let scrollTarget = app.outlineRows.containing(NSPredicate(format: "value == %@", "README.md")).firstMatch
		XCTAssertTrue(scrollTarget.isHittable, "Explorer row was unavailable for scrolling")
		scrollTarget.scroll(byDeltaX: 0, deltaY: 220)
		for name in macFiles.dropFirst(2) {
			let row = app.outlineRows.containing(NSPredicate(format: "value == %@", name)).firstMatch
			XCTAssertTrue(row.isHittable, "\(name) was not visible after scrolling")
			row.click()
		}

		let lastTab = app.buttons.matching(
			NSPredicate(format: "label == %@", macFiles.last!)).firstMatch
		XCTAssertTrue(lastTab.waitForExistence(timeout: 2), "the ten-file open burst did not complete")
		let tabs = app.buttons.matching(
			NSPredicate(format: "identifier BEGINSWITH %@ AND NOT identifier BEGINSWITH %@", "tucode.editor.tab.", "tucode.editor.tab.close."))
		XCTAssertEqual(tabs.count, 10, "ten opens did not produce exactly ten tabs")

		for name in (sourceFiles + macFiles).reversed() {
			let close = closeTab(name, in: app)
			XCTAssertTrue(close.waitForExistence(timeout: 2), "close action for \(name) did not appear")
			close.click()
		}

		XCTAssertTrue(app.descendants(matching: .any).matching(
			identifier: "tucode.editor.contents").firstMatch.waitForExistence(timeout: 2),
			"closing all ten files removed the empty WK editor surface")
		XCTAssertEqual(tabs.count, 0, "closing all ten files left tabs behind")
	}

	func testTabStripScrollsHorizontallyOnly() throws {
		continueAfterFailure = false
		let app = try launchApp(arguments: ["--visual-compare-tabs", "overflow"])
		let lastTab = app.buttons.matching(
			NSPredicate(format: "label == %@", "test-foreground.sh")).firstMatch
		XCTAssertTrue(lastTab.waitForExistence(timeout: 10), "overflow fixture did not finish opening ten upstream file panes")
		let tabs = app.buttons.matching(
			NSPredicate(format: "identifier BEGINSWITH %@ AND NOT identifier BEGINSWITH %@", "tucode.editor.tab.", "tucode.editor.tab.close."))
		XCTAssertEqual(tabs.count, 10, "overflow fixture did not produce ten tabs")

		let tabStrip = app.scrollViews["tucode.editor.tabs"]
		XCTAssertTrue(tabStrip.waitForExistence(timeout: 2), "overflowing tab strip was not scrollable")
		let add = app.buttons["tucode.editor.newFile"]
		XCTAssertTrue(add.isHittable, "overflow must not hide the plus button")
		let addFrame = add.frame
		let origin = lastTab.frame
		tabStrip.scroll(byDeltaX: 0, deltaY: 180)
		XCTAssertEqual(lastTab.frame.minY, origin.minY, accuracy: 0.5,
			"positive vertical scrolling moved the horizontal tab row")
		tabStrip.scroll(byDeltaX: 0, deltaY: -180)
		XCTAssertEqual(lastTab.frame.minY, origin.minY, accuracy: 0.5,
			"negative vertical scrolling moved the horizontal tab row")

		tabStrip.scroll(byDeltaX: 220, deltaY: 0)
		let movedHorizontally = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
			guard let element = object as? XCUIElement else { return false }
			return abs(element.frame.minX - origin.minX) > 1
		}, object: lastTab)
		XCTAssertEqual(XCTWaiter.wait(for: [movedHorizontally], timeout: 2), .completed,
			"overflowing tabs did not scroll horizontally")
		XCTAssertEqual(lastTab.frame.minY, origin.minY, accuracy: 0.5,
			"horizontal scrolling changed the tab row's vertical position")
		XCTAssertTrue(add.isHittable)
		XCTAssertEqual(add.frame, addFrame, "the plus button must stay outside scrolling content")
	}

	func testUpstreamEditorLifecycleWithoutNavigator() throws {
		continueAfterFailure = false
		let app = try launchApp(arguments: ["--visual-compare-tabs", "overflow"])
		let lastTab = app.buttons.matching(NSPredicate(format: "label == %@", "test-foreground.sh")).firstMatch
		XCTAssertTrue(lastTab.waitForExistence(timeout: 10), "upstream EditorService did not open the fixture")
		let editor = app.textViews.firstMatch
		XCTAssertTrue(editor.waitForExistence(timeout: 5))
		editor.click()
		XCTAssertTrue(waitForText(editor, containing: "#!/bin/sh", timeout: 5), "browser pane did not attach the resolved FileEditorInput model")
		let marker = "TUCODE_UPSTREAM_INPUT_PROBE"
		enterInsertMode(in: app, editor: editor)
		editor.typeText(marker)
		XCTAssertTrue(waitForText(editor, containing: marker, timeout: 2))
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: marker, timeout: 2), "Undo did not use browser editor keybindings")
		app.typeKey("z", modifierFlags: [.command, .shift])
		XCTAssertTrue(waitForText(editor, containing: marker, timeout: 2))
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: marker, timeout: 2))
		let close = closeTab("test-foreground.sh", in: app)
		lastTab.hover()
		close.click()
		XCTAssertTrue(wait(for: NSPredicate(format: "exists == false"), on: lastTab), "native close did not reach upstream group lifecycle")
	}

	func testTabRevealUsesUpstreamRequests() throws {
		continueAfterFailure = false
		let fixture = URL(fileURLWithPath: try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"]))
		let app = try launchApp(arguments: ["--visual-compare-tabs", "overflow-dirty"], repository: fixture)
		let last = app.buttons.matching(NSPredicate(format: "label == %@", "test-foreground.sh")).firstMatch
		XCTAssertTrue(last.waitForExistence(timeout: 10))
		XCTAssertTrue(waitUntilHittable(last), "opening the last tab must honor upstream reveal")
		let restoredPaint = XCTAttachment(screenshot: app.screenshot())
		restoredPaint.name = "Restored committed native tab paint"
		restoredPaint.lifetime = .keepAlways
		add(restoredPaint)
		let window = app.windows.firstMatch
		let width = window.frame.width
		let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -2, dy: 0))
		edge.press(forDuration: 0.1, thenDragTo: edge.withOffset(CGVector(dx: -160, dy: 0)))
		XCTAssertLessThan(window.frame.width, width - 100, "native test did not narrow the viewport")
		XCTAssertTrue(waitUntilHittable(last), "narrowing the native viewport must honor upstream reveal")
		let strip = app.scrollViews["tucode.editor.tabs"]
		let before = last.frame.minX
		strip.scroll(byDeltaX: 60, deltaY: 0)
		XCTAssertTrue(wait(for: NSPredicate { _, _ in abs(last.frame.minX - before) > 1 }, on: app))
		let manuallyScrolled = last.frame.minX
		let editor = app.textViews.firstMatch
		editor.click()
		enterInsertMode(in: app, editor: editor)
		editor.typeText("TUCODE_NATIVE_DIRTY_PROBE")
		XCTAssertTrue(waitForText(editor, containing: "TUCODE_NATIVE_DIRTY_PROBE"))
		XCTAssertEqual(last.frame.minX, manuallyScrolled, accuracy: 1, "unrelated dirty paint must not snap native tabs back")
		app.typeKey("z", modifierFlags: .command)
		XCTAssertTrue(waitForTextToDisappear(editor, text: "TUCODE_NATIVE_DIRTY_PROBE"))
	}

	func testRealUpstreamFileAndNativeTabFrontend() throws {
		continueAfterFailure = false
		let app = try launchApp(arguments: ["--visual-compare-tabs", "frontend-probe"])
		let passed = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "MAC_FRONTEND_PROBE_PASSED")).firstMatch
		let error = app.staticTexts["tucode.bootstrap.error"]
		let settled = NSPredicate { _, _ in passed.exists || error.exists }
		XCTAssertTrue(wait(for: settled, on: app, timeout: 30))
		XCTAssertTrue(passed.exists, "actual WK frontend behavior probe: \(error.value ?? error.label)")
	}


	private func enterInsertMode(in app: XCUIApplication, editor: XCUIElement,
		file: StaticString = #filePath, line: UInt = #line) {
		editor.click()
		let window = app.windows.containing(.textView, identifier: editor.identifier).firstMatch
		// Scope mode queries to the focused editor's window: other windows keep their own mode.
		let buttons = window.exists ? window.buttons : app.buttons
		XCTAssertTrue(wait(for: NSPredicate { _, _ in
			buttons["-- VIEWER --"].exists || buttons["-- NORMAL --"].exists || buttons["-- INSERT --"].exists
		}, on: editor, timeout: 3), "editor mode did not appear", file: file, line: line)
		if buttons["-- VIEWER --"].exists {
			app.typeKey("v", modifierFlags: [])
			XCTAssertTrue(buttons["-- NORMAL --"].waitForExistence(timeout: 3), file: file, line: line)
		}
		if buttons["-- NORMAL --"].exists { app.typeKey("i", modifierFlags: []) }
		XCTAssertTrue(buttons["-- INSERT --"].waitForExistence(timeout: 3), file: file, line: line)
	}

	private func navigateFilePanel(in app: XCUIApplication, to path: String) {
		app.typeKey("g", modifierFlags: [.command, .shift])
		let pathField = app.textFields["PathTextField"]
		XCTAssertTrue(pathField.waitForExistence(timeout: 3), app.debugDescription)
		pathField.typeKey("a", modifierFlags: .command)
		pathField.typeText(path)
		pathField.typeKey(.return, modifierFlags: [])
	}

	private func launchQuickInputFixture() throws -> (XCUIApplication, XCUIElement) {
		let workspace = try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"])
		let app = try launchApp(repository: URL(fileURLWithPath: workspace).appendingPathComponent("mac"))
		return (app, app.searchFields["tucode.quickInput.field"])
	}

	private func launchWithPackageSwiftOpen() throws -> XCUIApplication {
		continueAfterFailure = false
		let app = try launchApp()
		let packageRow = app.outlineRows.containing(NSPredicate(format: "value == %@", "Package.swift")).firstMatch
		XCTAssertTrue(expand(app.staticTexts["mac"], revealing: packageRow))
		packageRow.click()
		return app
	}

	private func closeTab(_ name: String, in app: XCUIApplication) -> XCUIElement {
		let tab = app.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
		return app.buttons[tab.identifier.replacingOccurrences(of: "tucode.editor.tab.", with: "tucode.editor.tab.close.")]
	}

	private func revealMacSource(_ name: String, in app: XCUIApplication,
		file: StaticString = #filePath, line: UInt = #line) -> (XCUIElement, XCUIElement) {
		let macFolder = app.staticTexts["mac"]
		XCTAssertTrue(waitUntilHittable(macFolder), "Explorer rows were not painted", file: file, line: line)
		let sourcesFolder = app.staticTexts.matching(NSPredicate(
			format: "value == %@ OR value == %@", "Sources", "Sources/TucodeMac")).firstMatch
		let row = app.outlineRows.containing(NSPredicate(format: "value == %@", name)).firstMatch
		XCTAssertTrue(expand(macFolder, revealing: sourcesFolder),
			"mac directory children were not painted", file: file, line: line)
		XCTAssertTrue(expand(sourcesFolder, revealing: row),
			"VS Code's compact Sources/TucodeMac children were not painted", file: file, line: line)
		return (sourcesFolder, row)
	}

	private func launchApp(arguments: [String] = [], repository: URL? = nil,
		userDataDirectory: String? = nil) throws -> XCUIApplication {
		let appURL = repositoryRoot.appendingPathComponent(".build/macos/Tucode.app")
		XCTAssertTrue(FileManager.default.fileExists(atPath: appURL.path), "packaged production app is missing")

		let app = XCUIApplication(url: appURL)
		launchedApp = app
		let fixture = URL(fileURLWithPath: try XCTUnwrap(ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"]))
		app.launchArguments = ["--repo-root", (repository ?? fixture).path] + arguments
		if let repository {
			app.launchEnvironment["GIT_CEILING_DIRECTORIES"] = repository.deletingLastPathComponent().path
		}
		if let fixturePath = ProcessInfo.processInfo.environment["TUCODE_MAC_TEST_WORKSPACE"] {
			app.launchEnvironment["TSCODE_USER_DATA_DIR"] = "\(fixturePath)/user-data/\(UUID().uuidString)"
		}
		if let userDataDirectory { app.launchEnvironment["TSCODE_USER_DATA_DIR"] = userDataDirectory }
		app.launch()
		XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "XCUIApplication did not launch tucode in the foreground")
		return app
	}

	private var repositoryRoot: URL {
		URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
			.deletingLastPathComponent().deletingLastPathComponent()
	}

	private func waitForQuickInput(_ app: XCUIApplication, open: Bool = true) -> Bool {
		let ready = wait(for: NSPredicate(format: "exists == %@", NSNumber(value: open)),
			on: suggestionsPopover(app), timeout: 3)
		let error = app.staticTexts["tucode.bootstrap.error"]
		if error.exists { XCTFail("\(String(describing: error.value))") }
		return ready
	}

	private func suggestionsPopover(_ app: XCUIApplication) -> XCUIElement {
		app.descendants(matching: .any).matching(identifier: "tucode.quickInput.popover").firstMatch
	}

	private func suggestion(_ app: XCUIApplication, containing text: String) -> XCUIElement {
		suggestionsPopover(app).staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text)).firstMatch
	}

	private func waitUntilHittable(_ element: XCUIElement) -> Bool {
		wait(for: NSPredicate(format: "hittable == true"), on: element)
	}

	private func waitUntilNotHittable(_ element: XCUIElement) -> Bool {
		wait(for: NSPredicate(format: "hittable == false"), on: element)
	}

	private func waitForText(_ element: XCUIElement, containing text: String, timeout: TimeInterval = 15) -> Bool {
		wait(for: NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text),
			on: element, timeout: timeout)
	}

	private func waitForTextToDisappear(_ element: XCUIElement, text: String,
		timeout: TimeInterval = 15) -> Bool {
		wait(for: NSPredicate(format: "NOT (label CONTAINS[c] %@ OR value CONTAINS[c] %@)", text, text),
			on: element, timeout: timeout)
	}

	private func hasVisibleContrast(_ screenshot: XCUIScreenshot) -> Bool {
		guard let bitmap = NSBitmapImageRep(data: screenshot.pngRepresentation),
			bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0 else { return false }
		var minimum = CGFloat(1)
		var maximum = CGFloat(0)
		for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
			for x in stride(from: 0, to: bitmap.pixelsWide, by: 2) {
				guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
				let luminance = 0.2126 * color.redComponent + 0.7152 * color.greenComponent
					+ 0.0722 * color.blueComponent
				minimum = min(minimum, luminance)
				maximum = max(maximum, luminance)
			}
		}
		return maximum - minimum >= 0.12
	}

	private func waitForReadableSyntaxColors(in element: XCUIElement, timeout: TimeInterval = 15) -> Bool {
		let deadline = Date().addingTimeInterval(timeout)
		repeat {
			guard let bitmap = NSBitmapImageRep(data: element.screenshot().pngRepresentation) else { return false }
			var chromaticPixels = 0
			var readableChromaticPixels = 0
			// Keep the minimap out of this measurement: it must not make a blank main editor pass.
			let contentWidth = max(1, Int(Double(bitmap.pixelsWide) * 0.82))
			for y in stride(from: 0, to: bitmap.pixelsHigh, by: 3) {
				for x in stride(from: 0, to: contentWidth, by: 3) {
					guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
					let high = max(color.redComponent, color.greenComponent, color.blueComponent)
					let low = min(color.redComponent, color.greenComponent, color.blueComponent)
					guard high - low >= 0.08 else { continue }
					chromaticPixels += 1
					let luminance = 0.2126 * color.redComponent + 0.7152 * color.greenComponent
						+ 0.0722 * color.blueComponent
					if luminance >= 0.42 { readableChromaticPixels += 1 }
				}
			}
			if chromaticPixels >= 20
				&& Double(readableChromaticPixels) / Double(chromaticPixels) >= 0.5 { return true }
			RunLoop.current.run(until: Date().addingTimeInterval(0.1))
		} while Date() < deadline
		return false
	}

	private func readableSourceLineBands(_ screenshot: XCUIScreenshot) -> Int {
		var bands = 0
		var insideBand = false
		for readablePixels in readableSourcePixelsPerRow(screenshot) {
			let painted = readablePixels >= 4
			if painted && !insideBand { bands += 1 }
			insideBand = painted
		}
		return bands
	}

	private func readableSourcePixelCount(_ screenshot: XCUIScreenshot) -> Int {
		readableSourcePixelsPerRow(screenshot).reduce(0, +)
	}

	private func readableSourcePixelsPerRow(_ screenshot: XCUIScreenshot) -> [Int] {
		guard let bitmap = NSBitmapImageRep(data: screenshot.pngRepresentation),
			bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0 else { return [] }
		let startX = Int(Double(bitmap.pixelsWide) * 0.08)
		let endX = max(startX + 1, Int(Double(bitmap.pixelsWide) * 0.82))
		return (0..<bitmap.pixelsHigh).map { y in
			var readablePixels = 0
			for x in stride(from: startX, to: endX, by: 2) {
				guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
				let luminance = 0.2126 * color.redComponent + 0.7152 * color.greenComponent
					+ 0.0722 * color.blueComponent
				if luminance >= 0.35 { readablePixels += 1 }
			}
			return readablePixels
		}
	}

	private func waitForReadableSourceLines(in element: XCUIElement, minimum: Int,
		timeout: TimeInterval) -> Bool {
		let deadline = Date().addingTimeInterval(timeout)
		repeat {
			if readableSourceLineBands(element.screenshot()) >= minimum { return true }
			RunLoop.current.run(until: Date().addingTimeInterval(0.1))
		} while Date() < deadline
		return false
	}

	private func waitForVisibleMinimap(in element: XCUIElement, timeout: TimeInterval = 15) -> Bool {
		let deadline = Date().addingTimeInterval(timeout)
		repeat {
			guard let bitmap = NSBitmapImageRep(data: element.screenshot().pngRepresentation) else { return false }
			let startX = Int(Double(bitmap.pixelsWide) * 0.86)
			let endX = max(startX + 1, Int(Double(bitmap.pixelsWide) * 0.985))
			var chromaticPixels = 0
			var paintedRows = 0
			for y in 0..<bitmap.pixelsHigh {
				var rowPainted = false
				for x in stride(from: startX, to: endX, by: 2) {
					guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
					let high = max(color.redComponent, color.greenComponent, color.blueComponent)
					let low = min(color.redComponent, color.greenComponent, color.blueComponent)
					if high - low >= 0.08 {
						chromaticPixels += 1
						rowPainted = true
					}
				}
				if rowPainted { paintedRows += 1 }
			}
			if chromaticPixels >= 80 && paintedRows >= 30 { return true }
			RunLoop.current.run(until: Date().addingTimeInterval(0.1))
		} while Date() < deadline
		return false
	}

	private func wait(for predicate: NSPredicate, on element: XCUIElement,
		timeout: TimeInterval = 15) -> Bool {
		if predicate.evaluate(with: element) { return true }
		let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
		return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
	}

	/// VS Code restores tree expansion between launches. Normalize to collapsed, then exercise the
	/// real single-click expansion path so a prior test run cannot invert the gesture.
	private func expand(_ folder: XCUIElement, revealing child: XCUIElement,
		timeout: TimeInterval = 5) -> Bool {
		guard waitUntilHittable(folder) else { return false }
		if child.exists {
			folder.click()
			guard wait(for: NSPredicate(format: "exists == false"), on: child, timeout: timeout) else { return false }
		}
		folder.click()
		return child.waitForExistence(timeout: timeout)
	}

}
