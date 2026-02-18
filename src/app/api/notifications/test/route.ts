/**
 * Test notification API
 *
 * POST /api/notifications/test
 * Body: { type: 'individual' | 'high' | 'bulk' | 'critical' }
 *
 * Sends a test notification of the requested type using the user's configured
 * ntfy/Pushover endpoints.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

const DEFAULT_NTFY_URL = process.env.NTFY_URL || 'https://ntfy.tk11.mcnitt.io'
const DEFAULT_NTFY_TOPIC = process.env.NTFY_TOPIC || 'opentask'
const NTFY_CRITICAL_TOPIC = process.env.NTFY_CRITICAL_TOPIC || 'opentask-critical'
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || ''
const APP_URL = process.env.AUTH_URL || 'https://tasks.tk11.mcnitt.io'

const VALID_TYPES = ['individual', 'high', 'bulk', 'critical'] as const
type TestType = (typeof VALID_TYPES)[number]

interface UserNotifConfig {
  ntfy_server: string | null
  ntfy_topic: string | null
  pushover_user_key: string | null
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const type = body.type as string
    if (!VALID_TYPES.includes(type as TestType)) {
      return badRequest(`type must be one of: ${VALID_TYPES.join(', ')}`)
    }

    const db = getDb()
    const config = db
      .prepare('SELECT ntfy_server, ntfy_topic, pushover_user_key FROM users WHERE id = ?')
      .get(user.id) as UserNotifConfig | undefined

    const ntfyServer = config?.ntfy_server || DEFAULT_NTFY_URL
    const ntfyTopic = config?.ntfy_topic || DEFAULT_NTFY_TOPIC
    const icon = `${APP_URL}/icon-192.png`

    if (type === 'individual') {
      await sendTestNtfy(ntfyServer, ntfyTopic, 'This is a test notification from OpenTask.', {
        Title: 'Test: Individual Notification',
        Priority: '3',
        Click: `${APP_URL}`,
        Icon: icon,
      })
    } else if (type === 'high') {
      await sendTestNtfy(ntfyServer, ntfyTopic, 'This is a test high-priority notification.', {
        Title: 'Test: High Priority',
        Priority: '4',
        Tags: 'warning',
        Click: `${APP_URL}`,
        Icon: `${APP_URL}/icon-192-high.png`,
      })
    } else if (type === 'bulk') {
      await sendTestNtfy(ntfyServer, ntfyTopic, '- Buy groceries\n- Call dentist\n- Review notes', {
        Title: 'Test: 3 overdue tasks',
        Priority: '3',
        Click: `${APP_URL}/?filter=overdue`,
        Icon: icon,
        Actions: `view, View All, ${APP_URL}/?filter=overdue`,
      })
    } else if (type === 'critical') {
      // Send critical ntfy (priority 5, separate topic)
      await sendTestNtfy(
        ntfyServer,
        NTFY_CRITICAL_TOPIC,
        'This is a test critical alert from OpenTask.',
        {
          Title: 'Test: Critical Alert',
          Priority: '5',
          Tags: 'rotating_light',
          Click: `${APP_URL}`,
          Icon: `${APP_URL}/icon-192-urgent.png`,
        },
      )

      // Send Pushover if configured
      const pushoverUser = config?.pushover_user_key
      if (PUSHOVER_TOKEN && pushoverUser) {
        await sendTestPushover(pushoverUser)
      }
    }

    return success({ sent: true, type })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'POST /api/notifications/test error:', err)
    return handleError(err)
  }
}

async function sendTestNtfy(
  server: string,
  topic: string,
  message: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${server}/${topic}`, {
    method: 'POST',
    headers,
    body: message,
  })
  if (!res.ok) {
    throw new Error(`ntfy returned ${res.status}: ${await res.text()}`)
  }
}

async function sendTestPushover(pushoverUser: string): Promise<void> {
  const params = new URLSearchParams({
    token: PUSHOVER_TOKEN,
    user: pushoverUser,
    title: 'Test: Critical Alert',
    message: 'This is a test critical alert from OpenTask.',
    priority: '2',
    retry: '300',
    expire: '3600',
  })

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: params,
  })
  if (!res.ok) {
    throw new Error(`Pushover returned ${res.status}: ${await res.text()}`)
  }
}
