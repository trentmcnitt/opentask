/**
 * Time slots API (REDESIGN-V03 §6.0)
 *
 * GET  /api/time-slots - List the user's slots, earliest first
 * POST /api/time-slots - Create a slot
 *
 * The dashboard (§7.3) and the Reminders surface (§6) both group by these, so
 * there is one definition of "morning" rather than two that drift.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { listTimeSlots, createTimeSlot } from '@/core/time-slots'
import { validateTimeSlotCreate } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const slots = listTimeSlots(user.id)
    return success({ time_slots: slots, count: slots.length })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/time-slots error:', err)
    return handleError(err)
  }
})

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const input = validateTimeSlotCreate(await request.json())
    const slot = createTimeSlot(user.id, input.label, input.start_time, input.sort_order)
    return success(slot)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/time-slots error:', err)
    return handleError(err)
  }
})
