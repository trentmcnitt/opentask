/**
 * Reminders surface API (REDESIGN-V03 §6)
 *
 * GET /api/reminders - Today's incomplete reminders, grouped by time slot
 *
 * Reminders are prompted thoughts, not actions. They have no debt: never
 * counted in overdue, never in the badge, never fire individually. The time
 * slot notifies, not the item.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { getRemindersBySlot, hasAnyReminders } from '@/core/tasks/reminders'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const groups = getRemindersBySlot(user.id, user.timezone)

    return success({
      groups: groups.map((g) => ({
        slot: g.slot,
        reminders: g.reminders.map(formatTaskResponse),
        count: g.reminders.length,
        // Considered today in this slot — feeds the progress bars (§6).
        considered: g.considered,
      })),
      total: groups.reduce((sum, g) => sum + g.reminders.length, 0),
      considered_total: groups.reduce((sum, g) => sum + g.considered, 0),
      // Whether the user has any reminders at all. Nothing renders it directly —
      // it only picks which empty state the surface shows when today is clear.
      has_any: hasAnyReminders(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/reminders error:', err)
    return handleError(err)
  }
})
