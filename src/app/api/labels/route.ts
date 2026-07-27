/**
 * Labels API routes (REDESIGN-V03 §7.2)
 *
 * GET  /api/labels - List the user's registered labels
 * POST /api/labels - Register a label
 *
 * Registration is a discrete act by design: task writes reject unknown labels
 * unless they carry `create_label`, so a typo fails loudly instead of silently
 * forking the taxonomy.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { listLabels, createLabel } from '@/core/labels'
import { validateLabelCreate } from '@/core/validation'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const labels = listLabels(user.id)
    return success({ labels, count: labels.length })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/labels error:', err)
    return handleError(err)
  }
})

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const input = validateLabelCreate(await request.json())
    const label = createLabel(user.id, input.name, {
      facet: input.facet,
      icon: input.icon ?? null,
      color: input.color ?? null,
    })
    return success(label)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/labels error:', err)
    return handleError(err)
  }
})
