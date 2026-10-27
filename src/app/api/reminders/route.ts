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
import { getTaskSegments } from '@/core/tasks/task-segments'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const now = new Date()
    // `?queue=1` (task-queue PR 3): this client shows the task queue's panels
    // (`queue_today`, `queue_previous`). The web sends it; a native build that
    // predates the queue does not, and gets the queued tasks left out (an
    // unknown segment kind would show there as a page of its own).
    const queuePanels = request.nextUrl.searchParams.get('queue') === '1'
    // `?deck=1` (On deck, 2026-10-20): this client draws a future deck's
    // Upcoming row ("On deck Sat Oct 24"). Without it a decked task is simply
    // absent from Upcoming — a shipped native build would draw a dateless row.
    const deckRows = request.nextUrl.searchParams.get('deck') === '1'
    // `?deadlines=1` (the deadlines page, 2026-10-22): this client draws the
    // `deadlines` segment (and leaves such tasks out of Upcoming: rule 3,
    // 2026-10-25). Without it (a
    // shipped native build, whose SegmentKind would list an unknown kind as a
    // page) a target-less deadline one-off stays in its horizon segment.
    const deadlineRows = request.nextUrl.searchParams.get('deadlines') === '1'
    // `?handled=1` (2026-10-22, the day roster — src/core/tasks/segment-roster.ts):
    // this client keeps a segment's "N of M" fixed for the day. Rows that left a
    // segment today handled (decked, targeted, done) come back as considered
    // rows with `segment_left`. Without it the segments are as before.
    const handledRows = request.nextUrl.searchParams.get('handled') === '1'
    // `?fill=1` (2026-10-24, Trent: "always show every queue segment, every
    // day, in fixed positions"): every segment kind this caller draws comes
    // back, an empty one with no rows (`fill` in getTaskSegments). The web
    // sends it; without it (a native build) a segment comes only on a day it
    // has rows, as before.
    const fill = request.nextUrl.searchParams.get('fill') === '1'
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
        reminders: g.reminders.map((t) => formatTaskResponse(t, user.timezone)),
        count: g.reminders.length,
        // Considered today in this slot — feeds the progress bars (§6) — and
        // the items themselves, so one can be put back (POST /tasks/:id/undone).
        considered: g.considered,
        considered_items: g.consideredItems.map((t) => formatTaskResponse(t, user.timezone)),
        prompts,
        prompts_waiting: waiting,
        prompts_considered: prompts.length - waiting,
      }
    })

    return success({
      groups: payloadGroups,
      // Reminders with no occurrence today (a weekly one on its off day), so
      // every thought stays reachable from its own surface. Not in the counts.
      not_today: notToday.map((t) => formatTaskResponse(t, user.timezone)),
      total: groups.reduce((sum, g) => sum + g.reminders.length, 0),
      considered_total: groups.reduce((sum, g) => sum + g.considered, 0),
      prompts_total: promptsTotal,
      prompts_considered_total: promptsConsideredTotal,
      // Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments): one-off
      // tasks with no target, one segment per horizon, plus Upcoming
      // (`horizon: "upcoming"`, 2026-10-12): targeted tasks on their heads-up
      // days, repeating ones included. A TOP-LEVEL array, deliberately not inside
      // `groups` — a native build that predates it ignores the key, and its
      // "Complete all" can never reach a real task. None of these counts
      // include task rows: segments never feed the nav badge or the slot
      // notifications (the web's headline counts them itself, as its own
      // tasks half — `headlineCounts`). With the task queue on, the queue's
      // two panels come first — only for a caller that sent `?queue=1`.
      task_segments: getTaskSegments(user.id, user.timezone, now, {
        queuePanels,
        deckRows,
        handledRows,
        deadlineRows,
        fill,
      }).map((seg) => ({
        horizon: seg.horizon,
        tasks: seg.tasks.map(({ task, state, left, safetyNet, seen, section }) => ({
          ...formatTaskResponse(task, user.timezone),
          segment_state: state,
          // A repeating task's occurrence (2026-10-12, Upcoming only). Clients
          // hide Today, its picker and Remove target on these rows: target-today
          // skips them (`skipped_recurring`), and removing the target would
          // take the recurrence with it.
          recurring: task.rrule !== null,
          // How a row that left the segment today was handled (`?handled=1`
          // only): 'done' | 'deck' | 'target' | 'considered'. Such a row is
          // `considered`, counted in the segment's N and M, with no put-back.
          ...(left ? { segment_left: left } : {}),
          // The deadlines page (`?deadlines=1` only, 2026-10-22): `safety_net`
          // — from the day before the deadline, seeing the row does not
          // silence it (draw the circle non-silencing; Defer hidden); `seen`
          // — considered this OpenTask day.
          ...(seg.horizon === 'deadlines' ? { safety_net: !!safetyNet, seen: !!seen } : {}),
          // Upcoming's section (2026-10-25, the Upcoming split; always sent on
          // an Upcoming row): 'tomorrow' — the day before its anchor — or
          // 'later'. Tomorrow's rows come first. A left row (`segment_left`)
          // carries the section the day roster remembered. One kind, no new
          // kinds: a shipped native build lists both sections' rows as one
          // Upcoming page and ignores the key.
          ...(seg.horizon === 'upcoming' ? { upcoming_section: section ?? 'later' } : {}),
        })),
        waiting: seg.waiting,
        considered: seg.considered,
        deferred: seg.deferred,
        nudge: seg.nudge,
      })),
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
