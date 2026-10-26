# shellcheck shell=bash
# Shared helpers for the native install scripts:
#   ios/scripts/install-iphone.sh
#   macos/scripts/install-mac.sh
#
# Sourced, not run. Safe under macOS's bash 3.2 and `set -euo pipefail`.
#
# Why this exists (2026-10-26): several Mac Release builds were installed
# without the push entitlements, so the installed app silently got NO push for
# hours. Nothing failed: Xcode signs whatever entitlements file it is given and
# the app only logs the APNs registration failure. The install scripts now
# refuse to install (or report a failed install) unless every bundle that
# needs `aps-environment` carries it in its SIGNED entitlements.

# The two spellings of the key: iOS and watchOS sign the bare
# `aps-environment`; a Mac provisioning profile only grants the prefixed
# `com.apple.developer.aps-environment` (see macos/project.yml). Read through
# `plutil -p`, never `plutil -extract`: -extract takes a dotted keypath, so it
# silently finds nothing for the prefixed Mac key.
#
# Prints `<key>=<value>` (e.g. `aps-environment=development`), or nothing.
signed_aps() {
  local ents
  ents=$(codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -p - 2>/dev/null || true)
  printf '%s\n' "$ents" \
    | sed -n -E 's/^ *"((com\.apple\.developer\.)?aps-environment)" => "([^"]*)".*/\1=\3/p' \
    | sed -n 1p
}

# Prints 1 when the signed entitlements hold an App Group, else nothing.
signed_app_group() {
  local ents
  ents=$(codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -p - 2>/dev/null || true)
  case "$ents" in
    *'"com.apple.security.application-groups"'*) echo 1 ;;
  esac
}

# A failure nobody can scroll past. Goes to stderr.
loud() {
  {
    echo
    echo '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    for line in "$@"; do echo "!!  $line"; done
    echo '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    echo
  } >&2
}

# CHECK_FAILURES counts what check_* found wrong; the caller decides when to
# stop. Each check prints one line per bundle.
CHECK_FAILURES=0

# check_aps <label> <bundle path>: the bundle exists, its signature verifies
# and its signed entitlements carry aps-environment (either spelling).
check_aps() {
  local label="$1" bundle="$2" aps
  if [ ! -d "$bundle" ]; then
    echo "  MISSING  $label: $bundle"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
    return 0
  fi
  if ! codesign --verify --strict "$bundle" 2>/dev/null; then
    echo "  BAD SIG  $label: codesign --verify failed ($bundle)"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
    return 0
  fi
  aps=$(signed_aps "$bundle")
  if [ -z "$aps" ]; then
    echo "  NO PUSH  $label: no aps-environment in its signed entitlements"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
  else
    echo "  ok       $label: $aps"
  fi
}

# check_signed_group <label> <bundle path>: for a bundle that has no use for
# push (the iPhone's notification content extension): it exists, its
# signature verifies and it carries its App Group.
check_signed_group() {
  local label="$1" bundle="$2"
  if [ ! -d "$bundle" ]; then
    echo "  MISSING  $label: $bundle"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
    return 0
  fi
  if ! codesign --verify --strict "$bundle" 2>/dev/null; then
    echo "  BAD SIG  $label: codesign --verify failed ($bundle)"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
    return 0
  fi
  if [ -z "$(signed_app_group "$bundle")" ]; then
    echo "  NO GROUP $label: no App Group in its signed entitlements"
    CHECK_FAILURES=$((CHECK_FAILURES + 1))
  else
    echo "  ok       $label: signed, App Group present (no push needed)"
  fi
}

# build_summary <xcodebuild log>: one line after a successful build. The full
# log stays on disk; xcodebuild's own output is thousands of lines.
build_summary() {
  local warnings
  warnings=$({ grep -E ': warning:' "$1" || true; } | sort -u | wc -l | tr -d ' ')
  echo "   BUILD SUCCEEDED ($warnings distinct warning lines; log: $1)"
}

# The commit being built, with +dirty when the tree has uncommitted changes.
commit_of() {
  local repo="$1" sha
  sha=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown)
  if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
    sha="$sha+dirty"
  fi
  echo "$sha"
}
