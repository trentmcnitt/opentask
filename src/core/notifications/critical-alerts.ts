/**
 * Critical alerts - sends Pushover emergency priority for tasks with 'critical' label
 */

import { getDb } from '@/core/db'

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || ''
const PUSHOVER_USER = process.env.PUSHOVER_USER || ''
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.tk11.mcnitt.io'
const NTFY_CRITICAL_TOPIC = process.env.NTFY_CRITICAL_TOPIC || 'opentask-critical'

interface CriticalTask {
  id: number
  title: string
  due_at: string
}

export async function checkCriticalTasks(): Promise<void> {
  try {
    const db = getDb()

    const criticalTasks = db
      .prepare(
        `
        SELECT id, title, due_at
        FROM tasks
        WHERE done = 0
          AND deleted_at IS NULL
          AND archived_at IS NULL
          AND due_at IS NOT NULL
          AND due_at < datetime('now')
          AND labels LIKE '%"critical"%'
        ORDER BY due_at ASC
        LIMIT 5
      `
      )
      .all() as CriticalTask[]

    if (criticalTasks.length === 0) return

    for (const task of criticalTasks) {
      // Send via ntfy with max priority
      await sendCriticalNtfy(task)

      // Send via Pushover if configured
      if (PUSHOVER_TOKEN && PUSHOVER_USER) {
        await sendPushoverAlert(task)
      }
    }
  } catch (err) {
    console.error('Critical alerts error:', err)
  }
}

async function sendCriticalNtfy(task: CriticalTask): Promise<void> {
  try {
    await fetch(`${NTFY_URL}/${NTFY_CRITICAL_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: `CRITICAL: ${task.title}`,
        Priority: '5',
        Tags: 'rotating_light',
      },
      body: `Task "${task.title}" is overdue and marked critical! Due: ${task.due_at}`,
    })
  } catch (err) {
    console.error('ntfy critical send error:', err)
  }
}

async function sendPushoverAlert(task: CriticalTask): Promise<void> {
  try {
    const params = new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: `CRITICAL: ${task.title}`,
      message: `Overdue critical task: "${task.title}" (due ${task.due_at})`,
      priority: '2', // Emergency
      retry: '300',  // Retry every 5 min
      expire: '3600', // Expire after 1 hour
    })

    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: params,
    })
  } catch (err) {
    console.error('Pushover send error:', err)
  }
}
