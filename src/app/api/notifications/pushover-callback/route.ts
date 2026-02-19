/**
 * Pushover acknowledge callback
 *
 * POST /api/notifications/pushover-callback
 *
 * Pushover sends this when a user acknowledges an emergency-priority alert.
 * Body is application/x-www-form-urlencoded with a `receipt` field.
 * Legitimacy is proven by receipt lookup — no auth middleware needed.
 *
 * Always returns 200 to prevent Pushover from retrying.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/core/db'
import { markDone } from '@/core/tasks'
import { dismissTaskNotifications } from '@/core/notifications/web-push'
import { log } from '@/lib/logger'

interface ReceiptRow {
  receipt: string
  task_id: number
  user_id: number
  acknowledged: number
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const receipt = formData.get('receipt') as string | null

    if (!receipt) {
      log.warn('notifications', 'Pushover callback: missing receipt')
      return NextResponse.json({ ok: true })
    }

    const db = getDb()
    const row = db
      .prepare(
        'SELECT receipt, task_id, user_id, acknowledged FROM pushover_receipts WHERE receipt = ?',
      )
      .get(receipt) as ReceiptRow | undefined

    if (!row) {
      log.warn('notifications', `Pushover callback: unknown receipt ${receipt}`)
      return NextResponse.json({ ok: true })
    }

    if (row.acknowledged) {
      log.info('notifications', `Pushover callback: receipt ${receipt} already acknowledged`)
      return NextResponse.json({ ok: true })
    }

    // Mark the receipt as acknowledged
    db.prepare(
      "UPDATE pushover_receipts SET acknowledged = 1, acknowledged_at = datetime('now') WHERE receipt = ?",
    ).run(receipt)

    // Check if the task is still active (not done/deleted)
    const task = db
      .prepare('SELECT id, done, deleted_at, user_id FROM tasks WHERE id = ?')
      .get(row.task_id) as
      | { id: number; done: number; deleted_at: string | null; user_id: number }
      | undefined

    if (!task || task.done || task.deleted_at) {
      log.info('notifications', `Pushover callback: task ${row.task_id} already done/deleted`)
      return NextResponse.json({ ok: true })
    }

    // Look up user timezone for markDone
    const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(row.user_id) as
      | { timezone: string }
      | undefined

    markDone({
      userId: row.user_id,
      taskId: row.task_id,
      userTimezone: user?.timezone || 'America/Chicago',
    })

    log.info(
      'notifications',
      `Pushover acknowledge: task ${row.task_id} marked done via receipt ${receipt}`,
    )

    // Dismiss Web Push notifications for this task across all devices
    dismissTaskNotifications(row.user_id, [row.task_id]).catch((err) =>
      log.error('notifications', 'Dismiss notification error after Pushover acknowledge:', err),
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    log.error('notifications', 'Pushover callback error:', err)
    // Always return 200 to prevent Pushover retries
    return NextResponse.json({ ok: true })
  }
}
