/**
 * Bulk snooze feedback — one quiet push saying what a sweep left overdue.
 *
 * WHY. "Snooze all overdue" deliberately leaves tasks behind: P0–P2 always
 * move, P3 (High) only once nothing lower is left in the batch (so a second
 * press takes them), P4 (Urgent) never (`filterForBulkSnooze` in
 * `src/core/tasks/bulk.ts`). In the web app the toast says so
 * (`bulkSnoozeMessage`). But most sweeps run from OUTSIDE the app — the "All
 * +1hr" / "All → <period>" notification buttons, run in the background by
 * `NotificationActionRunner` on the phone, watch and Mac, and Apple Shortcuts
 * hitting the REST API — and those got no word at all about what stayed
 * overdue. This push is that word.
 *
 * WHEN (all of these):
 * - The sweep was authenticated with a **Bearer token** — the native apps and
 *   Shortcuts. A session cookie (or proxy-header auth) is the web UI, which
 *   already shows the toast.
 * - The request did not say `notify: false`. The iPhone's Home Screen quick
 *   actions send it, because they open the app and the page shows the toast
 *   (`QuickActionHandler.swift`); a Shortcut that shows `data.message` itself
 *   can send it too.
 * - Something High or Urgent was LEFT BEHIND (still overdue after the sweep).
 *   Nothing left → nothing sent: a sweep that cleared everything needs no
 *   report, and a banner saying so would be noise.
 * - The user has `notifications_enabled` AND `sweep_feedback_notifications_enabled`
 *   (Settings → Notifications → "Bulk snooze results", default on), and is not
 *   the demo user.
 *
 * WHAT. Counts only, never titles (Trent: no urgent titles on the lock screen):
 *
 *   "Snoozed 8 tasks until 3:00 PM"
 *   "2 High and 1 Urgent still overdue. Snooze again to move the High ones"
 *
 *   "Nothing snoozed"
 *   "3 Urgent can't be bulk snoozed"
 *
 * The title follows `bulkSnoozeMessage` (the web toast and `data.message`):
 * "Snoozed N tasks", or "N high-priority tasks" on the second press of a double
 * snooze. The body uses the watch's and Mac's wording for what stayed
 * (`SweepLine` in `ios/Shared/SweepSummary.swift`: "N High still overdue",
 * "N Urgent still overdue"), so every surface names the tiers alike. `until`
 * is formatted in the user's timezone like the activity log's snooze target
 * (`formatSnoozeTarget`: "3:00 PM", "tomorrow 9:00 AM", "Mon 9:00 AM").
 *
 * HOW. A banner without sound (APNs `interruption-level: active`, no `sound`;
 * Web Push `urgency: normal` + `silent`), like the "AI finished" push. APNs
 * category `TASK_SUMMARY` on the ordinary tasks thread, so it carries the
 * sweep buttons and long-press opens the bulk snooze grid; collapse id / Web
 * Push tag `sweep-result`, so a newer result replaces the older. Its lifecycle
 * on the devices (when a later sweep clears it, why it carries a `priority`)
 * is documented on `buildSweepResultNotification` in apns.ts.
 *
 * Split in two so the decision is testable without a device: `decideSweepFeedback`
 * is pure; `sendSweepFeedback` only delivers. The route calls `planSweepFeedback`
 * (which reads the user's settings and calls the pure function) and then sends
 * fire-and-forget, after the sweep has committed and without delaying the response.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { taskWord } from '@/lib/utils'
import { formatSnoozeTarget } from '@/lib/field-labels'
import { APP_URL } from '@/core/notifications/format'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import {
  sendApnsSweepResultNotification,
  isApnsConfigured,
  SWEEP_RESULT_COLLAPSE_ID,
} from '@/core/notifications/apns'

/** A sweep's result, in the terms of `bulkSnoozeMessage`'s `BulkSnoozeSkips`. */
export interface SweepCounts {
  /** Tasks moved. */
  affected: number
  /** How many of those were High (P3). */
  highAffected: number
  /** High tasks left overdue (something lower moved this round). */
  high: number
  /** Urgent tasks left overdue (never bulk-snoozed). */
  urgent: number
}

export interface SweepFeedbackContent {
  title: string
  body: string
  /** The highest tier left behind — see `buildSweepResultNotification`. */
  priority: 3 | 4
}

/** "2 High", "1 Urgent", "2 High and 1 Urgent". */
function leftList(high: number, urgent: number): string {
  const parts: string[] = []
  if (high > 0) parts.push(`${high} High`)
  if (urgent > 0) parts.push(`${urgent} Urgent`)
  return parts.join(' and ')
}

/**
 * Title and body for a sweep's feedback, or `null` when nothing High or
 * Urgent was left behind (then nothing is sent). Pure.
 */
export function sweepFeedbackContent(
  counts: SweepCounts,
  until: string,
  timezone: string,
): SweepFeedbackContent | null {
  const { affected, highAffected, high, urgent } = counts
  if (high <= 0 && urgent <= 0) return null

  let title: string
  if (affected > 0) {
    // Same rule as `bulkSnoozeMessage`: a press that moved only High tasks is
    // the second press of a double snooze, and saying so explains it.
    const what =
      highAffected === affected ? `high-priority ${taskWord(affected)}` : taskWord(affected)
    title = `Snoozed ${affected} ${what} until ${formatSnoozeTarget(until, timezone)}`
  } else {
    title = 'Nothing snoozed'
  }

  const sentences: string[] = []
  if (affected === 0 && high === 0) {
    // Only Urgent was there: nothing a sweep could ever move.
    sentences.push(`${urgent} Urgent can't be bulk snoozed`)
  } else {
    sentences.push(`${leftList(high, urgent)} still overdue`)
    if (high > 0 && affected > 0) {
      // High waits for the next press, once nothing lower is left. When
      // nothing moved at all, another press would do the same, so no hint.
      sentences.push(`Snooze again to move the High ${high === 1 ? 'one' : 'ones'}`)
    } else if (high === 0) {
      sentences.push(`Urgent can't be bulk snoozed`)
    }
  }

  return { title, body: sentences.join('. '), priority: urgent > 0 ? 4 : 3 }
}

/** The user's side of the decision. */
export interface SweepFeedbackUser {
  is_demo: number
  notifications_enabled: number
  sweep_feedback_notifications_enabled: number
}

export interface SweepFeedbackInput {
  /** The request was authenticated with a Bearer token (not a session or proxy header). */
  viaBearer: boolean
  /** The request's `notify` field; only `false` suppresses. */
  notify: boolean | undefined
  counts: SweepCounts
  /** The resolved snooze target (ISO). */
  until: string
  timezone: string
  /** Overdue tasks left after the sweep — the bulk grid's header count. */
  totalOverdueCount: number
}

export interface SweepFeedback extends SweepFeedbackContent {
  totalOverdueCount: number
}

/** Whether to send, and what. Pure: every input is passed in. */
export function decideSweepFeedback(
  input: SweepFeedbackInput,
  user: SweepFeedbackUser | undefined,
): SweepFeedback | null {
  if (!input.viaBearer || input.notify === false) return null
  if (!user || user.is_demo || !user.notifications_enabled) return null
  if (!user.sweep_feedback_notifications_enabled) return null

  const content = sweepFeedbackContent(input.counts, input.until, input.timezone)
  if (!content) return null
  return { ...content, totalOverdueCount: input.totalOverdueCount }
}

/** `decideSweepFeedback` with the user's settings read from the database. */
export function planSweepFeedback(userId: number, input: SweepFeedbackInput): SweepFeedback | null {
  // Cheap exits first, so the common cases never touch the database.
  if (!input.viaBearer || input.notify === false) return null
  if (input.counts.high <= 0 && input.counts.urgent <= 0) return null

  const user = getDb()
    .prepare(
      `SELECT is_demo, notifications_enabled, sweep_feedback_notifications_enabled
       FROM users WHERE id = ?`,
    )
    .get(userId) as SweepFeedbackUser | undefined
  return decideSweepFeedback(input, user)
}

/**
 * Deliver a decided feedback push to every APNs device and Web Push
 * subscription. Never throws: failures are logged, so a route can call it
 * without awaiting.
 */
export async function sendSweepFeedback(userId: number, feedback: SweepFeedback): Promise<void> {
  const webPush = isWebPushConfigured()
  const apns = isApnsConfigured()
  if (!webPush && !apns) return

  log.info('notifications', `Sweep feedback for user ${userId}: ${feedback.body}`)

  const sends: Promise<void>[] = []
  if (webPush) {
    sends.push(
      sendPushNotification(
        userId,
        {
          title: feedback.title,
          body: feedback.body,
          data: { url: `${APP_URL}/` },
          tag: SWEEP_RESULT_COLLAPSE_ID,
          silent: true,
        },
        { urgency: 'normal' },
      ),
    )
  }
  if (apns) sends.push(sendApnsSweepResultNotification(userId, feedback))

  const results = await Promise.allSettled(sends)
  for (const r of results) {
    if (r.status === 'rejected') log.error('notifications', 'Sweep feedback error:', r.reason)
  }
}
