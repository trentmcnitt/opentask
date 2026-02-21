/**
 * Critical alerts — sends APNs time-sensitive notifications for overdue Urgent (P4) tasks
 *
 * APNs `interruption-level: "time-sensitive"` breaks through iOS Focus mode.
 * This runs independently of the overdue checker's APNs sends.
 *
 * Web Push is NOT sent here — the overdue checker already handles Web Push
 * for all priority tiers, including P4. This module adds the APNs time-sensitive
 * layer on top.
 *
 * Timing uses mod-based boundary detection: a P4 task gets a critical alert
 * when floor((now - due_at) / 60000) % 60 === 0, i.e. every 60 minutes
 * aligned to the task's due_at. No state tracking needed.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { sendApnsNotification, isApnsConfigured } from '@/core/notifications/apns'

const CRITICAL_ALERT_INTERVAL_MINUTES = 60

interface CriticalTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
}

/** Check whether this cron cycle is a 60-minute boundary for the task. */
export function isCriticalAlertBoundary(task: CriticalTask, now: Date): boolean {
  const minutesSinceDue = Math.floor((now.getTime() - new Date(task.due_at).getTime()) / 60000)
  return minutesSinceDue >= 0 && minutesSinceDue % CRITICAL_ALERT_INTERVAL_MINUTES === 0
}

export async function checkCriticalTasks(): Promise<void> {
  try {
    if (!isApnsConfigured()) return

    const db = getDb()
    const now = new Date()

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
          AND u.notifications_enabled = 1
        ORDER BY t.due_at ASC
        LIMIT 5
        `,
      )
      .all() as CriticalTask[]

    // Filter to tasks at a 60-minute boundary
    const eligibleTasks = criticalTasks.filter((t) => isCriticalAlertBoundary(t, now))
    if (eligibleTasks.length === 0) return

    for (const task of eligibleTasks) {
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
  } catch (err) {
    log.error('notifications', 'Critical alerts error:', err)
  }
}
