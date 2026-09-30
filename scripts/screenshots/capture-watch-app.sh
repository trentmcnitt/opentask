#!/usr/bin/env bash
# Apple Watch app screenshots for the screenshot pipeline (docs/SCREENSHOTS.md).
#
#   scripts/screenshots/capture-watch-app.sh <run dir> <base url> <api token>
#
# Called by run.sh while the seeded server is still up: the watch app reads
# the sample account live, like on a real watch. Builds the watch app for the
# simulator, boots a THROWAWAY watch simulator ("OpenTask Screenshots",
# deleted on exit) whose every process sees the pipeline's frozen clock
# (watch-clock.c), launches the app once per page — Reminders, Tasks,
# Quotas — and saves each screen to <run dir>/native/watch-<page>.png.
# capture-watch.ts then composites them into the bezel.
#
# Skips (with a note, and no manifest entries) when this Mac has no watchOS
# simulator SDK or runtime. Needs Xcode and xcodegen; no device, no signing.
#
# The app itself has three DEBUG-only launch-environment hooks, all compiled
# out of Release: OPENTASK_SIM_SERVER_URL / OPENTASK_SIM_TOKEN (credentials —
# a simulator is never paired with a phone to receive them),
# OPENTASK_SIM_OPEN_URL (which page to open), and
# OPENTASK_SIM_SKIP_NOTIFICATION_PROMPT (the permission alert would cover
# the page, and nothing scriptable can answer it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$(cd "$1" && pwd)"
BASE_URL="$2"
TOKEN="$3"
NOW="${OPENTASK_SCREENSHOT_NOW:?OPENTASK_SCREENSHOT_NOW is not set}"
TZ_NAME="${SCREENSHOTS_TZ:-America/Chicago}"
SERVER_LOG="$RUN_DIR/server.log"
DERIVED="${SCREENSHOTS_WATCH_DERIVED_DATA:-/tmp/dd-shots-watch}"
DEVICE_NAME="OpenTask Screenshots"
BUNDLE_ID="io.mcnitt.opentask.watchapp"
OUT="$RUN_DIR/native"
mkdir -p "$OUT"

skip() {
  echo "watch: $1 — skipped (no Apple Watch screenshots this run)"
  (cd "$ROOT" && npx tsx -e "import { writeManifestPart } from './scripts/screenshots/manifest'; writeManifestPart(process.argv[1], 'watch', [])" "$RUN_DIR")
  exit 0
}

command -v xcodebuild >/dev/null 2>&1 || skip "no Xcode"
command -v xcodegen >/dev/null 2>&1 || skip "no xcodegen"
xcodebuild -showsdks 2>/dev/null | grep -q -- '-sdk watchsimulator' ||
  skip "no watchOS simulator SDK (Xcode › Settings › Components)"

# The newest available watchOS runtime, and a 46mm Series watch on it (the
# largest mainstream case; any Apple Watch if there is none).
read -r RUNTIME DEVICE_TYPE < <(xcrun simctl list -j runtimes devicetypes | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const rt = d.runtimes.filter((r) => r.platform === "watchOS" && r.isAvailable)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).pop()
  if (!rt) process.exit(0)
  const types = (rt.supportedDeviceTypes ?? d.devicetypes).filter((t) => t.productFamily === "Apple Watch")
  const series = (t) => Number(/Series (\d+)/.exec(t.name)?.[1] ?? 0)
  const pick = types.filter((t) => /Series \d+ \(46mm\)/.test(t.name))
    .sort((a, b) => series(a) - series(b)).pop() ?? types.pop()
  if (pick) console.log(rt.identifier, pick.identifier)
') || true
[ -n "${RUNTIME:-}" ] && [ -n "${DEVICE_TYPE:-}" ] || skip "no watchOS simulator runtime installed"

delete_device() {
  xcrun simctl list -j devices | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"))
    for (const list of Object.values(d.devices))
      for (const dev of list) if (dev.name === process.argv[1]) console.log(dev.udid)
  ' "$DEVICE_NAME" | while read -r udid; do
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  done
}
cleanup() {
  delete_device
  if [ "${SCREENSHOTS_KEEP_DERIVED_DATA:-0}" != "1" ]; then rm -rf "$DERIVED"; fi
}
trap cleanup EXIT INT TERM

echo "watch: building the watch app for the simulator (derived data in $DERIVED)"
(cd "$ROOT/ios" && xcodegen generate --quiet)
LOG="$OUT/xcodebuild-watch.log"
if ! xcodebuild build \
  -project "$ROOT/ios/OpenTask.xcodeproj" \
  -scheme OpenTaskWatch \
  -configuration Debug \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath "$DERIVED" >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" | head -20 >&2 || true
  echo "watch: xcodebuild failed — full log in $LOG" >&2
  exit 1
fi
APP="$DERIVED/Build/Products/Debug-watchsimulator/OpenTaskWatch.app"

# The frozen clock, injected into every process of the simulator at boot.
CLOCK_LIB="$DERIVED/watch-clock.dylib"
xcrun --sdk watchsimulator clang -target arm64-apple-watchos10.0-simulator \
  -dynamiclib -O2 -o "$CLOCK_LIB" "$ROOT/scripts/screenshots/watch-clock.c"
FAKE_NOW="$(node -e 'console.log(Math.floor(Date.parse(process.argv[1]) / 1000))' "$NOW")"

delete_device
UDID="$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
echo "watch: booting $DEVICE_TYPE ($RUNTIME) at $NOW"
# Frozen, not shifted (OPENTASK_FAKE_FROM unset): the clock in the corner
# reads the same minute however long boot and capture take.
SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$CLOCK_LIB" \
  SIMCTL_CHILD_OPENTASK_FAKE_NOW="$FAKE_NOW" \
  SIMCTL_CHILD_TZ="$TZ_NAME" \
  xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP"

# Every page's first load makes these requests (WatchViewModel.load()).
REQUESTS=("GET /api/reminders 200" "GET /api/tasks 200" "GET /api/projects 200"
  "GET /api/undo/status 200" "GET /api/user/preferences 200")

wait_for_load() {
  local from_line="$1"
  for _ in $(seq 1 120); do
    local fresh missing=0
    fresh="$(tail -n "+$((from_line + 1))" "$SERVER_LOG")"
    for req in "${REQUESTS[@]}"; do
      grep -qF "$req" <<<"$fresh" || { missing=1; break; }
    done
    [ "$missing" = 0 ] && return 0
    sleep 0.25
  done
  echo "watch: the app never loaded its data (see $SERVER_LOG)" >&2
  return 1
}

# Two identical consecutive frames = the page has painted what it loaded
# (and any launch animation has finished).
wait_for_stable_screen() {
  local dest="$1" prev="$OUT/.watch-prev.png" cur="$OUT/.watch-cur.png"
  xcrun simctl io "$UDID" screenshot "$prev" >/dev/null 2>&1
  for _ in $(seq 1 40); do
    sleep 0.5
    xcrun simctl io "$UDID" screenshot "$cur" >/dev/null 2>&1
    if cmp -s "$prev" "$cur"; then
      mv "$cur" "$dest"
      rm -f "$prev"
      return 0
    fi
    mv "$cur" "$prev"
  done
  rm -f "$prev"
  echo "watch: the screen never settled for $dest" >&2
  return 1
}

for page in reminders tasks quotas; do
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  from_line="$(wc -l <"$SERVER_LOG" | tr -d ' ')"
  # The boot environment covers the system's processes (the clock drawn in
  # the corner is theirs, not the app's); the app is handed the same clock
  # explicitly rather than relying on it inheriting that environment.
  launched="$(SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$CLOCK_LIB" \
    SIMCTL_CHILD_OPENTASK_FAKE_NOW="$FAKE_NOW" \
    SIMCTL_CHILD_TZ="$TZ_NAME" \
    SIMCTL_CHILD_OPENTASK_SIM_SERVER_URL="$BASE_URL" \
    SIMCTL_CHILD_OPENTASK_SIM_TOKEN="$TOKEN" \
    SIMCTL_CHILD_OPENTASK_SIM_OPEN_URL="opentask://$page" \
    SIMCTL_CHILD_OPENTASK_SIM_SKIP_NOTIFICATION_PROMPT=1 \
    xcrun simctl launch "$UDID" "$BUNDLE_ID")"
  pid="${launched##*: }"
  wait_for_load "$from_line"
  # A runtime that stopped honoring DYLD_INSERT_LIBRARIES would silently show
  # today's date; fail instead. (Checked once the app is up and has loaded.)
  # (Output captured first: `vmmap | grep -q` fails under pipefail, as grep
  # closes the pipe early.)
  images="$(vmmap "$pid" 2>/dev/null || true)"
  if ! grep -qF "watch-clock.dylib" <<<"$images"; then
    echo "watch: the frozen clock isn't loaded in the app (pid $pid) — refusing to capture" >&2
    exit 1
  fi
  wait_for_stable_screen "$OUT/watch-$page.png"
  echo "watch: captured $page"
done

xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
(cd "$ROOT" && npx tsx scripts/screenshots/capture-watch.ts "$RUN_DIR")
