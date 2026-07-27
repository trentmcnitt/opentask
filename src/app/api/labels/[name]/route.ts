/**
 * Single-label API route (REDESIGN-V03 §7.2)
 *
 * DELETE /api/labels/:name - Remove a label from the registry
 *
 * Deregistering does NOT strip the label from tasks that already carry it.
 * §7.2's rule is that only NEWLY added labels are checked against the registry,
 * so those tasks stay editable; the label simply can't be applied to anything
 * new. Rewriting user data as a side effect of a registry edit would be a much
 * bigger action than the verb implies.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, notFound, handleError } from '@/lib/api-response'
import { deleteLabel } from '@/core/labels'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { NameRouteContext } from '@/types/api'

export const DELETE = withLogging(async function DELETE(
  request: NextRequest,
  context: NameRouteContext,
) {
  try {
    const user = await requireAuth(request)
    const { name } = await context.params
    const removed = deleteLabel(user.id, decodeURIComponent(name))
    if (!removed) return notFound('Label not found')
    return success({ deleted: true, name: decodeURIComponent(name) })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'DELETE /api/labels/:name error:', err)
    return handleError(err)
  }
})
