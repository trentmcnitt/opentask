/**
 * POST /api/reminders/move — the one-day move (2026-11-21).
 *
 * Moves reminders (`ids`) and/or quota prompts (`prompt_keys`) waiting today
 * to a later period (`slot_id`) for today only; tomorrow they are home again.
 * One undo entry (`undo_id`). 400 when an item isn't waiting today or the
 * period isn't one that opens later today than the item's own (RULE
 * RM-MOVE-TARGET, src/core/tasks/reminder-move.ts).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError, handleZodError } from '@/lib/api-response'
import { moveForToday } from '@/core/tasks/reminder-move'
import { validateReminderMove } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const input = validateReminderMove(await request.json())
    const result = moveForToday({
      userId: user.id,
      userTimezone: user.timezone,
      ids: input.ids,
      promptKeys: input.prompt_keys,
      slotId: input.slot_id,
    })
    return success({
      moved: result.moved,
      moved_prompts: result.movedPrompts,
      slot_id: result.slot.id,
      slot_label: result.slot.label,
      description: result.description,
      undo_id: requestUndoId(),
    })
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/reminders/move error:', err)
    return handleError(err)
  }
})
