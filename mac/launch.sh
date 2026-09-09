#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ "$#" -gt 1 ]; then
	echo "Usage: $0 [folder]" >&2
	exit 2
fi
TARGET_ROOT=$(CDPATH= cd -- "${1:-$REPOSITORY_ROOT}" && pwd)

if /usr/bin/pgrep -x Tucode >/dev/null 2>&1; then
	echo "Tucode is already running. Quit it before rebuilding and launching a new development copy." >&2
	exit 1
fi

"$SCRIPT_DIR/package.sh"
exec /usr/bin/open -W "$REPOSITORY_ROOT/.build/macos/Code.app" \
	--args --repo-root "$TARGET_ROOT"
