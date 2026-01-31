/**
 * Overdue task checker - runs every 30 minutes
 *
 * Checks for overdue tasks and sends notifications via ntfy.
 */

import { getDb } from '@/core/db'

const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.tk11.mcnitt.io'
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'opentask'
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

interface OverdueTask {
  id: number
  title: string
  due_at: string
  priority: number
  user_id: number
}

export async function checkOverdueTasks(): Promise<void> {
  try {
    const db = getDb()

    const overdueTasks = db
      .prepare(
        `
        SELECT t.id, t.title, t.due_at, t.priority, t.user_id
        FROM tasks t
        INNER JOIN projects p ON t.project_id = p.id
        WHERE t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.due_at IS NOT NULL
          AND t.due_at < datetime('now')
        ORDER BY t.due_at ASC
        LIMIT 20
      `
      )
      .all() as OverdueTask[]

    if (overdueTasks.length === 0) return

    // Group by priority for notification formatting
    const urgent = overdueTasks.filter((t) => t.priority >= 3)
    const normal = overdueTasks.filter((t) => t.priority < 3)

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

    // Send ntfy notification
    await sendNtfyNotification({
      title: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''}`,
      message: message.trim(),
      priority: urgent.length > 0 ? 4 : 3,
      tags: ['warning'],
      actions: [
        {
          action: 'view',
          label: 'Open Dashboard',
          url: APP_URL,
        },
      ],
    })
  } catch (err) {
    console.error('Overdue checker error:', err)
  }
}

interface NtfyOptions {
  title: string
  message: string
  priority?: number
  tags?: string[]
  actions?: Array<{
    action: string
    label: string
    url?: string
  }>
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
      headers.Actions = opts.actions
        .map((a) => `${a.action}, ${a.label}${a.url ? `, ${a.url}` : ''}`)
        .join('; ')
    }

    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: opts.message,
    })
  } catch (err) {
    console.error('ntfy send error:', err)
  }
}
