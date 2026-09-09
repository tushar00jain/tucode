#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_ROOT="$REPOSITORY_ROOT/.build/macos"
TOOL_SOURCE="$SCRIPT_DIR/Tools/VisualCompare.swift"
TOOL="$BUILD_ROOT/tools/visual-compare"
APP="$BUILD_ROOT/Code.app"
LABEL=${1:-mac-ui}
TAB_SCENARIO=${VISUAL_COMPARE_TAB_SCENARIO:-}
CAPTURE_FULL_SCREEN=${VISUAL_COMPARE_FULL_SCREEN:-0}
CAPTURE_DELAY=${VISUAL_COMPARE_SETTLE_SECONDS:-3}
STAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT="$BUILD_ROOT/ui-captures/$STAMP-$LABEL"

case "$LABEL" in
	*[!A-Za-z0-9._-]*) echo "Label contains unsupported characters." >&2; exit 2 ;;
esac

mkdir -p "$BUILD_ROOT/cache/clang" "$BUILD_ROOT/tools" "$OUTPUT"
export CLANG_MODULE_CACHE_PATH="$BUILD_ROOT/cache/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$BUILD_ROOT/cache/clang"
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
	export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

if [ ! -x "$TOOL" ] || [ "$TOOL_SOURCE" -nt "$TOOL" ]; then
	xcrun swiftc "$TOOL_SOURCE" -o "$TOOL" -framework AppKit -framework ApplicationServices
fi

TUCODE_PID=""
cleanup() {
	trap - EXIT HUP INT TERM
	[ -n "$TUCODE_PID" ] || return

	"$TOOL" terminate "$TUCODE_PID" >/dev/null 2>&1 || true
	attempt=0
	while /bin/kill -0 "$TUCODE_PID" >/dev/null 2>&1 && [ "$attempt" -lt 30 ]; do
		attempt=$((attempt + 1))
		sleep 0.1
	done

	if /bin/kill -0 "$TUCODE_PID" >/dev/null 2>&1; then
		/bin/kill -TERM "$TUCODE_PID" >/dev/null 2>&1 || true
		attempt=0
		while /bin/kill -0 "$TUCODE_PID" >/dev/null 2>&1 && [ "$attempt" -lt 30 ]; do
			attempt=$((attempt + 1))
			sleep 0.1
		done
	fi
}
trap cleanup EXIT HUP INT TERM

EXISTING_TUCODE_PIDS=$(
	"$TOOL" pids com.tucode.app
)
if [ -n "$EXISTING_TUCODE_PIDS" ]; then
	echo "Tucode is already running. Quit it before capturing a newly packaged copy." >&2
	exit 1
fi

"$SCRIPT_DIR/package.sh"
if [ -n "$TAB_SCENARIO" ]; then
	/usr/bin/open "$APP" --args --repo-root "$REPOSITORY_ROOT" --visual-compare-tabs "$TAB_SCENARIO"
else
	/usr/bin/open "$APP" --args --repo-root "$REPOSITORY_ROOT"
fi

attempt=0
while [ -z "$TUCODE_PID" ]; do
	for candidate in $("$TOOL" pids com.tucode.app); do
		case " $EXISTING_TUCODE_PIDS " in
			*" $candidate "*) ;;
			*) TUCODE_PID=$candidate; break ;;
		esac
	done
	if [ -z "$TUCODE_PID" ]; then
		attempt=$((attempt + 1))
		if [ "$attempt" -ge 120 ]; then
			echo "The newly launched Tucode process did not appear." >&2
			exit 1
		fi
		sleep 0.25
	fi
done

attempt=0
while ! "$TOOL" window-id-pid "$TUCODE_PID" >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 120 ]; then
		echo "Tucode PID $TUCODE_PID has no normal window." >&2
		exit 1
	fi
	sleep 0.25
done

WINDOW_ID=$("$TOOL" window-id-pid "$TUCODE_PID")
sleep "$CAPTURE_DELAY"
if ! /usr/sbin/screencapture -x -l "$WINDOW_ID" "$OUTPUT/tucode.png"; then
	echo "Window capture failed. Grant Screen Recording access to the terminal running this script." >&2
	exit 1
fi

if [ "$CAPTURE_FULL_SCREEN" -eq 1 ]; then
	INITIAL_BOUNDS=$("$TOOL" window-bounds-pid "$TUCODE_PID")
	attempt=0
	while ! "$TOOL" set-full-screen-pid "$TUCODE_PID" 1 >/dev/null 2>&1; do
		attempt=$((attempt + 1))
		if [ "$attempt" -ge 120 ]; then
			echo "Tucode PID $TUCODE_PID did not expose its full-screen control." >&2
			exit 1
		fi
		sleep 0.1
	done
	attempt=0
	stable=0
	last_bounds=""
	while [ "$stable" -lt 3 ]; do
		attempt=$((attempt + 1))
		if [ "$attempt" -ge 120 ]; then
			echo "Tucode PID $TUCODE_PID did not enter full screen." >&2
			exit 1
		fi
		current_bounds=$("$TOOL" window-bounds-pid "$TUCODE_PID" 2>/dev/null || true)
		if [ -n "$current_bounds" ] && [ "$current_bounds" != "$INITIAL_BOUNDS" ] \
			&& [ "$current_bounds" = "$last_bounds" ]; then
			stable=$((stable + 1))
		else
			stable=0
		fi
		last_bounds=$current_bounds
		sleep 0.1
	done
	WINDOW_ID=$("$TOOL" window-id-pid "$TUCODE_PID")
	if ! /usr/sbin/screencapture -x -l "$WINDOW_ID" "$OUTPUT/tucode-full-screen.png"; then
		echo "Full-screen window capture failed." >&2
		exit 1
	fi
fi

echo "$OUTPUT/tucode.png"
[ "$CAPTURE_FULL_SCREEN" -eq 0 ] || echo "$OUTPUT/tucode-full-screen.png"
