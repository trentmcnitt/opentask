/**
 * Critical alerts — sends APNs time-sensitive notifications for overdue Urgent (P4) tasks
 *
 * APNs `interruption-level: "time-sensitive"` breaks through iOS Focus mode.
 * This runs on its own cooldown (last_critical_alert_at), independent of the
 * overdue checker's APNs sends.
 *
 * Web Push is NOT sent here — the overdue checker already handles Web Push
 * for all priority tiers, including P4. This module adds the APNs time-sensitive
 * layer on top.
 *
 * Cooldown: 60 minutes per task (via `last_critical_alert_at`).
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { sendApnsNotification, isApnsConfigured } from '@/core/notifications/apns'

const NOTIFICATION_COOLDOWN_MINUTES = 60

interface CriticalTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
}

export async function checkCriticalTasks(): Promise<void> {
  try {
    if (!isApnsConfigured()) return

    const db = getDb()
    const now = new Date()
    const cooldownCutoff = new Date(now.getTime() - NOTIFICATION_COOLDOWN_MINUTES * 60 * 1000)

    const criticalTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id
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
      await sendApnsNotification(task.user_id, {
        title: `URGENT: ${task.title}`,
        body: 'Overdue task',
        taskId: task.id,
        dueAt: task.due_at,
        priority: task.priority,
        overdueCount: 0,
        interruptionLevel: 'time-sensitive',
      })

      db.prepare('UPDATE tasks SET last_critical_alert_at = ? WHERE id = ?').run(
        now.toISOString(),
        task.id,
      )
    }
  } catch (err) {
    log.error('notifications', 'Critical alerts error:', err)
  }
}
