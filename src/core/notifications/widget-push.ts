/**
 * WidgetKit push sync — debounced trigger for sendApnsWidgetReload()
 *
 * A home/lock screen widget (iOS 26 / macOS 26, via Apple's WidgetPushHandler
 * — see docs/NOTIFICATIONS.md) normally refreshes on a ~30 min timeline. This
 * module closes that gap: it subscribes to the same `emitSyncEvent` signal
 * that already tells open browser tabs to refresh (`@/lib/sync-events`), and
 * sends a WidgetKit "reload your timelines" push shortly after.
 *
 * Debounced per user, trailing-edge, because `emitSyncEvent` fires once per
 * mutated task — a bulk action or a burst of taps must produce ONE push, not
 * one per task. This matters beyond politeness: Apple documents that
 * "the system budgets WidgetKit push notifications and delivers them
 * opportunistically," so a burst that spends five pushes on one bulk action
 * is five fewer pushes available for the rest of the day.
 *
 * Never sent for the demo user — its data resets every 4 hours via cron and
 * nobody has a demo widget on a home screen to reload.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { onSyncEvent } from '@/lib/sync-events'
import { sendApnsWidgetReload } from './apns'

/** Trailing-edge debounce window: one push per user per burst of mutations. */
export const WIDGET_PUSH_DEBOUNCE_MS = 2000

/**
 * A per-key trailing-edge debouncer: each `schedule(key)` call resets that
 * key's timer, so `flush` only runs once the calls for that key stop arriving
 * for `delayMs`. Kept as a plain factory (no DB/network inside) so the
 * coalescing behavior is testable without real APNs credentials — see
 * tests/behavioral/widget-push.test.ts.
 */
export function createTrailingDebouncer<Key>(flush: (key: Key) => void, delayMs: number) {
  const timers = new Map<Key, NodeJS.Timeout>()

  return {
    schedule(key: Key): void {
      const existing = timers.get(key)
      if (existing) clearTimeout(existing)

      const timer = setTimeout(() => {
        timers.delete(key)
        flush(key)
      }, delayMs)
      // A pending widget push should never keep the process alive on its own
      // (matters for graceful shutdown and for the test suite's process exit).
      timer.unref()

      timers.set(key, timer)
    },
    /** Number of keys with a pending, not-yet-flushed timer. Test-only introspection. */
    pendingCount(): number {
      return timers.size
    },
  }
}

/** True if the user is the public demo account — see module doc comment. */
export function isDemoUser(userId: number): boolean {
  const row = getDb().prepare('SELECT is_demo FROM users WHERE id = ?').get(userId) as
    | { is_demo: number }
    | undefined
  return row?.is_demo === 1
}

async function flushWidgetPush(userId: number): Promise<void> {
  if (isDemoUser(userId)) return
  try {
    await sendApnsWidgetReload(userId)
  } catch (err) {
    log.error('apns', `Widget push send failed for user ${userId}:`, err)
  }
}

const debouncer = createTrailingDebouncer(
  (userId: number) => void flushWidgetPush(userId),
  WIDGET_PUSH_DEBOUNCE_MS,
)

/**
 * Register the sync-event listener that drives widget push sends. Called
 * once at server startup (see src/instrumentation.ts) — NOT per-request, or
 * every request would add another `onSyncEvent` listener.
 */
export function initWidgetPushSync(): void {
  onSyncEvent((userId) => debouncer.schedule(userId))
  log.info(
    'apns',
    `Widget push sync listener registered (${WIDGET_PUSH_DEBOUNCE_MS}ms trailing debounce)`,
  )
}
