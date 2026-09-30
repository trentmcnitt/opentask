#!/usr/bin/env bash
# One command for every product screenshot (docs/SCREENSHOTS.md):
#
#   npm run screenshots                  # everything → .tmp/screenshots/<date>/
#   npm run screenshots -- <out dir>     # somewhere else
#
# Builds the app, seeds a throwaway sample account on a frozen clock, starts
# the server on it, captures the web shots (Playwright/WebKit), dumps the
# account's API responses and renders the native widget / menu bar shots
# from them, captures the Apple Watch app in a watchOS simulator, then writes
# manifest.json + README.md. The server it starts is stopped on every exit
# path.
#
# Environment (all optional):
#   OPENTASK_SCREENSHOT_NOW   the frozen "now" (default 2026-09-15T09:41:00-05:00,
#                             a Tuesday morning; must stay in the past — see
#                             freeze-clock.cjs)
#   SCREENSHOTS_PORT          server port (default 3353)
#   SCREENSHOTS_SKIP_BUILD=1  reuse the existing .next build
#   SCREENSHOTS_SKIP_NATIVE=1 web only (no Xcode needed)
#   SCREENSHOTS_SKIP_WATCH=1  no Apple Watch shots (skips the watchOS simulator)
#   SCREENSHOTS_KEEP_DERIVED_DATA=1  keep /tmp/dd-shots-* for a faster rerun
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export OPENTASK_SCREENSHOT_NOW="${OPENTASK_SCREENSHOT_NOW:-2026-09-15T09:41:00-05:00}"
export TZ="America/Chicago"
PORT="${SCREENSHOTS_PORT:-3353}"
BASE_URL="http://localhost:$PORT"
OUT="${1:-.tmp/screenshots/$(date +%Y-%m-%d)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# Clear only this pipeline's own outputs — the directory may be one the user
# pointed at, with other things in it.
rm -rf "$OUT"/web "$OUT"/native "$OUT"/widget-data "$OUT"/manifest.parts \
  "$OUT"/portfolio "$OUT"/screenshots.db* "$OUT"/build.log "$OUT"/server.log "$OUT"/manifest.json "$OUT"/README.md
PRELOAD="--require $ROOT/scripts/screenshots/freeze-clock.cjs"
# The sample account's API token (scripts/screenshots/account.ts).
TOKEN="screenshots-sample-token-00000000000000000000000000000000000000"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use — stop that server or set SCREENSHOTS_PORT." >&2
  exit 1
fi

if [ "${SCREENSHOTS_SKIP_BUILD:-0}" != "1" ]; then
  # A fixed build stamp: the sidebar prints "v<version> · <build date>".
  echo "build: next build (stamp 20260914-1730)"
  NEXT_PUBLIC_BUILD_ID=20260914-1730 npx next build >"$OUT/build.log" 2>&1 ||
    { tail -30 "$OUT/build.log" >&2; exit 1; }
fi

echo "seed: sample account at $OPENTASK_SCREENSHOT_NOW"
OPENTASK_DB_PATH="$OUT/screenshots.db" NODE_OPTIONS="$PRELOAD" \
  npx tsx scripts/screenshots/seed.ts

echo "server: next start on $BASE_URL"
# AI on, but nothing can leave the machine: the API provider is a dead
# loopback address, and the Claude Code path doesn't exist (so the SDK warm
# slot src/instrumentation.ts starts fails fast instead of spawning it).
OPENTASK_DB_PATH="$OUT/screenshots.db" \
  NODE_OPTIONS="$PRELOAD" \
  AUTH_SECRET="screenshots-only-secret" \
  AUTH_TRUST_HOST=true \
  OPENTASK_AI_ENABLED=true \
  OPENTASK_AI_PROVIDER=openai \
  OPENAI_API_KEY=sk-screenshots-offline \
  OPENAI_BASE_URL=http://127.0.0.1:9/v1 \
  OPENTASK_AI_CLI_PATH=/nonexistent/claude-code \
  LOG_LEVEL=info \
  npx next start -p "$PORT" >"$OUT/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$BASE_URL/login" && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -30 "$OUT/server.log" >&2; exit 1; }
  sleep 1
done
curl -sf -o /dev/null "$BASE_URL/login" || { echo "server never came up" >&2; exit 1; }

echo "web: capturing"
SCREENSHOTS_BASE_URL="$BASE_URL" SCREENSHOTS_OUT="$OUT" npx tsx scripts/screenshots/capture-web.ts

echo "data: dumping the sample account for the native renders"
OPENTASK_URL="$BASE_URL" OPENTASK_TOKEN="$TOKEN" \
  npx tsx scripts/dump-preview-data.ts --out "$OUT/widget-data" >/dev/null
DAY_START="$(node -e "const {DateTime}=require('luxon');const d=DateTime.fromISO(process.argv[1],{setZone:true}).setZone('America/Chicago').startOf('day');console.log(d.toUTC().toISO()+' '+d.plus({days:1}).toUTC().toISO())" "$OPENTASK_SCREENSHOT_NOW")"
SINCE="${DAY_START% *}"
UNTIL="${DAY_START#* }"
curl -sf -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/completions?since=$SINCE&until=$UNTIL" >"$OUT/widget-data/completions.json"

# The watch app reads the server live (unlike the widget renders, which use
# the dump above), so it runs before the server stops.
if [ "${SCREENSHOTS_SKIP_NATIVE:-0}" != "1" ] && [ "${SCREENSHOTS_SKIP_WATCH:-0}" != "1" ]; then
  scripts/screenshots/capture-watch-app.sh "$OUT" "$BASE_URL" "$TOKEN"
fi

cleanup
SERVER_PID=""

if [ "${SCREENSHOTS_SKIP_NATIVE:-0}" != "1" ]; then
  scripts/screenshots/capture-native.sh "$OUT"
fi

npx tsx scripts/screenshots/finalize.ts "$OUT"
