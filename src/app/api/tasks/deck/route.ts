/**
 * On deck (2026-10-20; docs/TASK-MODEL.md § On deck; src/core/tasks/deck.ts)
 *
 * POST /api/tasks/deck — put tasks on deck for a day, or take them off.
 * Body: { ids: [taskId, ...], day? } — `day` is a local calendar date
 * (yyyy-MM-dd), today or later; omitted = today (the calendar day, so a deck
 * made at 1 AM is for the coming day); null = take off deck.
 *
 * One-off tasks only: repeating tasks, reminders, quotas, done and trashed
 * tasks are skipped and counted. A deadline task whose automatic target has
 * arrived, or a day after that target's day, is refused per task. Decking
 * drops a picked target (a deadline task keeps its automatic one), takes the
 * task out of the task queue and marks it considered. One undo entry (`deck`).
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
