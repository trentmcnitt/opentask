/**
 * Quotas surface API (REDESIGN-V03 §5)
 *
 * GET /api/quotas - Every open quota for the user
 *
 * The sibling of GET /api/reminders. A surface gets its own endpoint so it can
 * be refreshed on every sync event without dragging the whole task list across
 * the network — a quota's +1 emits a sync event, so this is on the hot path for
 * the one gesture the surface exists for.
 *
 * Order is deliberately the client's: `trackedItems()` sorts quotas
 * alphabetically so a count changing never moves a row under the user's finger,
 * and the dashboard's Track panel renders the same eight things through the same
 * function. One sort, one source of truth.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError } from '@/lib/api-response'
import { getQuotas, hasAnyQuotas } from '@/core/tasks/quotas'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const quotas = getQuotas(user.id)

    return success({
      quotas: quotas.map(formatTaskResponse),
      total: quotas.length,
      // Nothing renders this directly — it only picks which empty state the
      // surface shows. Same contract as `has_any` on /api/reminders.
      has_any: hasAnyQuotas(user.id),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/quotas error:', err)
    return handleError(err)
  }
})
