/**
 * On deck (2026-10-20; docs/TASK-MODEL.md § On deck; src/core/tasks/deck.ts)
 *
 * POST /api/tasks/deck — put tasks on deck for a day, or take them off.
 * Body: { ids: [taskId, ...], day? } — `day` is the user's OpenTask date
 * (yyyy-MM-dd; "Day starts at", 2026-10-24), today or later; omitted = today's
 * OpenTask date (so a deck made at 1 AM, before a 3:00 AM day start, is for the
 * day that is ending); null = take off deck.
 *
 * Reminders, quotas, done and trashed tasks are skipped and counted; a
 * repeating task decks its current occurrence (since 2026-10-20 —
 * `skipped_recurring` stays in the answer, always 0). A deadline task can be
 * decked for any day up to and including its deadline's OpenTask day while
 * the deadline is ahead (the deadlines page, 2026-10-22); a later day, or a
 * passed deadline, is refused per task. Decking drops a picked target, takes
 * the task out of the task queue and marks it considered — except a row the
 * deadlines page keeps (`deckKeepsPageRow`). One undo entry (`deck`); see
 * `src/core/tasks/deck.ts` for the rules in full.
 *
 * Response: { day, decked, undecked, skipped_recurring, skipped_reminder,
 * skipped_quota, skipped_done, skipped_trashed, refused: [{ id, reason }],
 * summary }. 409 when the server's task queue is off.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { deckTasks } from '@/core/tasks/deck'
import { validateDeck } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { ids, day } = validateDeck(await request.json())
    return success(deckTasks({ userId: user.id, timezone: user.timezone, ids, day }))
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/tasks/deck error:', err)
    return handleError(err)
  }
})
