/**
 * Overdue task checker - runs every 30 minutes
 *
 * Checks for overdue tasks and sends notifications via ntfy.
 * Features:
 * - 30-minute per-task cooldown to prevent spam
 * - Action buttons: Done, +30m, +1hr, +2hr
 * - Per-user notification routing via ntfy settings
 */

import { getDb } from '@/core/db'

const DEFAULT_NTFY_URL = process.env.NTFY_URL || 'https://ntfy.tk11.mcnitt.io'
const DEFAULT_NTFY_TOPIC = process.env.NTFY_TOPIC || 'opentask'
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'
const NOTIFICATION_COOLDOWN_MINUTES = 30

interface OverdueTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
  last_notified_at: string | null
}

interface UserNotificationSettings {
  user_id: number
  ntfy_topic: string | null
  ntfy_server: string | null
  api_token: string | null
}

export async function checkOverdueTasks(): Promise<void> {
  try {
    const db = getDb()
    const now = new Date()
    const cooldownCutoff = new Date(now.getTime() - NOTIFICATION_COOLDOWN_MINUTES * 60 * 1000)

    // Get overdue tasks that haven't been notified within the cooldown period
    const overdueTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id, t.last_notified_at
        FROM tasks t
        INNER JOIN projects p ON t.project_id = p.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND t.due_at < datetime('now')
          AND (t.last_notified_at IS NULL OR t.last_notified_at < ?)
        ORDER BY t.due_at ASC
        LIMIT 50
      `,
      )
      .all(cooldownCutoff.toISOString()) as OverdueTask[]

    if (overdueTasks.length === 0) return

    // Get user notification settings and API tokens
    const userIds = [...new Set(overdueTasks.map((t) => t.user_id))]
    const userSettings = new Map<number, UserNotificationSettings>()

    for (const userId of userIds) {
      const settings = db
        .prepare(
          `
          SELECT u.id as user_id, u.ntfy_topic, u.ntfy_server,
                 (SELECT token FROM api_tokens WHERE user_id = u.id LIMIT 1) as api_token
          FROM users u
          WHERE u.id = ?
        `,
        )
        .get(userId) as UserNotificationSettings | undefined

      if (settings) {
        userSettings.set(userId, settings)
      }
    }

    // Group tasks by user for batched notifications
    const tasksByUser = new Map<number, OverdueTask[]>()
    for (const task of overdueTasks) {
      const list = tasksByUser.get(task.user_id) || []
      list.push(task)
      tasksByUser.set(task.user_id, list)
    }

    // Send notifications per user
    for (const [userId, tasks] of tasksByUser) {
      const settings = userSettings.get(userId)
      if (!settings) continue

      // Determine ntfy endpoint for this user
      const ntfyServer = settings.ntfy_server || DEFAULT_NTFY_URL
      const ntfyTopic = settings.ntfy_topic || DEFAULT_NTFY_TOPIC

      // Group by priority for notification formatting
      const urgent = tasks.filter((t) => t.priority >= 3)
      const normal = tasks.filter((t) => t.priority < 3)

      let message = ''
      if (urgent.length > 0) {
        message += `${urgent.length} urgent/high:\n`
        urgent.forEach((t) => {
          message += `  - ${t.title}\n`
        })
      }
      if (normal.length > 0) {
        message += `${normal.length} other overdue:\n`
        normal.slice(0, 5).forEach((t) => {
          message += `  - ${t.title}\n`
        })
        if (normal.length > 5) {
          message += `  ... and ${normal.length - 5} more\n`
        }
      }

      // Build action buttons for the first task (most actionable)
      const firstTask = tasks[0]
      const actions: NtfyAction[] = [
        {
          action: 'view',
          label: 'Open',
          url: `${APP_URL}/tasks/${firstTask.id}`,
        },
      ]

      // Add action buttons if user has an API token
      if (settings.api_token) {
        const actionBase = `${APP_URL}/api/notifications/actions`

        actions.push(
          {
            action: 'http',
            label: 'Done',
            url: actionBase,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'done',
              task_id: firstTask.id,
              token: settings.api_token,
            }),
          },
          {
            action: 'http',
            label: '+30m',
            url: actionBase,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'snooze30',
              task_id: firstTask.id,
              token: settings.api_token,
            }),
          },
          {
            action: 'http',
            label: '+1hr',
            url: actionBase,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'snooze',
              task_id: firstTask.id,
              token: settings.api_token,
            }),
          },
          {
            action: 'http',
            label: '+2hr',
            url: actionBase,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'snooze2h',
              task_id: firstTask.id,
              token: settings.api_token,
            }),
          },
        )
      }

      // Send ntfy notification
      await sendNtfyNotification({
        server: ntfyServer,
        topic: ntfyTopic,
        title: `${tasks.length} overdue task${tasks.length > 1 ? 's' : ''}`,
        message: message.trim(),
        priority: urgent.length > 0 ? 4 : 3,
        tags: ['warning'],
        actions,
      })

      // Update last_notified_at for all notified tasks
      const taskIds = tasks.map((t) => t.id)
      const placeholders = taskIds.map(() => '?').join(',')
      db.prepare(`UPDATE tasks SET last_notified_at = ? WHERE id IN (${placeholders})`).run(
        now.toISOString(),
        ...taskIds,
      )
    }
  } catch (err) {
    console.error('Overdue checker error:', err)
  }
}

interface NtfyAction {
  action: string
  label: string
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

interface NtfyOptions {
  server: string
  topic: string
  title: string
  message: string
  priority?: number
  tags?: string[]
  actions?: NtfyAction[]
}

async function sendNtfyNotification(opts: NtfyOptions): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Title: opts.title,
      Priority: String(opts.priority || 3),
    }

    if (opts.tags?.length) {
      headers.Tags = opts.tags.join(',')
    }

    if (opts.actions?.length) {
      // Format actions for ntfy header
      // Simple actions: view, URL
      // HTTP actions: http, label, URL, method=POST, headers=JSON, body=JSON
      headers.Actions = opts.actions
        .map((a) => {
          if (a.action === 'http') {
            let actionStr = `http, ${a.label}, ${a.url}`
            if (a.method) actionStr += `, method=${a.method}`
            if (a.headers) actionStr += `, headers=${JSON.stringify(a.headers)}`
            if (a.body) actionStr += `, body=${a.body}`
            return actionStr
          }
          return `${a.action}, ${a.label}${a.url ? `, ${a.url}` : ''}`
        })
        .join('; ')
    }

    await fetch(`${opts.server}/${opts.topic}`, {
      method: 'POST',
      headers,
      body: opts.message,
    })
  } catch (err) {
    console.error('ntfy send error:', err)
  }
}
