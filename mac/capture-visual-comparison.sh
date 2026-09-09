#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_ROOT="$REPOSITORY_ROOT/.build/macos"
TOOL_SOURCE="$SCRIPT_DIR/Tools/VisualCompare.swift"
TOOL="$BUILD_ROOT/tools/visual-compare"
APP="$BUILD_ROOT/Code.app"
LABEL=${1:-navigator}
WINDOW_X=${VISUAL_COMPARE_X:-40}
WINDOW_Y=${VISUAL_COMPARE_Y:-40}
WINDOW_WIDTH=${VISUAL_COMPARE_WIDTH:-980}
WINDOW_HEIGHT=${VISUAL_COMPARE_HEIGHT:-650}
STAMP=$(date +%Y%m%d-%H%M%S)
OUTP UT="$BUILD_ROOT/visual-comparisons/$STAMP-$LABEL"
TAB_SCENARIO=${VISUAL_COMPARE_TAB_SCENARIO:-}

mkdir -p "$BUILD_ROOT/cache/clang"
export CLANG_MODULE_CACHE_PATH="$BUILD_ROOT/cache/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$BUILD_ROOT/cache/clang"
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
	export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

case "$LABEL" in
	*[!A-Za-z0-9._-]*) echo "Label contains unsupported characters." >&2; exit 2 ;;
esac

mkdir -p "$BUILD_ROOT/tools" "$OUTPUT"
if [ ! -x "$TOOL" ] || [ "$TOOL_SOURCE" -nt "$TOOL" ]; then
	xcrun swiftc "$TOOL_SOURCE" -o "$TOOL" -framework AppKit -framework ApplicationServices
fi

XCODE_PID=""
TUCODE_PID=""
XCODE_STARTED=0
cleanup() {
	if [ -n "$TUCODE_PID" ]; then
		"$TOOL" terminate "$TUCODE_PID" >/dev/null 2>&1 || true
	fi
	if [ "$XCODE_STARTED" -eq 1 ] && [ -n "$XCODE_PID" ]; then
		"$TOOL" terminate "$XCODE_PID" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT HUP INT TERM

capture_window() {
	window_id=$1
	destination=$2
	if ! /usr/sbin/screencapture -x -l "$window_id" "$destination"; then
		echo "Window capture failed. Grant Screen Recording access to the terminal running this script," >&2
		echo "then rerun it. The launched app instances have been stopped." >&2
		exit 1
	fi
}

wait_for_window() {
	process_name=$1
	process_id=$2
	attempt=0
	while [ "$attempt" -lt 120 ]; do
		if "$TOOL" window-id-pid "$process_id" >/dev/null 2>&1; then
			return
		fi
		attempt=$((attempt + 1))
		sleep 0.25
	done
	echo "$process_name PID $process_id has no normal window." >&2
	exit 1
}

EXISTING_TUCODE_PIDS=$("$TOOL" pids com.tucode.app)
if [ -n "$EXISTING_TUCODE_PIDS" ]; then
	echo "Tucode is already running. Quit it before capturing a newly packaged copy." >&2
	exit 1
fi

"$SCRIPT_DIR/package.sh"
if XCODE_PID=$("$TOOL" latest-pid com.apple.dt.Xcode 2>/dev/null); then
	:
else
	XCODE_STARTED=1
	/usr/bin/open -a Xcode "$SCRIPT_DIR/Package.swift"
	sleep 1
	XCODE_PID=$("$TOOL" latest-pid com.apple.dt.Xcode)
fi
if [ -n "$TAB_SCENARIO" ]; then
	/usr/bin/open "$APP" --args --repo-root "$REPOSITORY_ROOT" --visual-compare-tabs "$TAB_SCENARIO"
else
	/usr/bin/open "$APP" --args --repo-root "$REPOSITORY_ROOT"
fi
sleep 1
TUCODE_PID=$("$TOOL" latest-pid com.tucode.app)
wait_for_window Xcode "$XCODE_PID"
wait_for_window Tucode "$TUCODE_PID"
"$TOOL" set-frame-pid "$XCODE_PID" "$WINDOW_X" "$WINDOW_Y" "$WINDOW_WIDTH" "$WINDOW_HEIGHT"
"$TOOL" set-frame-pid "$TUCODE_PID" "$WINDOW_X" "$WINDOW_Y" "$WINDOW_WIDTH" "$WINDOW_HEIGHT"
sleep 0.5

"$TOOL" activate "$XCODE_PID"
sleep 0.25
XCODE_WINDOW_ID=$("$TOOL" window-id-pid "$XCODE_PID")
capture_window "$XCODE_WINDOW_ID" "$OUTPUT/xcode.png"
"$TOOL" activate "$TUCODE_PID"
sleep 0.25
TUCODE_WINDOW_ID=$("$TOOL" window-id-pid "$TUCODE_PID")
capture_window "$TUCODE_WINDOW_ID" "$OUTPUT/tucode.png"
"$TOOL" verify-size "$OUTPUT/xcode.png" "$OUTPUT/tucode.png"
"$TOOL" compose "$OUTPUT/xcode.png" "$OUTPUT/tucode.png" "$OUTPUT/side-by-side.png"
"$TOOL" analyze-selection "$OUTPUT/xcode.png" "$OUTPUT/tucode.png" \
	"$OUTPUT/selection-detail.png" "$OUTPUT/selection-analysis.txt"

{
	echo "Native display-scale captures; source images were not resized."
	echo "Requested frame: $WINDOW_WIDTH x $WINDOW_HEIGHT at $WINDOW_X,$WINDOW_Y points"
	sips -g pixelWidth -g pixelHeight "$OUTPUT/xcode.png" "$OUTPUT/tucode.png"
} > "$OUTPUT/measurements.txt"

echo "$OUTPUT"
echo "  xcode.png"
echo "  tucode.png"
echo "  side-by-side.png"
echo "  selection-detail.png"
echo "  selection-analysis.txt"
echo "  measurements.txt"
