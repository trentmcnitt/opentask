/**
 * Overdue task checker - runs every minute
 *
 * Checks for overdue tasks and sends notifications via ntfy.
 *
 * Notification strategy by priority:
 * - P2+ (Medium/High/Urgent): Individual notification per task with action buttons
 * - P0-P1 (Unset/Low), single task: Individual notification (same as P2+)
 * - P0-P1 (Unset/Low), multiple tasks: Bulk summary linking to dashboard filtered by overdue
 *
 * Auto-snooze (notification repeat interval) by priority:
 * - P4 (Urgent): user.auto_snooze_urgent_minutes (default 5 min)
 * - P3 (High): user.auto_snooze_high_minutes (default 15 min)
 * - P0-P2: user.auto_snooze_minutes (default 30 min)
 * - Per-task auto_snooze_minutes override takes precedence over all tiers
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { MEDIUM_PRIORITY_THRESHOLD, HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'

const DEFAULT_NTFY_URL = process.env.NTFY_URL || 'https://ntfy.tk11.mcnitt.io'
const DEFAULT_NTFY_TOPIC = process.env.NTFY_TOPIC || 'opentask'
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

interface OverdueTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
  last_notified_at: string | null
  auto_snooze_minutes: number | null
  user_auto_snooze_minutes: number
  user_auto_snooze_urgent_minutes: number
  user_auto_snooze_high_minutes: number
}

interface UserNotificationSettings {
  user_id: number
  ntfy_topic: string | null
  ntfy_server: string | null
  api_token: string | null
}

/**
 * Get the effective notification repeat interval for a task in minutes.
 * Per-task override > priority-based user default.
 */
function getEffectiveInterval(task: OverdueTask): number {
  if (task.auto_snooze_minutes !== null) return task.auto_snooze_minutes
  if (task.priority >= 4) return task.user_auto_snooze_urgent_minutes
  if (task.priority >= HIGH_PRIORITY_THRESHOLD) return task.user_auto_snooze_high_minutes
  return task.user_auto_snooze_minutes
}

/** Check whether a task's cooldown has elapsed and it's eligible for notification. */
function isEligibleForNotification(task: OverdueTask, now: Date): boolean {
  if (!task.last_notified_at) return true
  const interval = getEffectiveInterval(task)
  if (interval === 0) return false
  const lastNotified = new Date(task.last_notified_at)
  const cooldownMs = interval * 60 * 1000
  return now.getTime() - lastNotified.getTime() >= cooldownMs
}

/**
 * Build ntfy action buttons for a specific task.
 * ntfy supports max 3 action buttons. "Open" is handled by the Click header
 * (tapping the notification body), so we use all 3 slots for: Done, +30m, +1hr.
 */
function buildTaskActions(task: OverdueTask, apiToken: string | null): NtfyAction[] {
  if (!apiToken) return []

  const actionBase = `${APP_URL}/api/notifications/actions`
  return [
    {
      action: 'http',
      label: 'Done',
      url: actionBase,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'done', task_id: task.id, token: apiToken }),
    },
    {
      action: 'http',
      label: '+30m',
      url: actionBase,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze30', task_id: task.id, token: apiToken }),
    },
    {
      action: 'http',
      label: '+1hr',
      url: actionBase,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', task_id: task.id, token: apiToken }),
    },
  ]
}

/** Send an individual notification for a single task. */
async function sendIndividualNotification(
  task: OverdueTask,
  settings: UserNotificationSettings,
  ntfyServer: string,
  ntfyTopic: string,
): Promise<void> {
  const ntfyPriority = task.priority >= 4 ? 5 : task.priority >= HIGH_PRIORITY_THRESHOLD ? 4 : 3
  const tags = task.priority >= HIGH_PRIORITY_THRESHOLD ? ['warning'] : []

  const icon =
    task.priority >= 4
      ? `${APP_URL}/icon-192-urgent.png`
      : task.priority >= HIGH_PRIORITY_THRESHOLD
        ? `${APP_URL}/icon-192-high.png`
        : `${APP_URL}/icon-192.png`

  await sendNtfyNotification({
    server: ntfyServer,
    topic: ntfyTopic,
    title: task.title,
    message: 'Overdue task',
    priority: ntfyPriority,
    tags,
    click: `${APP_URL}/tasks/${task.id}`,
    icon,
    actions: buildTaskActions(task, settings.api_token),
  })
}

/** Send a bulk summary notification for multiple low-priority tasks. */
async function sendBulkNotification(
  tasks: OverdueTask[],
  ntfyServer: string,
  ntfyTopic: string,
): Promise<void> {
  const maxDisplay = 5
  let message = ''
  tasks.slice(0, maxDisplay).forEach((t) => {
    message += `- ${t.title}\n`
  })
  if (tasks.length > maxDisplay) {
    message += `... and ${tasks.length - maxDisplay} more`
  }

  await sendNtfyNotification({
    server: ntfyServer,
    topic: ntfyTopic,
    title: `${tasks.length} overdue tasks`,
    message: message.trim(),
    priority: 3,
    tags: [],
    click: `${APP_URL}/?filter=overdue`,
    icon: `${APP_URL}/icon-192.png`,
    actions: [{ action: 'view', label: 'View All', url: `${APP_URL}/?filter=overdue` }],
  })
}

export async function checkOverdueTasks(): Promise<void> {
  try {
    const db = getDb()
    const now = new Date()

    // Fetch all overdue tasks. Cooldown filtering is done in JS because the
    // repeat interval varies by task priority (urgent=5m, high=15m, default=30m).
    const overdueTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id, t.last_notified_at,
               t.auto_snooze_minutes,
               u.auto_snooze_minutes as user_auto_snooze_minutes,
               u.auto_snooze_urgent_minutes as user_auto_snooze_urgent_minutes,
               u.auto_snooze_high_minutes as user_auto_snooze_high_minutes
        FROM tasks t
        INNER JOIN projects p ON t.project_id = p.id
        INNER JOIN users u ON t.user_id = u.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND t.due_at < datetime('now')
        ORDER BY t.priority DESC, t.due_at ASC
        LIMIT 100
      `,
      )
      .all() as OverdueTask[]

    // Apply priority-aware cooldown filtering
    const eligibleTasks = overdueTasks.filter((t) => isEligibleForNotification(t, now))
    if (eligibleTasks.length === 0) return

    // Get user notification settings and API tokens
    const userIds = [...new Set(eligibleTasks.map((t) => t.user_id))]
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

    // Group tasks by user
    const tasksByUser = new Map<number, OverdueTask[]>()
    for (const task of eligibleTasks) {
      const list = tasksByUser.get(task.user_id) || []
      list.push(task)
      tasksByUser.set(task.user_id, list)
    }

    // Send notifications per user with priority-based splitting
    for (const [userId, tasks] of tasksByUser) {
      const settings = userSettings.get(userId)
      if (!settings) continue

      const ntfyServer = settings.ntfy_server || DEFAULT_NTFY_URL
      const ntfyTopic = settings.ntfy_topic || DEFAULT_NTFY_TOPIC

      // Split by priority: P2+ get individual notifications, P0-P1 get bulk
      const individualTasks = tasks.filter((t) => t.priority >= MEDIUM_PRIORITY_THRESHOLD)
      const bulkCandidates = tasks.filter((t) => t.priority < MEDIUM_PRIORITY_THRESHOLD)

      if (individualTasks.length > 20) {
        log.warn(
          'notifications',
          `Sending ${individualTasks.length} individual notifications for user ${userId}`,
        )
      }

      // Individual notification for each medium+ task
      for (const task of individualTasks) {
        await sendIndividualNotification(task, settings, ntfyServer, ntfyTopic)
      }

      // Low/unset tasks: individual if only one, bulk if multiple
      if (bulkCandidates.length === 1) {
        await sendIndividualNotification(bulkCandidates[0], settings, ntfyServer, ntfyTopic)
      } else if (bulkCandidates.length > 1) {
        await sendBulkNotification(bulkCandidates, ntfyServer, ntfyTopic)
      }

      // Update last_notified_at for all notified tasks
      const allNotified = [...individualTasks, ...bulkCandidates]
      const taskIds = allNotified.map((t) => t.id)
      const placeholders = taskIds.map(() => '?').join(',')
      db.prepare(`UPDATE tasks SET last_notified_at = ? WHERE id IN (${placeholders})`).run(
        now.toISOString(),
        ...taskIds,
      )
    }
  } catch (err) {
    log.error('notifications', 'Overdue checker error:', err)
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
  click?: string
  icon?: string
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

    if (opts.click) {
      headers.Click = opts.click
    }

    if (opts.icon) {
      headers.Icon = opts.icon
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
    log.error('notifications', 'ntfy send error:', err)
  }
}
