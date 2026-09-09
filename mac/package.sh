#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_ROOT="$REPOSITORY_ROOT/.build/macos"
RUST_PROFILE=dev-small
SWIFT_CONFIGURATION=debug
RELEASE_VERSION=
BUILD_NUMBER=1
case "${1:-}" in
	--release)
		RELEASE_VERSION=${2:?Usage: mac/package.sh --release VERSION [BUILD_NUMBER]}
		BUILD_NUMBER=${3:-1}
		if [ "$#" -gt 3 ] || ! printf '%s\n' "$RELEASE_VERSION" | /usr/bin/egrep -q '^[0-9]+\.[0-9]+\.[0-9]+$' ||
			! printf '%s\n' "$BUILD_NUMBER" | /usr/bin/egrep -q '^[1-9][0-9]*$'; then
			echo 'Expected a numeric X.Y.Z version and a positive build number.' >&2
			exit 1
		fi
		BUILD_ROOT="$REPOSITORY_ROOT/.build/macos-release"
		RUST_PROFILE=release
		SWIFT_CONFIGURATION=release
		export TUCODE_RELEASE_VERSION="$RELEASE_VERSION"
		export TAURI_ENV_DEBUG=
		# Cargo uses unit separators here, so checkout paths containing spaces work.
		export CARGO_ENCODED_RUSTFLAGS="$(printf '%s\037%s' \
			"--remap-path-prefix=$REPOSITORY_ROOT=." \
			"--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=cargo")"
		;;
	'') ;;
	*) echo 'Usage: mac/package.sh [--release VERSION [BUILD_NUMBER]]' >&2; exit 1 ;;
esac
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

(cd "$REPOSITORY_ROOT/src-tauri" && cargo build --locked --profile "$RUST_PROFILE" -p tscode-mac)

set --
if [ "$SWIFT_CONFIGURATION" = release ]; then
	set -- -Xswiftc -gnone \
		-Xswiftc -file-prefix-map -Xswiftc "$REPOSITORY_ROOT=."
fi
xcrun swift build --package-path "$SCRIPT_DIR" --scratch-path "$SWIFT_BUILD" \
	--configuration "$SWIFT_CONFIGURATION" --product TucodeMac "$@"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Web" \
	"$APP/Contents/Frameworks" "$APP/Contents/Resources/app/resources"
cp "$SWIFT_BUILD/$SWIFT_CONFIGURATION/TucodeMac" "$APP/Contents/MacOS/Tucode"
cp "$SCRIPT_DIR/App/Info.plist" "$APP/Contents/Info.plist"
/bin/sh "$SCRIPT_DIR/App/build-icon.sh" "$APP/Contents"
cp -R "$REPOSITORY_ROOT/dist-mac/." "$APP/Contents/Resources/Web/"
cp "$REPOSITORY_ROOT/src-tauri/target/$RUST_PROFILE/libtscode_mac.dylib" "$APP/Contents/Frameworks/"
cp -R "$REPOSITORY_ROOT/resources/extensions" "$APP/Contents/Resources/app/resources/extensions"
cp -R "$SCRIPT_DIR/Resources/extensions/." "$APP/Contents/Resources/app/resources/extensions/"
cp "$REPOSITORY_ROOT/LICENSE.txt" "$REPOSITORY_ROOT/LICENSE-sapling.txt" \
	"$REPOSITORY_ROOT/ThirdPartyNotices.txt" "$APP/Contents/Resources/"

if [ -n "$RELEASE_VERSION" ]; then
	/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $RELEASE_VERSION" "$APP/Contents/Info.plist"
	/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
	# SwiftPM also injects its toolchain's library directory. Keep only system
	# and bundle-relative search paths in the distributable executable.
	/usr/bin/otool -l "$APP/Contents/MacOS/Tucode" | /usr/bin/awk '
		/cmd LC_RPATH/ { getline; getline; sub(/^[ \t]*path /, ""); sub(/ \(offset.*$/, ""); print }
	' | while IFS= read -r RELEASE_RPATH; do
		case "$RELEASE_RPATH" in
			/usr/lib/*) ;;
			/*) /usr/bin/install_name_tool -delete_rpath "$RELEASE_RPATH" "$APP/Contents/MacOS/Tucode" ;;
		esac
	done
	/usr/bin/strip -S "$APP/Contents/MacOS/Tucode"
fi

echo "$APP"
