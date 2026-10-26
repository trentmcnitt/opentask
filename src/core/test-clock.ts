/**
 * TEST-ONLY SERVER CLOCK (2026-10-26; POST /api/test/clock, which answers 404
 * unless OPENTASK_TEST_MODE=1). Never used in production code paths: nothing
 * outside that route calls it.
 *
 * WHY. Playwright's `page.clock` moves only the browser; the server reads the
 * real time. A spec that must run at a given hour — the late night between
 * midnight and the 3:00 AM day start, when the OpenTask day is still
 * yesterday's (docs/TASK-MODEL.md § The OpenTask day) — would otherwise only
 * run there when CI happens to start at that hour.
 *
 * HOW: OFFSET-BASED. `setTestClock(instant)` replaces the process's global
 * `Date` with a subclass whose `Date.now()` and zero-argument `new Date()` are
 * the real clock plus a fixed offset (`instant` − real now at the call). The
 * clock keeps running at the real rate from the pinned instant; nothing is
 * frozen, and timers (`setTimeout`, the cron scheduler) are untouched. Luxon's
 * `DateTime.now()` reads `Date.now()`, so it follows. `new Date(x)` with an
 * argument is unchanged, and `instanceof Date` still holds for dates made
 * before the swap (`Symbol.hasInstance`). `setTestClock(null)` puts the real
 * `Date` back. Every request in the process sees the same clock, so a spec
 * that pins it must run alone (E2E runs one test at a time) and reset it.
 *
 * KNOWN GAPS:
 * - SQL defaults (`strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` in schema.sql and a
 *   few queries) read SQLite's own clock, the REAL time: a row stamped that
 *   way is off by the offset. Assert on nothing such a stamp feeds.
 * - The cron jobs (src/instrumentation.ts) keep firing on real-time timers but
 *   compute on the shifted clock, for every user — notifications, the quota
 *   period rollover, the task rollover. Pin to an instant at or before real
 *   now and stamp the task rollover first (the E2E spec does, see
 *   tests/e2e/tq-late-night.spec.ts), so a shifted run never rolls a day.
 * - `Date()` called as a function (no `new`) throws on the subclass; nothing
 *   in src/ does that.
 * - Only this process: the browser keeps its own clock (pin it with
 *   `page.clock`), and an edge-runtime proxy, if one is ever added, has its own.
 */

let realDate: DateConstructor | null = null

/**
 * Pin the server's clock to `instant` (it runs on from there), or put the real
 * clock back with `null`. Re-pinning replaces the previous offset.
 */
export function setTestClock(instant: Date | null): void {
  if (realDate) {
    globalThis.Date = realDate
    realDate = null
  }
  if (instant === null) return
  const Real = globalThis.Date
  const offset = instant.getTime() - Real.now()
  class ShiftedDate extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(Real.now() + offset)
      else super(...(args as [string | number | Date]))
    }
    static now(): number {
      return Real.now() + offset
    }
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof Real
    }
  }
  realDate = Real
  globalThis.Date = ShiftedDate as DateConstructor
}

/** The pinned clock's offset from real time in ms (0 when not pinned). */
export function testClockOffsetMs(): number {
  return realDate ? Date.now() - realDate.now() : 0
}
