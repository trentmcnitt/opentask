/**
 * WidgetKit push sync — decides WHEN to call sendApnsWidgetReload()
 *
 * A home/lock screen widget (iOS 26 / macOS 26 / watchOS 26, via Apple's
 * WidgetPushHandler — see docs/NOTIFICATIONS.md) normally refreshes on a
 * ~30 min timeline. This module closes that gap: it subscribes to the same
 * `emitSyncEvent` signal that tells open browser tabs to refresh
 * (`@/lib/sync-events`) and sends each registered widget push token a
 * WidgetKit "reload your timelines" push.
 *
 * WHY IT COALESCES SO HARD (2026-09-25). Apple budgets widget pushes per
 * device, with an undisclosed daily allowance, and drops them silently once
 * it is spent. The first version debounced 2s per user, which only merged a
 * bulk action's burst of events. A person working down a list on the web
 * (edits 3–15s apart) still produced one push per edit: prod logged 46 pushes
 * between 07:05 and 13:35 on 2026-09-25, 11 of them in one minute, and
 * Trent's iPhone reported its widget push budget at −17. Over budget, the
 * pushes that matter (a change made on another device while the phone sits
 * on the home screen) never arrive.
 *
 * THE POLICY, per widget push token (each token is one device's widget
 * extension, with its own budget):
 *
 * 1. Prompt first push. A change after a quiet spell goes out after a 2s
 *    settle (`WIDGET_PUSH_SETTLE_MS`), which still merges a bulk action's
 *    many sync events into one push.
 * 2. Minimum interval with a guaranteed trailing push. After a push, that
 *    token gets no other push for `minIntervalMs` (default 5 min,
 *    `OPENTASK_WIDGET_PUSH_MIN_INTERVAL_SECONDS`). Changes inside the window
 *    are not dropped: they collapse into ONE push at the window's end, so the
 *    widget always ends up showing the final state. Worst-case lag for a
 *    cross-device change is the window, against the widget's own 30 min
 *    timeline. Replaying the 2026-09-25 morning through this policy: 46 → 16
 *    pushes (a 3 min window gives 18, 10 min gives 14 — past 5 min the cut
 *    flattens while the lag keeps growing).
 * 3. Quiet hours. A push that would land between the user's `sleep_time` and
 *    `wake_time` (their timezone) is held until `wake_time` instead, and
 *    everything that changed overnight rides that one push. Nobody is looking
 *    at the widget, and its own timeline still refreshes it. Tradeoff: an
 *    edit made on the Mac at 23:00 doesn't reach the phone's widget by push
 *    until morning (the widget's timeline or opening the app still refresh it).
 *    `OPENTASK_WIDGET_PUSH_QUIET_HOURS=false` turns this off.
 * 4. Only widget-visible changes. An emit marked `{ widgets: false }` (a
 *    notes-only edit, an `ai-*` label shuffle — see `SyncEventInfo`) pushes
 *    nothing.
 *
 * macOS is exempt from 2 and 3: chronod logs a Mac widget push as "free"
 * (`push … free`, ios/CLAUDE.md § Widgets "Budget"), so a Mac token keeps the
 * settle-only behavior and stays instantly in sync. iOS and watchOS are
 * budgeted and get the full policy.
 *
 * NOT DONE: skipping the push to the device that made the change. Nothing in
 * a request identifies which device (or widget extension) sent it: the apps
 * and widgets share one Keychain Bearer token, send no client header, and
 * `widget_push_tokens` has no link to `api_tokens`. It would not have helped
 * the 2026-09-25 bursts anyway — those were web `[session]` edits.
 *
 * Never sent for the demo user — its data resets every 4 hours via cron and
 * nobody has a demo widget on a home screen to reload.
 */

import { DateTime, IANAZone } from 'luxon'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { onSyncEvent, type SyncEventInfo } from '@/lib/sync-events'
import { parseHHMM } from '@/lib/time-slot-assign'
import { isAwake } from './slot-nags'
import { sendApnsWidgetReload } from './apns'

/** Settle delay before the first push after a quiet spell (merges a bulk action's events). */
export const WIDGET_PUSH_SETTLE_MS = 2000

/** Default minimum interval between two pushes to one budgeted token. */
export const DEFAULT_WIDGET_PUSH_MIN_INTERVAL_SECONDS = 300

/**
 * Parse `OPENTASK_WIDGET_PUSH_MIN_INTERVAL_SECONDS`. Unset → the default;
 * `0` → no minimum interval (settle-only, the pre-2026-09-25 behavior, handy
 * on a dev server where you want every change pushed); anything that isn't a
 * non-negative number → the default, with a warning.
 */
export function parseMinIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WIDGET_PUSH_MIN_INTERVAL_SECONDS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    log.warn(
      'apns',
      `Ignoring invalid OPENTASK_WIDGET_PUSH_MIN_INTERVAL_SECONDS=${raw}; using ${DEFAULT_WIDGET_PUSH_MIN_INTERVAL_SECONDS}`,
    )
    return DEFAULT_WIDGET_PUSH_MIN_INTERVAL_SECONDS
  }
  return value
}

/** `OPENTASK_WIDGET_PUSH_QUIET_HOURS` — on unless explicitly `false`/`0`/`off`. */
export function parseQuietHoursEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true
  return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase())
}

export interface WidgetPushCoalescerOptions<Key> {
  /** Delay before the first push after a quiet spell. */
  settleMs: number
  /** Minimum gap between two flushes of the same key (0 = none). */
  minIntervalMs: (key: Key) => number
  /**
   * If `now` falls inside quiet hours for this key, the epoch ms to hold the
   * flush until; otherwise null. Asked at flush time, not schedule time.
   */
  deferUntil?: (key: Key, now: number) => number | null
  flush: (key: Key) => void
}

/**
 * The per-key pacing described in the module doc, as a plain factory (no DB
 * or network inside) so it can be tested with fake timers — see
 * tests/behavioral/widget-push.test.ts.
 *
 * Each key has at most one pending timer. `schedule()` while one is pending
 * does nothing: the pending flush hasn't happened yet, so it already carries
 * this change (the widget fetches fresh data when it reloads). With no timer
 * pending, the flush is set for whichever is later: `now + settleMs`, or the
 * last flush + the key's minimum interval.
 */
export function createWidgetPushCoalescer<Key>(options: WidgetPushCoalescerOptions<Key>) {
  const { settleMs, minIntervalMs, deferUntil, flush } = options
  const timers = new Map<Key, NodeJS.Timeout>()
  const lastFlushAt = new Map<Key, number>()

  function arm(key: Key, delayMs: number): void {
    const timer = setTimeout(() => fire(key), Math.max(0, delayMs))
    // A pending widget push should never keep the process alive on its own
    // (matters for graceful shutdown and for the test suite's process exit).
    timer.unref()
    timers.set(key, timer)
  }

  function fire(key: Key): void {
    timers.delete(key)
    const now = Date.now()
    const holdUntil = deferUntil?.(key, now) ?? null
    if (holdUntil !== null && holdUntil > now) {
      arm(key, holdUntil - now)
      return
    }
    lastFlushAt.set(key, now)
    flush(key)
  }

  return {
    schedule(key: Key): void {
      if (timers.has(key)) return
      const now = Date.now()
      const last = lastFlushAt.get(key)
      const windowEnd = last === undefined ? now : last + minIntervalMs(key)
      arm(key, Math.max(now + settleMs, windowEnd) - now)
    },
    /** Number of keys with a pending, not-yet-flushed timer. Test-only introspection. */
    pendingCount(): number {
      return timers.size
    },
  }
}

/**
 * When the user's quiet hours end, if `now` is inside them; otherwise null.
 *
 * Quiet hours are the complement of `isAwake` (slot-nags.ts) — the same
 * waking window the hourly nag uses, including its wrap-past-midnight rule and
 * "wake == sleep means awake all day". Unlike the nag, a malformed time or
 * timezone here means NO quiet hours: failing open costs a push, failing
 * closed would leave a widget stale all night.
 */
export function quietHoursEnd(
  now: Date,
  timezone: string,
  wakeTime: string,
  sleepTime: string,
): number | null {
  const wake = parseHHMM(wakeTime)
  if (wake === null || parseHHMM(sleepTime) === null) return null
  // Checked up front: the app sets luxon to throw on an invalid zone.
  if (!IANAZone.isValidZone(timezone)) return null

  const local = DateTime.fromJSDate(now).setZone(timezone)

  const minuteOfDay = local.hour * 60 + local.minute
  if (isAwake(minuteOfDay, wakeTime, sleepTime)) return null

  // Wall-clock set, not startOf('day') + minutes: on a DST-change day the
  // duration add would land an hour off wake_time.
  const wakeClock = { hour: Math.floor(wake / 60), minute: wake % 60, second: 0, millisecond: 0 }
  let wakeAt = local.set(wakeClock)
  if (wakeAt <= local) wakeAt = local.plus({ days: 1 }).set(wakeClock)
  return wakeAt.toMillis()
}

export interface WidgetPushTarget {
  id: number
  user_id: number
  platform: string
}

/**
 * The widget push tokens a sync event for `userId` should push to: all of the
 * user's tokens, or none for the demo user or a `{ widgets: false }` event.
 */
export function widgetPushTargets(userId: number, info: SyncEventInfo = {}): WidgetPushTarget[] {
  if (info.widgets === false) return []
  return getDb()
    .prepare(
      `SELECT t.id, t.user_id, t.platform
         FROM widget_push_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.user_id = ? AND u.is_demo = 0`,
    )
    .all(userId) as WidgetPushTarget[]
}

/** True for platforms whose widget pushes Apple budgets (everything but macOS — see module doc). */
export function isBudgetedPlatform(platform: string): boolean {
  return platform !== 'macos'
}

const MIN_INTERVAL_MS =
  parseMinIntervalSeconds(process.env.OPENTASK_WIDGET_PUSH_MIN_INTERVAL_SECONDS) * 1000
const QUIET_HOURS_ENABLED = parseQuietHoursEnabled(process.env.OPENTASK_WIDGET_PUSH_QUIET_HOURS)

/** Token id → what the pacing needs to know about it (refreshed on every schedule). */
const targets = new Map<number, WidgetPushTarget>()

function userQuietHoursEnd(userId: number, now: number): number | null {
  const user = getDb()
    .prepare('SELECT timezone, wake_time, sleep_time FROM users WHERE id = ?')
    .get(userId) as { timezone: string; wake_time: string; sleep_time: string } | undefined
  if (!user) return null
  return quietHoursEnd(new Date(now), user.timezone, user.wake_time, user.sleep_time)
}

const coalescer = createWidgetPushCoalescer<number>({
  settleMs: WIDGET_PUSH_SETTLE_MS,
  minIntervalMs: (tokenId) => {
    const target = targets.get(tokenId)
    return target && isBudgetedPlatform(target.platform) ? MIN_INTERVAL_MS : 0
  },
  deferUntil: (tokenId, now) => {
    const target = targets.get(tokenId)
    if (!QUIET_HOURS_ENABLED || !target || !isBudgetedPlatform(target.platform)) return null
    return userQuietHoursEnd(target.user_id, now)
  },
  flush: (tokenId) => {
    sendApnsWidgetReload(tokenId).catch((err) => {
      log.error('apns', `Widget push send failed for token ${tokenId}:`, err)
    })
  },
})

/**
 * Register the sync-event listener that drives widget push sends. Called
 * once at server startup (see src/instrumentation.ts) — NOT per-request, or
 * every request would add another `onSyncEvent` listener.
 */
export function initWidgetPushSync(): void {
  onSyncEvent((userId, info) => {
    // Runs synchronously inside the mutation's emitSyncEvent call: a DB hiccup
    // here must not fail the user's edit, only skip this push.
    try {
      for (const target of widgetPushTargets(userId, info)) {
        targets.set(target.id, target)
        coalescer.schedule(target.id)
      }
    } catch (err) {
      log.error('apns', `Widget push scheduling failed for user ${userId}:`, err)
    }
  })
  log.info(
    'apns',
    `Widget push sync listener registered (${WIDGET_PUSH_SETTLE_MS}ms settle, ` +
      `${MIN_INTERVAL_MS / 1000}s min interval for iOS/watchOS, ` +
      `quiet hours ${QUIET_HOURS_ENABLED ? 'on' : 'off'})`,
  )
}
