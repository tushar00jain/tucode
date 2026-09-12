#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PROJECT="$SCRIPT_DIR/UITests/TucodeMacUITests.xcodeproj"
DERIVED_DATA="$REPOSITORY_ROOT/.build/xcui/DerivedData"
ONLY_TESTING=${TUCODE_MAC_ONLY_TESTING:-TucodeMacUITests/EventLoopUITests}
DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
export DEVELOPER_DIR

if /usr/bin/pgrep -x Tucode >/dev/null 2>&1; then
	echo "Tucode is already running. Quit it before running the foreground UI suite." >&2
	exit 1
fi

# The sandboxed XCUI runner cannot create a workspace in the checkout. Prepare an owned
# fixture here, outside the runner's privacy-protected per-app temporary storage.
mkdir -p "$REPOSITORY_ROOT/.build/test-fixtures"
MAC_TEST_WORKSPACE=$(mktemp -d "$REPOSITORY_ROOT/.build/test-fixtures/mac-ui.XXXXXX")
MAC_TEST_PROFILE=$(mktemp -d "${TMPDIR:-/tmp/}tucode-profile.XXXXXX")
trap 'rm -rf "$MAC_TEST_WORKSPACE" "$MAC_TEST_PROFILE"' EXIT HUP INT TERM
mkdir -p "$MAC_TEST_WORKSPACE/mac/Tests/TucodeMacTests" "$MAC_TEST_WORKSPACE/mac/App"
cp "$SCRIPT_DIR/App/Info.plist" "$MAC_TEST_WORKSPACE/mac/App/Info.plist"
mkdir -p "$MAC_TEST_WORKSPACE/mac/UITests/Tests" "$MAC_TEST_WORKSPACE/mac/UITests/TucodeMacUITests.xcodeproj"
cp "$SCRIPT_DIR/UITests/TucodeMacUITests.xcodeproj/project.pbxproj" "$MAC_TEST_WORKSPACE/mac/UITests/TucodeMacUITests.xcodeproj/project.pbxproj"
mkdir -p "$MAC_TEST_WORKSPACE/mac/Sources/TucodeMac"
cp "$SCRIPT_DIR/Package.swift" "$MAC_TEST_WORKSPACE/mac/Package.swift"
for MAC_TEST_FILE in Sources/TucodeMac/Projection.swift Sources/TucodeMac/EditorAreaView.swift Sources/TucodeMac/EditorProtocol.swift Sources/TucodeMac/main.swift README.md capture-visual-comparison.sh launch.sh package.sh capture-mac-ui.sh sign-test-artifacts.mjs test-foreground.sh; do
	cp "$SCRIPT_DIR/$MAC_TEST_FILE" "$MAC_TEST_WORKSPACE/mac/$MAC_TEST_FILE"
done
export TEST_RUNNER_TUCODE_MAC_TEST_WORKSPACE="$MAC_TEST_WORKSPACE"

# Enough expanded results to exercise the native boundary rather than just the search model.
node --input-type=module - "$MAC_TEST_WORKSPACE" <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = join(process.argv[2], 'search-load');
mkdirSync(join(root, '.vscode'), { recursive: true });
writeFileSync(join(root, '.vscode/settings.json'), JSON.stringify({
  'search.collapseResults': 'alwaysExpand', 'search.defaultViewMode': 'list', 'search.searchOnTypeDebouncePeriod': 300
}));
for (let file = 0; file < 1000; file++) {
  writeFileSync(join(root, `result-${String(file).padStart(4, '0')}.txt`),
    Array.from({ length: 20 }, (_, line) => `boundary-needle ${file} ${line}\n`).join(''));
}
JS

mkdir -p "$MAC_TEST_WORKSPACE/test/native/fixtures" "$MAC_TEST_WORKSPACE/test/e2e"
cp "$REPOSITORY_ROOT/test/native/fixtures/EditorClickFixture.swift" "$MAC_TEST_WORKSPACE/test/native/fixtures/EditorClickFixture.swift"
cp "$REPOSITORY_ROOT/test/native/terminalFindRealPty.test.mjs" "$MAC_TEST_WORKSPACE/test/native/terminalFindRealPty.test.mjs"

mkdir -p "$MAC_TEST_WORKSPACE/native-picker"
cp "$SCRIPT_DIR/Package.swift" "$MAC_TEST_WORKSPACE/native-picker/open source.swift"
cp "$SCRIPT_DIR/README.md" "$MAC_TEST_WORKSPACE/native-picker/replace me.txt"
mkdir -p "$MAC_TEST_WORKSPACE/third-folder"
cp "$SCRIPT_DIR/Package.swift" "$MAC_TEST_WORKSPACE/third-folder/third.swift"

mkdir -p "$MAC_TEST_WORKSPACE/native-tabs-user-data"
# Linked configuration is outside every opened folder and the bundled resource root.
cat > "$MAC_TEST_PROFILE/settings.json" <<'JSON'
{"window.nativeTabs": true}
JSON
cat > "$MAC_TEST_PROFILE/keybindings.json" <<'JSON'
[
  {"key": "cmd+shift+[", "command": "workbench.action.showPreviousWindowTab"},
  {"key": "cmd+shift+]", "command": "workbench.action.showNextWindowTab"}
]
JSON
ln -s "$MAC_TEST_PROFILE/settings.json" "$MAC_TEST_WORKSPACE/native-tabs-user-data/settings.json"
ln -s "$MAC_TEST_PROFILE/keybindings.json" "$MAC_TEST_WORKSPACE/native-tabs-user-data/keybindings.json"

mkdir -p "$MAC_TEST_WORKSPACE/markdown"
cp "$REPOSITORY_ROOT/test/fixtures/mac-markdown/preview.md" "$MAC_TEST_WORKSPACE/markdown/preview.md"
cp "$SCRIPT_DIR/Package.swift" "$MAC_TEST_WORKSPACE/markdown/companion.swift"

mkdir -p "$MAC_TEST_WORKSPACE/changes/.vscode"
for MAC_CHANGES_REPO in repo-a repo-b; do
	MAC_CHANGES_ROOT="$MAC_TEST_WORKSPACE/changes/$MAC_CHANGES_REPO"
	mkdir -p "$MAC_CHANGES_ROOT/nested/one/two"
	git -C "$MAC_CHANGES_ROOT" init -q
	git -C "$MAC_CHANGES_ROOT" config user.name Fixture
	git -C "$MAC_CHANGES_ROOT" config user.email fixture@example.invalid
	cp "$SCRIPT_DIR/Package.swift" "$MAC_CHANGES_ROOT/same.txt"
	cp "$SCRIPT_DIR/Package.swift" "$MAC_CHANGES_ROOT/nested/one/two/deep.txt"
	git -C "$MAC_CHANGES_ROOT" add .
	git -C "$MAC_CHANGES_ROOT" commit -qm fixture
	cp "$SCRIPT_DIR/README.md" "$MAC_CHANGES_ROOT/same.txt"
	git -C "$MAC_CHANGES_ROOT" add same.txt
	cp "$SCRIPT_DIR/launch.sh" "$MAC_CHANGES_ROOT/same.txt"
	cp "$SCRIPT_DIR/README.md" "$MAC_CHANGES_ROOT/nested/one/two/deep.txt"
	cp "$SCRIPT_DIR/Package.swift" "$MAC_CHANGES_ROOT/new.txt"
done
cp "$REPOSITORY_ROOT/test/fixtures/mac-changes/settings.json" "$MAC_TEST_WORKSPACE/changes/.vscode/settings.json"
cp "$REPOSITORY_ROOT/test/fixtures/mac-changes/changes.code-workspace" "$MAC_TEST_WORKSPACE/changes/changes.code-workspace"
cp "$REPOSITORY_ROOT/test/fixtures/mac-changes/list.code-workspace" "$MAC_TEST_WORKSPACE/changes/list.code-workspace"

# Historical editor contents must differ from the working copy.
MAC_HISTORY_ROOT="$MAC_TEST_WORKSPACE/history"
mkdir -p "$MAC_HISTORY_ROOT/.vscode"
git -C "$MAC_HISTORY_ROOT" init -q
git -C "$MAC_HISTORY_ROOT" config user.name Fixture
git -C "$MAC_HISTORY_ROOT" config user.email fixture@example.invalid
# A linear ancestor verifies the graph narrows again after the branch converges.
git -C "$MAC_HISTORY_ROOT" commit --allow-empty -qm 'history seed'
printf '%s\n' '{"scm.defaultViewMode":"list","scm.graph.pageOnScroll":false,"editor.accessibilitySupport":"on"}' > "$MAC_HISTORY_ROOT/.vscode/settings.json"
printf '%s\n' 'history-before' > "$MAC_HISTORY_ROOT/revision.txt"
git -C "$MAC_HISTORY_ROOT" add .
git -C "$MAC_HISTORY_ROOT" commit -qm 'history base'
printf '%s\n' 'history-after' > "$MAC_HISTORY_ROOT/revision.txt"
git -C "$MAC_HISTORY_ROOT" commit -qam 'history update'
MAC_HISTORY_BRANCH=$(git -C "$MAC_HISTORY_ROOT" symbolic-ref --short HEAD)
git -C "$MAC_HISTORY_ROOT" checkout -qb history-topic HEAD~1
printf '%s\n' 'branch-content' > "$MAC_HISTORY_ROOT/branch.txt"
mkdir -p "$MAC_HISTORY_ROOT/branch-dir/inside"
printf '%s\n' 'nested-branch-content' > "$MAC_HISTORY_ROOT/branch-dir/inside/nested.txt"
git -C "$MAC_HISTORY_ROOT" add branch.txt branch-dir
git -C "$MAC_HISTORY_ROOT" commit -qm 'history branch'
git -C "$MAC_HISTORY_ROOT" checkout -q "$MAC_HISTORY_BRANCH"
git -C "$MAC_HISTORY_ROOT" merge -q --no-ff -m 'history merge' history-topic
printf '%s\n' 'working-copy-only' > "$MAC_HISTORY_ROOT/revision.txt"

mkdir -p "$MAC_TEST_WORKSPACE/native-explorer/.vscode" "$MAC_TEST_WORKSPACE/native-explorer/mac"
cp "$REPOSITORY_ROOT/test/fixtures/mac-explorer/settings.json" "$MAC_TEST_WORKSPACE/native-explorer/.vscode/settings.json"
for MAC_TEST_FILE in hidden-native.txt bundle.ts bundle.js z-native.txt; do
	cp "$SCRIPT_DIR/Package.swift" "$MAC_TEST_WORKSPACE/native-explorer/$MAC_TEST_FILE"
done

"$SCRIPT_DIR/package.sh"

/usr/bin/xcodebuild build-for-testing \
	-project "$PROJECT" \
	-scheme TucodeMacUITests \
	-destination 'platform=macOS,arch=arm64' \
	-derivedDataPath "$DERIVED_DATA" \
	ARCHS=arm64 ONLY_ACTIVE_ARCH=YES EXCLUDED_ARCHS=x86_64

node "$SCRIPT_DIR/sign-test-artifacts.mjs"

# A space-separated selection runs related native workflows against the same owned fixture.
set --
for MAC_ONLY_TEST in $ONLY_TESTING; do
	set -- "$@" "-only-testing:$MAC_ONLY_TEST"
done

/usr/bin/xcodebuild test-without-building \
	-project "$PROJECT" \
	-scheme TucodeMacUITests \
	-destination 'platform=macOS,arch=arm64' \
	-derivedDataPath "$DERIVED_DATA" \
	"$@" \
	ARCHS=arm64 ONLY_ACTIVE_ARCH=YES EXCLUDED_ARCHS=x86_64
