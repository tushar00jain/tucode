# Mac development

AppKit owns native controls and input; Wry hosts the editor WKWebView.
Rust runs on workers inside the app. The packaged runtime needs no Node installation.
See [architecture](../docs/ARCHITECTURE.md) and [shared TODO](../docs/TODO.md).

From the repository root, on macOS 14+ with Node, Rust, and Xcode installed:

```sh
npm install
mac/launch.sh /path/to/project          # builds and opens the app; defaults to this checkout
mac/test-foreground.sh                  # focused foreground XCUITests
mac/capture-visual-comparison.sh navigator  # optional comparison with Xcode
```

Quit an existing Tucode session before rebuilding or testing. The development app is at `.build/macos/Tucode.app`.
Foreground tests use the existing `Automation Signing` identity in `~/Library/Keychains/Automation.keychain-db` and create their own fixtures.
Set `TUCODE_MAC_ONLY_TESTING` to an XCUITest identifier to select a workflow. There is no background Mac UI test path.
Visual captures require Screen Recording/Accessibility access and go under `.build/macos/visual-comparisons/`.
