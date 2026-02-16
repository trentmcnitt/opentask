/**
 * Critical alerts - sends Pushover emergency priority for tasks with 'critical' label
 *
 * Features:
 * - 30-minute per-task cooldown to prevent alert fatigue
 * - Uses same last_notified_at column as regular overdue notifications
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || ''
const PUSHOVER_USER = process.env.PUSHOVER_USER || ''
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.tk11.mcnitt.io'
const NTFY_CRITICAL_TOPIC = process.env.NTFY_CRITICAL_TOPIC || 'opentask-critical'
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'
const NOTIFICATION_COOLDOWN_MINUTES = 30

interface CriticalTask {
  id: number
  title: string
  due_at: string
  user_id: number
  ntfy_server: string | null
  pushover_user_key: string | null
}

export async function checkCriticalTasks(): Promise<void> {
  try {
    const db = getDb()
    const now = new Date()
    const cooldownCutoff = new Date(now.getTime() - NOTIFICATION_COOLDOWN_MINUTES * 60 * 1000)

    const criticalTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.user_id, u.ntfy_server, u.pushover_user_key
        FROM tasks t
        INNER JOIN users u ON t.user_id = u.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND t.due_at < datetime('now')
          AND t.labels LIKE '%"critical"%'
          AND (t.last_notified_at IS NULL OR t.last_notified_at < ?)
        ORDER BY t.due_at ASC
        LIMIT 5
      `,
      )
      .all(cooldownCutoff.toISOString()) as CriticalTask[]

    if (criticalTasks.length === 0) return

    for (const task of criticalTasks) {
      // Send via ntfy with max priority (per-user server takes precedence over global)
      const ntfyServer = task.ntfy_server || NTFY_URL
      await sendCriticalNtfy(task, ntfyServer)

      // Send via Pushover if configured (per-user key takes precedence over global)
      const pushoverUser = task.pushover_user_key || PUSHOVER_USER
      if (PUSHOVER_TOKEN && pushoverUser) {
        await sendPushoverAlert(task, pushoverUser)
      }

      db.prepare('UPDATE tasks SET last_notified_at = ? WHERE id = ?').run(
        now.toISOString(),
        task.id,
      )
    }
  } catch (err) {
    log.error('notifications', 'Critical alerts error:', err)
  }
}

async function sendCriticalNtfy(task: CriticalTask, ntfyServer: string): Promise<void> {
  try {
    await fetch(`${ntfyServer}/${NTFY_CRITICAL_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: `CRITICAL: ${task.title}`,
        Priority: '5',
        Tags: 'rotating_light',
        Click: `${APP_URL}/tasks/${task.id}`,
        Icon: `${APP_URL}/icon-192-urgent.png`,
      },
      body: `Task "${task.title}" is overdue and marked critical! Due: ${task.due_at}`,
    })
  } catch (err) {
    log.error('notifications', 'ntfy critical send error:', err)
  }
}

async function sendPushoverAlert(task: CriticalTask, pushoverUser: string): Promise<void> {
  try {
    const params = new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: pushoverUser,
      title: `CRITICAL: ${task.title}`,
      message: `Overdue critical task: "${task.title}" (due ${task.due_at})`,
      priority: '2', // Emergency
      retry: '300', // Retry every 5 min
      expire: '3600', // Expire after 1 hour
    })

    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: params,
    })
  } catch (err) {
    log.error('notifications', 'Pushover send error:', err)
  }
}
