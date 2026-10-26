#!/bin/bash
# Build the iPhone app (with its embedded Apple Watch app) in Release, check
# that every bundle that needs push is signed for it, and install it on the
# iPhones you name. The watch app rides along: iOS syncs it to the paired
# watch (devicectl cannot install on a watch directly; ios/AGENTS.md).
#
# Usage:
#   ios/scripts/install-iphone.sh <device-udid> [<device-udid> ...]
#   ios/scripts/install-iphone.sh --verify-only [<device-udid> ...]
#
# List devices and their UDIDs (the State column says which are reachable):
#   xcrun devicectl list devices
#
# Derived data: $OPENTASK_DD_IOS, else ios/build (gitignored).
#
# --verify-only builds and checks, and installs nothing.
#
# The app is NEVER launched on a phone: `devicectl device process launch`
# kills the running app and can cost its state (ios/AGENTS.md § Physical
# Device Caution). `devicectl device install app` replaces the binary and
# keeps the Keychain and app data.
#
# Exit: 0 when every listed device installed or was skipped as unreachable,
# 1 when the build check or any install failed, 3 when every device was
# skipped (nothing installed).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
IOS_DIR=$(dirname "$SCRIPT_DIR")
REPO=$(dirname "$IOS_DIR")
# shellcheck source-path=SCRIPTDIR source=native-install-lib.sh
. "$SCRIPT_DIR/native-install-lib.sh"

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

VERIFY_ONLY=0
DEVICES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "install-iphone.sh: unknown option $1" >&2
      usage >&2
      exit 64
      ;;
    *)
      # A UDID is hex and dashes; anything else is a typo (or a device name,
      # which devicectl would accept but this script does not).
      case "$1" in
        *[!0-9A-Fa-f-]*)
          echo "install-iphone.sh: '$1' is not a device UDID (see: xcrun devicectl list devices)" >&2
          exit 64
          ;;
      esac
      DEVICES+=("$1")
      ;;
  esac
  shift
done

if [ "$VERIFY_ONLY" = 0 ] && [ "${#DEVICES[@]}" -eq 0 ]; then
  echo "install-iphone.sh: name at least one device UDID, or pass --verify-only" >&2
  echo >&2
  usage >&2
  exit 64
fi

DD="${OPENTASK_DD_IOS:-$IOS_DIR/build}"
APP="$DD/Build/Products/Release-iphoneos/OpenTask.app"
WATCH_APP="$APP/Watch/OpenTaskWatch.app"
COMMIT=$(commit_of "$REPO")

echo "== OpenTask iPhone install: commit $COMMIT"
echo "   derived data: $DD"
[ "$VERIFY_ONLY" = 1 ] && echo "   --verify-only: nothing will be installed"

cd "$IOS_DIR"

# project.yml is canonical and includes the watch targets (needs the watchOS
# SDK). Regenerating keeps the project in step with the spec.
echo "== xcodegen generate"
xcodegen generate --quiet

echo "== xcodebuild Release (generic iOS device; builds the embedded watch app too)"
mkdir -p "$DD"
BUILD_LOG="$DD/install-iphone-build.log"
if ! xcodebuild -project OpenTask.xcodeproj -scheme OpenTask \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$DD" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  build >"$BUILD_LOG" 2>&1; then
  { grep -E "error:" "$BUILD_LOG" || true; } | sort -u | tail -30 >&2
  loud "xcodebuild failed; nothing was installed. Full log: $BUILD_LOG"
  exit 1
fi
build_summary "$BUILD_LOG"

echo "== Checking the build's signed entitlements"
CHECK_FAILURES=0
check_aps "OpenTask.app" "$APP"
check_aps "OpenTaskWidgets.appex" "$APP/PlugIns/OpenTaskWidgets.appex"
check_aps "OpenTaskWatch.app" "$WATCH_APP"
check_aps "OpenTaskWatchWidgets.appex" "$WATCH_APP/PlugIns/OpenTaskWatchWidgets.appex"
# The notification CONTENT extension draws a notification the app already
# received; it never registers for push, so it has no aps-environment and
# its App ID has no Push capability (ios/project.yml). What it needs is its
# signature and the App Group it reads the server URL and token from.
check_signed_group "OpenTaskNotification.appex" "$APP/PlugIns/OpenTaskNotification.appex"

if [ "$CHECK_FAILURES" -gt 0 ]; then
  loud "THE iPHONE BUILD CANNOT RECEIVE PUSH: $CHECK_FAILURES bundle(s) failed the check above." \
    "Nothing was installed." \
    "Build: $APP"
  exit 1
fi
echo "   all bundles signed for push"

if [ "$VERIFY_ONLY" = 1 ]; then
  echo
  echo "== Verified (nothing installed): commit $COMMIT"
  echo "   push: $(signed_aps "$APP")"
  exit 0
fi

# One line per device for the summary at the end.
RESULTS=()
INSTALLED=0
FAILED=0
SKIPPED=0

for udid in ${DEVICES[@]+"${DEVICES[@]}"}; do
  echo "== Device $udid"
  state=$(xcrun devicectl list devices --hide-default-columns --columns State --hide-headers \
    --filter "Identifier == '$udid'" 2>/dev/null | sed -e 's/[[:space:]]*$//' | sed -n 1p || true)
  case "$state" in
    available* | connected) ;;
    "" | "No matching devices found.")
      echo "   skipped: devicectl does not know this device"
      RESULTS+=("$udid  commit $COMMIT  SKIPPED (not known to devicectl)")
      SKIPPED=$((SKIPPED + 1))
      continue
      ;;
    *)
      echo "   skipped: $state (unlock it, or bring it onto the same network)"
      RESULTS+=("$udid  commit $COMMIT  SKIPPED ($state)")
      SKIPPED=$((SKIPPED + 1))
      continue
      ;;
  esac
  echo "   $state; installing"
  log="$DD/install-iphone-$udid.log"
  if xcrun devicectl device install app --device "$udid" "$APP" >"$log" 2>&1; then
    echo "   installed OK"
    RESULTS+=("$udid  commit $COMMIT  $state  installed OK")
    INSTALLED=$((INSTALLED + 1))
  else
    echo "   INSTALL FAILED; devicectl said:"
    sed 's/^/     /' "$log" | tail -15
    RESULTS+=("$udid  commit $COMMIT  $state  INSTALL FAILED (log: $log)")
    FAILED=$((FAILED + 1))
  fi
done

echo
echo "== Summary (push: $(signed_aps "$APP"); the app was not launched)"
for line in ${RESULTS[@]+"${RESULTS[@]}"}; do
  echo "   $line"
done

if [ "$FAILED" -gt 0 ]; then
  loud "$FAILED device install(s) failed; see above."
  exit 1
fi
if [ "$INSTALLED" -eq 0 ]; then
  echo "   nothing installed: every device was skipped" >&2
  exit 3
fi
