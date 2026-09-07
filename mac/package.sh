#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_ROOT="$REPOSITORY_ROOT/.build/macos"
SWIFT_BUILD="$BUILD_ROOT/swiftpm"
APP="$BUILD_ROOT/Tucode.app"

mkdir -p "$BUILD_ROOT/cache/clang"
export CLANG_MODULE_CACHE_PATH="$BUILD_ROOT/cache/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$BUILD_ROOT/cache/clang"
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
	export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

# Mac bundles the editor graph and the in-process Rust library.
(cd "$REPOSITORY_ROOT" && npm run build:mac-web)

(cd "$REPOSITORY_ROOT/src-tauri" && cargo build --profile dev-small -p tscode-mac)

xcrun swift build --package-path "$SCRIPT_DIR" --scratch-path "$SWIFT_BUILD" --product TucodeMac

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Web" \
	"$APP/Contents/Frameworks" "$APP/Contents/Resources/app/resources"
cp "$SWIFT_BUILD/debug/TucodeMac" "$APP/Contents/MacOS/Tucode"
cp "$SCRIPT_DIR/App/Info.plist" "$APP/Contents/Info.plist"
cp -R "$REPOSITORY_ROOT/dist-mac/." "$APP/Contents/Resources/Web/"
cp "$REPOSITORY_ROOT/src-tauri/target/dev-small/libtscode_mac.dylib" "$APP/Contents/Frameworks/"
cp -R "$REPOSITORY_ROOT/resources/extensions" "$APP/Contents/Resources/app/resources/extensions"
cp -R "$SCRIPT_DIR/Resources/extensions/." "$APP/Contents/Resources/app/resources/extensions/"

echo "$APP"
