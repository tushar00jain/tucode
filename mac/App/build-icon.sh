#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTENTS=${1:?Usage: build-icon.sh /path/to/Code.app/Contents}
WORK=$(mktemp -d "$CONTENTS/app-icon.XXXXXX")
trap 'rm -rf "$WORK"' 0
trap 'exit 1' HUP INT TERM

xcrun actool "$SCRIPT_DIR/AppIcon.icon" --compile "$CONTENTS/Resources" \
	--platform macosx --target-device mac --minimum-deployment-target 26.0 \
	--app-icon AppIcon --lightweight-asset-runtime-mode=enabled \
	--output-partial-info-plist "$WORK/icon-info.plist" --output-format human-readable-text
/usr/libexec/PlistBuddy -c "Merge \"$WORK/icon-info.plist\"" "$CONTENTS/Info.plist"
