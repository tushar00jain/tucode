# Mac development

AppKit owns native controls and input; Wry hosts the editor WKWebView.
Rust runs on workers inside the app. The packaged runtime needs no Node installation.
See [architecture](../docs/ARCHITECTURE.md) and [shared TODO](../docs/TODO.md).

From the repository root, on macOS 26+ with Node, Rust, and Xcode installed:

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

## Package for GitHub Releases

```sh
# Build, sign ad-hoc, and ZIP (no certificate or Apple account needed)
node mac/release.mjs --version 0.1.0

# Copy the app after quitting Tucode; replaces the installed copy
ditto .build/macos-release/Tucode.app /Applications/Tucode.app
```

After committing the release changes and building that commit, publish separately (`gh` must be logged in):

```sh
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 .build/macos-release/tucode-v0.1.0-macos-arm64.zip .build/macos-release/tucode-v0.1.0-macos-arm64.zip.sha256 --verify-tag --title "tucode v0.1.0" --generate-notes
```

Downloaded copies require **System Settings → Privacy & Security → Open Anyway** after the first launch attempt.
Use `--help` for optional Developer ID signing and notarization.
