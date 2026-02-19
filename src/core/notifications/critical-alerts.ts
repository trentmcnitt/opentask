/**
 * Critical alerts — sends Pushover emergency priority for overdue Urgent (P4) tasks
 *
 * Pushover emergency priority (2) bypasses Focus/DND on iOS. The value is
 * interruption, not navigation — tapping opens the Pushover app, not the PWA.
 *
 * Web Push is NOT sent here — the overdue checker already handles Web Push
 * for all priority tiers, including P4. This module adds the Pushover
 * emergency layer on top.
 *
 * APNs is also sent here for P4 tasks with `interruption-level: "time-sensitive"`,
 * which breaks through iOS Focus mode. This runs on the critical alerts cooldown
 * (last_critical_alert_at), independent of the overdue checker's APNs sends.
 *
 * Cooldown: 60 minutes per task (via `last_critical_alert_at`), independent
 * of the overdue checker's `last_notified_at`. This matches the Pushover
 * `expire=3600` setting — after the emergency alert expires, a new one is
 * sent if the task is still overdue.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { generateSignedActionUrl } from '@/core/notifications/signed-url'
import { sendApnsNotification, isApnsConfigured } from '@/core/notifications/apns'

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || ''
const PUSHOVER_USER = process.env.PUSHOVER_USER || ''
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'
const NOTIFICATION_COOLDOWN_MINUTES = 60

interface CriticalTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
  pushover_user_key: string | null
  pushover_sound: string
  auto_snooze_urgent_minutes: number
}

export async function checkCriticalTasks(): Promise<void> {
  try {
    const db = getDb()
    const now = new Date()
    const cooldownCutoff = new Date(now.getTime() - NOTIFICATION_COOLDOWN_MINUTES * 60 * 1000)

    // Only fire if at least one critical alert channel is configured
    if (!PUSHOVER_TOKEN && !isApnsConfigured()) return

    // Clean up old receipts (>24h) — lightweight inline cleanup
    db.prepare(
      "DELETE FROM pushover_receipts WHERE created_at < datetime('now', '-24 hours')",
    ).run()

    const criticalTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id, u.pushover_user_key,
               u.pushover_sound, u.auto_snooze_urgent_minutes
        FROM tasks t
        INNER JOIN users u ON t.user_id = u.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND datetime(t.due_at) < datetime('now')
          AND t.priority = 4
          AND (t.last_critical_alert_at IS NULL OR t.last_critical_alert_at < ?)
          AND u.notifications_enabled = 1
        ORDER BY t.due_at ASC
        LIMIT 5
        `,
      )
      .all(cooldownCutoff.toISOString()) as CriticalTask[]

    if (criticalTasks.length === 0) return

    for (const task of criticalTasks) {
      // Pushover emergency alert
      const pushoverUser = task.pushover_user_key || PUSHOVER_USER
      if (pushoverUser) {
        await sendPushoverAlert(
          task,
          pushoverUser,
          task.pushover_sound,
          task.auto_snooze_urgent_minutes,
        )
      }

      // APNs time-sensitive alert for iOS app (independent of Pushover)
      if (isApnsConfigured()) {
        await sendApnsNotification(task.user_id, {
          title: `URGENT: ${task.title}`,
          body: 'Overdue task',
          taskId: task.id,
          dueAt: task.due_at,
          priority: task.priority,
          overdueCount: 0,
          interruptionLevel: 'time-sensitive',
        })
      }

      db.prepare('UPDATE tasks SET last_critical_alert_at = ? WHERE id = ?').run(
        now.toISOString(),
        task.id,
      )
    }
  } catch (err) {
    log.error('notifications', 'Critical alerts error:', err)
  }
}

async function sendPushoverAlert(
  task: CriticalTask,
  pushoverUser: string,
  sound: string,
  autoSnoozeMinutes: number,
): Promise<void> {
  try {
    // Dynamic retry: match the user's urgent notification interval (min 30s per Pushover API)
    const retrySeconds = Math.max(30, autoSnoozeMinutes * 60)

    // Generate signed action URLs (HTML links visible when notification is opened in Pushover app)
    const doneUrl = generateSignedActionUrl(task.id, task.user_id, 'done')
    const snooze30Url = generateSignedActionUrl(task.id, task.user_id, 'snooze30')
    const snoozeUrl = generateSignedActionUrl(task.id, task.user_id, 'snooze')
    const snooze2hUrl = generateSignedActionUrl(task.id, task.user_id, 'snooze2h')

    const message =
      `Overdue urgent task (due ${task.due_at})\n\n` +
      `<a href="${doneUrl}">Mark Done</a>  ·  ` +
      `<a href="${snooze30Url}">+30m</a>  ·  ` +
      `<a href="${snoozeUrl}">+1hr</a>  ·  ` +
      `<a href="${snooze2hUrl}">+2hr</a>`

    const params = new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: pushoverUser,
      title: `URGENT: ${task.title}`,
      message,
      html: '1',
      priority: '2', // Emergency
      retry: String(retrySeconds),
      expire: '3600', // Expire after 1 hour
      sound,
      callback: `${APP_URL}/api/notifications/pushover-callback`,
      url: `${APP_URL}/?task=${task.id}`,
      url_title: 'Open in OpenTask',
    })

    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: params,
    })

    // Store receipt for acknowledge callback (Feature 2a)
    if (res.ok) {
      try {
        const data = await res.json()
        if (data.receipt) {
          const db = getDb()
          db.prepare(
            'INSERT OR IGNORE INTO pushover_receipts (receipt, task_id, user_id) VALUES (?, ?, ?)',
          ).run(data.receipt, task.id, task.user_id)
        }
      } catch {
        // Non-critical: receipt storage failure doesn't affect the alert
      }
    }
  } catch (err) {
    log.error('notifications', 'Pushover send error:', err)
  }
}
