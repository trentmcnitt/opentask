#!/bin/bash
# Build the Mac app in Release WITH the push entitlements, install it to
# ~/Applications/OpenTask.app, and prove the installed copy can get push.
#
# Usage:
#   macos/scripts/install-mac.sh [<derived-data-path>]
#   macos/scripts/install-mac.sh --no-push [<derived-data-path>]   # debug: see below
#
# Derived data: the argument, else $OPENTASK_DD_MAC, else macos/build (the
# README's path, gitignored). Builders that share one derived-data dir across
# worktrees set OPENTASK_DD_MAC to it.
#
# Why (2026-10-26): Mac Release builds installed without
# CODE_SIGN_ENTITLEMENTS=OpenTaskMac/OpenTaskMac-Push.entitlements got no push
# at all, silently, for hours. The default OpenTaskMac.entitlements (the one
# XcodeGen writes) deliberately lacks aps-environment (see macos/project.yml).
# So this script always builds with the Push file, and checks the SIGNED
# entitlements twice: on the build product before anything is replaced (a bad
# build never overwrites a working install), and on the installed copy after.
#
# A command-line build setting is scheme-wide, so the override is a REFERENCE,
# CODE_SIGN_ENTITLEMENTS='$(OPENTASK_PUSH_ENTITLEMENTS)', that each target
# resolves to its own file (macos/project.yml, 2026-11-09): the app to its
# Push file, the widgets and the notification service extension to theirs.
# Until then a plain path signed every target with the app's file, which was
# safe only while the widgets' file matched it (the script compared the two).
#
# --no-push builds WITHOUT the override, into "<derived-data>-nopush", and
# runs the same check on it. It exists to show the check failing; it never
# installs anything, whatever the check says.
#
# Steps: build -> check product -> quit the running app -> replace
# ~/Applications/OpenTask.app -> LaunchServices + pluginkit (the extension
# re-registers DISABLED after a reinstall) -> restart chronod,
# NotificationCenter, usernoted -> relaunch -> check the installed copy.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MACOS_DIR=$(dirname "$SCRIPT_DIR")
REPO=$(dirname "$MACOS_DIR")
# shellcheck source-path=SCRIPTDIR source=../../ios/scripts/native-install-lib.sh
. "$REPO/ios/scripts/native-install-lib.sh"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

NO_PUSH=0
DD_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-push) NO_PUSH=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "install-mac.sh: unknown option $1" >&2
      usage >&2
      exit 64
      ;;
    *)
      if [ -n "$DD_ARG" ]; then
        echo "install-mac.sh: one derived-data path only" >&2
        exit 64
      fi
      DD_ARG="$1"
      ;;
  esac
  shift
done

DD="${DD_ARG:-${OPENTASK_DD_MAC:-$MACOS_DIR/build}}"
[ "$NO_PUSH" = 1 ] && DD="$DD-nopush"
PRODUCT="$DD/Build/Products/Release/OpenTask.app"
INSTALLED="$HOME/Applications/OpenTask.app"
APP_EXE="$INSTALLED/Contents/MacOS/OpenTask"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
PUSH_ENTITLEMENTS=OpenTaskMac/OpenTaskMac-Push.entitlements
COMMIT=$(commit_of "$REPO")

# check_service_ext <app>: the notification service extension (the push
# kinds' icons, 2026-11-07) must be there, signed, sandboxed and signed with
# its OWN file — no push entitlement, which only the scheme-wide override of
# old would have given it — and the app must carry the communication
# entitlement the extension's avatars need.
check_service_ext() {
  local app="$1" ext="$1/Contents/PlugIns/OpenTaskMacNotificationService.appex" ents
  if [ ! -d "$ext" ]; then
    echo "  MISSING  OpenTaskMacNotificationService.appex: $ext"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
    return 0
  fi
  if ! codesign --verify --strict "$ext" 2>/dev/null; then
    echo "  BAD SIG  OpenTaskMacNotificationService.appex: codesign --verify failed"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
    return 0
  fi
  ents=$(codesign -d --entitlements - --xml "$ext" 2>/dev/null || true)
  case "$ents" in
    *aps-environment*)
      echo "  WRONG    OpenTaskMacNotificationService.appex: signed with the app's push file"
      CHECK_FAILURES=$((CHECK_FAILURES + 1))
      return 0
      ;;
    *app-sandbox*) ;;
    *)
      echo "  NO SANDBOX OpenTaskMacNotificationService.appex: macOS will not load it"
      CHECK_FAILURES=$((CHECK_FAILURES + 1))
      return 0
      ;;
  esac
  case "$(codesign -d --entitlements - --xml "$app" 2>/dev/null || true)" in
    *usernotifications.communication*)
      echo "  ok       OpenTaskMacNotificationService.appex: signed, sandboxed; the app has communication notifications"
      ;;
    *)
      echo "  NO COMM  OpenTask.app: no communication-notifications entitlement (the icons will not show)"
      CHECK_FAILURES=$((CHECK_FAILURES + 1))
      ;;
  esac
}

echo "== OpenTask Mac install: commit $COMMIT"
echo "   derived data: $DD"
[ "$NO_PUSH" = 1 ] && echo "   --no-push: building WITHOUT the push entitlements; nothing will be installed"

cd "$MACOS_DIR"


echo "== xcodegen generate"
xcodegen generate --quiet

# --no-push leaves the override out: the build then signs the app with the
# default OpenTaskMac.entitlements, exactly as the 10-26 builds did.
OVERRIDE=()
if [ "$NO_PUSH" = 0 ]; then
  # Escaped, not expanded: xcodebuild resolves the reference per target (see top).
  OVERRIDE=("CODE_SIGN_ENTITLEMENTS=\$(OPENTASK_PUSH_ENTITLEMENTS)")
fi

echo "== xcodebuild Release ${OVERRIDE[*]+"${OVERRIDE[*]}"}"
mkdir -p "$DD"
BUILD_LOG="$DD/install-mac-build.log"
if ! xcodebuild -project OpenTaskMac.xcodeproj -scheme OpenTaskMac \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath "$DD" -allowProvisioningUpdates \
  ${OVERRIDE[@]+"${OVERRIDE[@]}"} build >"$BUILD_LOG" 2>&1; then
  { grep -E "error:" "$BUILD_LOG" || true; } | sort -u | tail -30 >&2
  loud "xcodebuild failed; nothing was installed. Full log: $BUILD_LOG"
  exit 1
fi
build_summary "$BUILD_LOG"

APPEX_NAME=OpenTaskMacWidgets.appex
APP_ID=$(plutil -extract CFBundleIdentifier raw "$PRODUCT/Contents/Info.plist")
WIDGET_ID=$(plutil -extract CFBundleIdentifier raw "$PRODUCT/Contents/PlugIns/$APPEX_NAME/Contents/Info.plist")

echo "== Checking the build product's signed entitlements"
CHECK_FAILURES=0
check_aps "OpenTask.app ($APP_ID)" "$PRODUCT"
check_aps "$APPEX_NAME ($WIDGET_ID)" "$PRODUCT/Contents/PlugIns/$APPEX_NAME"
check_service_ext "$PRODUCT"

if [ "$CHECK_FAILURES" -gt 0 ] || [ "$NO_PUSH" = 1 ]; then
  # Every xcodebuild registers its product with LaunchServices; a stray claim
  # for this bundle id keeps the widgets out of the gallery.
  "$LSREGISTER" -u "$PRODUCT" 2>/dev/null || true
fi
if [ "$CHECK_FAILURES" -gt 0 ]; then
  loud "THE MAC BUILD CANNOT RECEIVE PUSH: $CHECK_FAILURES bundle(s) failed the check above." \
    "Nothing was installed; ~/Applications/OpenTask.app is untouched." \
    "Build: $PRODUCT" \
    "Builds must be signed with $PUSH_ENTITLEMENTS (CODE_SIGN_ENTITLEMENTS='\$(OPENTASK_PUSH_ENTITLEMENTS)')."
  exit 1
fi
if [ "$NO_PUSH" = 1 ]; then
  echo "== --no-push: the check passed on a build without the push file, which is itself a bug" >&2
  echo "   (nothing installed)" >&2
  exit 1
fi

running_pids() {
  pgrep -f "^$APP_EXE" || true
}

# wait_for_exit <tries>: polls every half second; returns 1 if still running.
wait_for_exit() {
  local i=0
  while [ -n "$(running_pids)" ]; do
    i=$((i + 1))
    [ "$i" -gt "$1" ] && return 1
    sleep 0.5
  done
  return 0
}

echo "== Quitting the running app ($APP_ID)"
# `is running` never launches the app; a bare `tell ... to quit` would.
if [ "$(osascript -e "application id \"$APP_ID\" is running" 2>/dev/null || echo false)" = true ]; then
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
fi
# The bundle id is shared with the iPhone app, and every Mac build registers
# another copy, so confirm by the installed path rather than trusting the id.
if ! wait_for_exit 20; then
  echo "   still running after quit; sending TERM to $(running_pids | tr '\n' ' ')"
  running_pids | xargs kill 2>/dev/null || true
  if ! wait_for_exit 20; then
    loud "OpenTask ($APP_EXE) would not quit. Nothing was replaced."
    exit 1
  fi
fi

echo "== Replacing $INSTALLED"
mkdir -p "$HOME/Applications"
rm -rf "$INSTALLED"
ditto "$PRODUCT" "$INSTALLED"

echo "== LaunchServices and pluginkit"
"$LSREGISTER" -u "$PRODUCT" 2>/dev/null || true
"$LSREGISTER" -f "$INSTALLED"
pluginkit -e use -i "$WIDGET_ID"
# chronod enumerates widgets, NotificationCenter hosts the gallery, and
# usernoted otherwise keeps routing notification actions to the old record
# (Done on a banner did nothing after a reinstall, 2026-09-24). launchd
# restarts all three.
killall chronod NotificationCenter usernoted 2>/dev/null || true

echo "== Launching"
open "$INSTALLED"
tries=0
while [ -z "$(running_pids)" ] && [ "$tries" -lt 20 ]; do
  tries=$((tries + 1))
  sleep 0.5
done
APP_PID=$(running_pids | tr '\n' ' ')

echo "== Checking the INSTALLED copy's signed entitlements"
CHECK_FAILURES=0
check_aps "OpenTask.app ($APP_ID)" "$INSTALLED"
check_aps "$APPEX_NAME ($WIDGET_ID)" "$INSTALLED/Contents/PlugIns/$APPEX_NAME"
check_service_ext "$INSTALLED"
if [ "$CHECK_FAILURES" -gt 0 ]; then
  loud "THE INSTALLED MAC APP CANNOT RECEIVE PUSH: $CHECK_FAILURES bundle(s) failed the check above." \
    "Installed: $INSTALLED (commit $COMMIT)" \
    "Rebuild with $PUSH_ENTITLEMENTS (this script does) and reinstall."
  exit 1
fi

WIDGET_STATE=$(pluginkit -m -v -i "$WIDGET_ID" 2>/dev/null | sed -n 1p)
case "$WIDGET_STATE" in
  +*) widget_line="enabled" ;;
  "") widget_line="NOT REGISTERED (pluginkit -m -v -i $WIDGET_ID shows nothing)" ;;
  *) widget_line="NOT ENABLED: $WIDGET_STATE" ;;
esac

echo
echo "== Installed OK"
echo "   commit:          $COMMIT"
echo "   app:             $INSTALLED ($APP_ID)"
echo "   running:         ${APP_PID:-NOT RUNNING (open it by hand)}"
echo "   push:            $(signed_aps "$INSTALLED")"
echo "   widgets:         $(signed_aps "$INSTALLED/Contents/PlugIns/$APPEX_NAME"), $widget_line"
