/**
 * Node preload for the screenshot pipeline (docs/SCREENSHOTS.md): shifts the
 * process clock so "now" starts at OPENTASK_SCREENSHOT_NOW.
 *
 *   NODE_OPTIONS="--require ./scripts/screenshots/freeze-clock.cjs" \
 *     OPENTASK_SCREENSHOT_NOW=2026-09-15T09:41:00-05:00 npx next start
 *
 * INERT unless OPENTASK_SCREENSHOT_NOW is set: without it this file returns
 * before touching anything. No application code reads it — it is loaded only
 * by scripts/screenshots/run.sh (for the seed and for `next start`).
 *
 * Shifted, not frozen: Date.now() = real now + a fixed offset, so time still
 * moves. node-cron and the notification guard in src/instrumentation.ts
 * measure elapsed time with Date.now(); a clock that never moves would stall
 * them. A run takes a few minutes, which shows nowhere on screen — the
 * BROWSER's clock is fixed exactly by Playwright (`page.clock.setFixedTime`).
 *
 * Why the chosen "now" must be in the PAST: SQLite's own datetime('now') is
 * the real clock and can't be patched. `src/core/tasks/currently-due.ts`
 * prefilters with it and then filters in JS with this clock — correct as long
 * as real time is later than the shifted time (the prefilter is a superset).
 *
 * The AI guard lives in run.sh, not here: it sets a dummy OPENAI_API_KEY with
 * a dead loopback OPENAI_BASE_URL (so the server reports AI available and no
 * request can leave the machine) and OPENTASK_AI_CLI_PATH to a path that does
 * not exist (so the SDK warm slot src/instrumentation.ts starts can't spawn
 * Claude Code). The SDK is bundled by Next, so a require hook here couldn't
 * block it.
 */
'use strict'

const target = process.env.OPENTASK_SCREENSHOT_NOW
if (target) {
  const targetMs = Date.parse(target)
  if (Number.isNaN(targetMs)) {
    throw new Error(`OPENTASK_SCREENSHOT_NOW is not a date: ${target}`)
  }
  const RealDate = Date
  const offset = targetMs - RealDate.now()
  const shiftedNow = () => RealDate.now() + offset

  globalThis.Date = new Proxy(RealDate, {
    construct(Target, args, newTarget) {
      return Reflect.construct(Target, args.length === 0 ? [shiftedNow()] : args, newTarget)
    },
    apply() {
      // `Date()` called without `new` returns now as a string.
      return new RealDate(shiftedNow()).toString()
    },
    get(Target, prop, receiver) {
      if (prop === 'now') return shiftedNow
      return Reflect.get(Target, prop, receiver)
    },
  })
}
