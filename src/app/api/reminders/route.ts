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
import { getRemindersBySlot, getRemindersNotToday, hasAnyReminders } from '@/core/tasks/reminders'
import { getQuotaPromptsBySlot, promptWaiting } from '@/core/tasks/quota-prompts'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const now = new Date()
    const groups = getRemindersBySlot(user.id, user.timezone, now)
    const notToday = getRemindersNotToday(user.id, user.timezone, now)
    const promptsBySlot = getQuotaPromptsBySlot(user.id, user.timezone, now)
    let promptsTotal = 0
    let promptsConsideredTotal = 0

    const payloadGroups = groups.map((g) => {
      // Quota reminders (2026-09-24): a SEPARATE array, so `reminders`,
      // `count`, `considered`, `total` and `considered_total` mean exactly
      // what they meant before — native builds that predate prompts ignore
      // this field and keep working. Every prompt assigned to the slot today
      // is here, handled ones too, flagged; a client counts waiting ones as
      // `!considered && !done`.
      const prompts = promptsBySlot.get(g.slot?.id ?? null) ?? []
      const waiting = prompts.filter(promptWaiting).length
      promptsTotal += waiting
      promptsConsideredTotal += prompts.length - waiting
      return {
        slot: g.slot,
        reminders: g.reminders.map(formatTaskResponse),
        count: g.reminders.length,
        // Considered today in this slot — feeds the progress bars (§6) — and
        // the items themselves, so one can be put back (POST /tasks/:id/undone).
        considered: g.considered,
        considered_items: g.consideredItems.map(formatTaskResponse),
        prompts,
        prompts_waiting: waiting,
        prompts_considered: prompts.length - waiting,
      }
    })

    return success({
      groups: payloadGroups,
      // Reminders with no occurrence today (a weekly one on its off day), so
      // every thought stays reachable from its own surface. Not in the counts.
      not_today: notToday.map(formatTaskResponse),
      total: groups.reduce((sum, g) => sum + g.reminders.length, 0),
      considered_total: groups.reduce((sum, g) => sum + g.considered, 0),
      prompts_total: promptsTotal,
      prompts_considered_total: promptsConsideredTotal,
      // Whether the user has any reminders at all. Nothing renders it directly —
      // it only picks which empty state the surface shows when today is clear.
      // Reminder-only, as native builds read it; a day with prompts is never
      // "clear" on the web surface (handled prompts still count), so it needs
      // no prompt term.
      has_any: hasAnyReminders(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/reminders error:', err)
    return handleError(err)
  }
})
