/**
 * Deadline-cap feedback — one quiet push when a notification button's snooze
 * stopped AT the deadline (ruling A3, Trent 2026-10-11).
 *
 * WHY. A quick snooze from outside the app — a notification's "+1hr" or its
 * custom time — never carries a task past a deadline that is still ahead: the
 * server moves the target to the deadline instead (`cap_at_deadline`,
 * `capSnoozeAtDeadline` in collect-field-changes.ts). Every surface that shows
 * the result says so itself: the web toast reads the change description
 * ("Deferred to deadline 6:00 PM"), and the native apps' rows show the new
 * time. A notification button runs in the background and shows nothing, so
 * this push is its word.
 *
 * WHEN: the snooze was capped; the user has `notifications_enabled` and
 * `sweep_feedback_notifications_enabled` (Settings → Notifications → "Bulk
 * snooze results" — the same "tell me what a snooze from outside did"
 * switch); and is not the demo user.
 *
 * WHAT. "Deferred to deadline 6:00 PM" / "A quick defer stops at the deadline".
 * No title of the task, like the sweep feedback (Trent: no titles on the lock
 * screen for these); the banner it answers already named it.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { formatSnoozeTarget } from '@/lib/field-labels'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { APP_URL } from '@/core/notifications/format'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import {
  sendApnsDeadlineCapNotification,
  isApnsConfigured,
  DEADLINE_CAP_COLLAPSE_ID,
} from '@/core/notifications/apns'

export interface DeadlineCapContent {
  title: string
  body: string
}

/** Title and body for a capped snooze. Pure. */
export function deadlineCapContent(
  deadlineAt: string,
  timezone: string,
  /** The user's day boundary: "tomorrow 6:00 PM" by OpenTask day. */
  dayStart: string,
): DeadlineCapContent {
  return {
    title: `Deferred to deadline ${formatSnoozeTarget(deadlineAt, timezone, dayStart)}`,
    body: 'A quick defer stops at the deadline',
  }
}

interface CapFeedbackUser {
  is_demo: number
  notifications_enabled: number
  sweep_feedback_notifications_enabled: number
}

/** Whether this user gets the push. Pure. */
export function wantsDeadlineCapFeedback(user: CapFeedbackUser | undefined): boolean {
  return (
    !!user &&
    !user.is_demo &&
    !!user.notifications_enabled &&
    !!user.sweep_feedback_notifications_enabled
  )
}

/**
 * Send the push for a capped snooze when the user wants it. Never throws:
 * failures are logged, so a route can call it without awaiting.
 */
export async function sendDeadlineCapFeedback(
  userId: number,
  deadlineAt: string,
  timezone: string,
): Promise<void> {
  try {
    const user = getDb()
      .prepare(
        `SELECT is_demo, notifications_enabled, sweep_feedback_notifications_enabled
         FROM users WHERE id = ?`,
      )
      .get(userId) as CapFeedbackUser | undefined
    if (!wantsDeadlineCapFeedback(user)) return
    const webPush = isWebPushConfigured()
    const apns = isApnsConfigured()
    if (!webPush && !apns) return

    const content = deadlineCapContent(deadlineAt, timezone, dayBoundaryForUser(userId))
    log.info('notifications', `Deadline cap feedback for user ${userId}: ${content.title}`)
    const sends: Promise<unknown>[] = []
    if (webPush) {
      sends.push(
        sendPushNotification(
          userId,
          { ...content, data: { url: `${APP_URL}/` }, tag: DEADLINE_CAP_COLLAPSE_ID, silent: true },
          { urgency: 'normal' },
        ),
      )
    }
    if (apns) sends.push(sendApnsDeadlineCapNotification(userId, content))
    const results = await Promise.allSettled(sends)
    for (const r of results) {
      if (r.status === 'rejected')
        log.error('notifications', 'Deadline cap feedback error:', r.reason)
    }
  } catch (err) {
    log.error('notifications', 'Deadline cap feedback error:', err)
  }
}
