/**
 * Single time slot API (Settings → Reminder periods, 2026-09-24)
 *
 * PATCH  /api/time-slots/:id - Rename and/or move a slot's start
 * DELETE /api/time-slots/:id - Remove a slot
 *
 * Moving or removing a slot moves its reminders so they stay in (or find) a
 * slot, atomically, as one undo entry that also restores the slot itself.
 * The response's `undo_id` names that entry (null for a rename, which moves
 * nothing). Rules and judgment calls: src/core/time-slots/edit.ts.
 *
 * Another user's slot id is a 404, exactly like a missing one.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError, handleZodError } from '@/lib/api-response'
import { updateTimeSlot, deleteTimeSlot } from '@/core/time-slots/edit'
import { validateTimeSlotUpdate } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import type { RouteContext } from '@/types/api'

function parseSlotId(raw: string): number | null {
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : null
}

export const PATCH = withLogging(async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const slotId = parseSlotId(id)
    if (slotId === null) return badRequest('Invalid time slot ID')
    const input = validateTimeSlotUpdate(await request.json())
    const result = updateTimeSlot({
      userId: user.id,
      userTimezone: user.timezone,
      slotId,
      input,
    })
    return success(result)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'PATCH /api/time-slots/:id error:', err)
    return handleError(err)
  }
})

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const user = await requireAuth(request)
    const { id } = await context.params
    const slotId = parseSlotId(id)
    if (slotId === null) return badRequest('Invalid time slot ID')
    const result = deleteTimeSlot({ userId: user.id, userTimezone: user.timezone, slotId })
    return success(result)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/time-slots/:id error:', err)
    return handleError(err)
  }
})
