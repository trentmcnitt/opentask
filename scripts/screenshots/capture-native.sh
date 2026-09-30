#!/usr/bin/env bash
# Native captures for the screenshot pipeline (docs/SCREENSHOTS.md).
#
#   scripts/screenshots/capture-native.sh <run dir>
#
# Expects <run dir>/widget-data/ (dumped by run.sh from the seeded server).
# Renders the widget views to <run dir>/native/ through the
# OpenTaskScreenshotRenders test bundle (macos/project.yml). Needs Xcode and
# xcodegen; no simulator, no signing. (The Apple Watch shots need the live
# server, so run.sh takes them earlier: capture-watch-app.sh.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$(cd "$1" && pwd)"
NOW="${OPENTASK_SCREENSHOT_NOW:?OPENTASK_SCREENSHOT_NOW is not set}"
TZ_NAME="${SCREENSHOTS_TZ:-America/Chicago}"
# One derived-data dir, outside the repo, deleted afterwards (disk is tight)
# unless SCREENSHOTS_KEEP_DERIVED_DATA=1 keeps it for a faster rerun.
DERIVED="${SCREENSHOTS_DERIVED_DATA:-/tmp/dd-shots-mac}"

mkdir -p "$RUN_DIR/native"

echo "native: generating the Mac project"
(cd "$ROOT/macos" && xcodegen generate --quiet)

echo "native: rendering widgets (xcodebuild test, derived data in $DERIVED)"
LOG="$RUN_DIR/native/xcodebuild.log"
if ! TEST_RUNNER_SCREENSHOTS_WIDGET_DATA="$RUN_DIR/widget-data" \
  TEST_RUNNER_SCREENSHOTS_NATIVE_OUT="$RUN_DIR/native" \
  TEST_RUNNER_SCREENSHOTS_NOW="$NOW" \
  TEST_RUNNER_TZ="$TZ_NAME" \
  xcodebuild test \
    -project "$ROOT/macos/OpenTaskMac.xcodeproj" \
    -scheme OpenTaskScreenshotRenders \
    -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO >"$LOG" 2>&1; then
  grep -E "error:|failed" "$LOG" | head -20 >&2 || true
  echo "native: xcodebuild failed — full log in $LOG" >&2
  exit 1
fi

if [ "${SCREENSHOTS_KEEP_DERIVED_DATA:-0}" != "1" ]; then
  rm -rf "$DERIVED"
fi
echo "native: done → $RUN_DIR/native"
