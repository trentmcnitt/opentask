/**
 * Signed quick action endpoint
 *
 * GET /api/notifications/quick-action?task=123&user=1&action=done&exp=<unix>&sig=<hex>
 *
 * Clicked as a link from Pushover notification body (opens in Safari).
 * Verifies HMAC signature + expiry, performs the action, returns a simple HTML confirmation page.
 * No auth middleware — legitimacy proven by HMAC signature.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/core/db'
import { markDone, snoozeTask } from '@/core/tasks'
import { verifySignedActionUrl } from '@/core/notifications/signed-url'
import { dismissTaskNotifications } from '@/core/notifications/web-push'
import { log } from '@/lib/logger'

function htmlResponse(title: string, message: string, status = 200): NextResponse {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb;color:#18181b}
.card{text-align:center;padding:2rem;max-width:400px}.icon{font-size:3rem;margin-bottom:1rem}.msg{color:#71717a;margin-top:0.5rem}</style>
</head><body><div class="card"><div class="icon">${status === 200 ? '&#10003;' : '&#9888;'}</div><h2>${title}</h2><p class="msg">${message}</p></div></body></html>`
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const taskId = parseInt(searchParams.get('task') || '', 10)
    const userId = parseInt(searchParams.get('user') || '', 10)
    const action = searchParams.get('action') || ''
    const exp = parseInt(searchParams.get('exp') || '', 10)
    const sig = searchParams.get('sig') || ''

    if (isNaN(taskId) || isNaN(userId) || !action || isNaN(exp) || !sig) {
      return htmlResponse('Invalid Link', 'This action link is malformed.', 400)
    }

    if (!verifySignedActionUrl(taskId, userId, action, exp, sig)) {
      return htmlResponse(
        'Link Expired',
        'This action link has expired or is invalid. Open the task in OpenTask to take action.',
        403,
      )
    }

    const db = getDb()

    // Verify task is still active
    const task = db.prepare('SELECT id, done, deleted_at FROM tasks WHERE id = ?').get(taskId) as
      | { id: number; done: number; deleted_at: string | null }
      | undefined

    if (!task) {
      return htmlResponse('Task Not Found', 'This task no longer exists.')
    }
    if (task.done) {
      return htmlResponse('Already Done', 'This task has already been completed.')
    }
    if (task.deleted_at) {
      return htmlResponse('Task Deleted', 'This task has been deleted.')
    }

    // Look up user timezone
    const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
      | { timezone: string }
      | undefined
    const timezone = user?.timezone || 'America/Chicago'

    let resultMessage: string

    switch (action) {
      case 'done': {
        markDone({ userId, taskId, userTimezone: timezone })
        resultMessage = 'Task marked as done.'
        break
      }
      case 'snooze30': {
        const until = new Date(Date.now() + 30 * 60 * 1000)
        snoozeTask({ userId, userTimezone: timezone, taskId, until: until.toISOString() })
        resultMessage = 'Task snoozed for 30 minutes.'
        break
      }
      case 'snooze': {
        const until = new Date(Date.now() + 60 * 60 * 1000)
        until.setMinutes(0, 0, 0)
        snoozeTask({ userId, userTimezone: timezone, taskId, until: until.toISOString() })
        resultMessage = 'Task snoozed for 1 hour.'
        break
      }
      case 'snooze2h': {
        const until = new Date(Date.now() + 2 * 60 * 60 * 1000)
        until.setMinutes(0, 0, 0)
        snoozeTask({ userId, userTimezone: timezone, taskId, until: until.toISOString() })
        resultMessage = 'Task snoozed for 2 hours.'
        break
      }
      default:
        return htmlResponse('Unknown Action', `Action "${action}" is not recognized.`, 400)
    }

    log.info('notifications', `Quick action: ${action} on task ${taskId} by user ${userId}`)

    // Dismiss Web Push notifications for this task across all devices
    dismissTaskNotifications(userId, [taskId]).catch((err) =>
      log.error('notifications', 'Dismiss notification error after quick action:', err),
    )

    return htmlResponse('Done', resultMessage)
  } catch (err) {
    log.error('notifications', 'Quick action error:', err)
    return htmlResponse('Error', 'Something went wrong. Please try again in OpenTask.', 500)
  }
}
