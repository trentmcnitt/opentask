/**
 * Process (2026-10-10 task model, spec §5)
 *
 * GET /api/process — what the in-app Process button works through, computed by
 * rule (no AI, so it works with AI off; `src/lib/process-rules.ts`):
 * - `inbox`: open one-off tasks still in the Inbox project, oldest first
 * - `growth`: tasks long past their horizon, each `{ task, from, to,
 *   days_on_horizon, can_act }` — `from` null means unset (read as weeks),
 *   `can_act` (P2+) offers "do it" / "raise priority" beside "grow"
 * - `stale_targets` / `stale_targets_with_deadline`: tasks at 3× attempts or
 *   more (spec §7 — local days over target), `{ task, attempts }`; the
 *   deadline ones apart so a client's nag is never stopped by default
 *
 * Read-only. The writes go through PATCH, bulk edit (`affirm_horizon` keeps a
 * horizon and restarts its clock), target-today and DELETE.
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, handleError } from '@/lib/api-response'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { getProcessData } from '@/core/tasks/process'
import type { Task } from '@/types'

const aged =
  (timezone: string) =>
  ({ task, attempts }: { task: Task; attempts: number }) => ({
    task: formatTaskResponse(task, timezone),
    attempts,
  })

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const data = getProcessData(user.id, user.timezone)
    return success({
      inbox_project_id: data.inbox_project_id,
      inbox: data.inbox.map((t) => formatTaskResponse(t, user.timezone)),
      growth: data.growth.map(({ task, ...ask }) => ({
        task: formatTaskResponse(task, user.timezone),
        ...ask,
      })),
      stale_targets: data.stale_targets.map(aged(user.timezone)),
      stale_targets_with_deadline: data.stale_targets_with_deadline.map(aged(user.timezone)),
    })
  } catch (err) {
    if (!(err instanceof AppError)) log.error('api', 'GET /api/process error:', err)
    return handleError(err)
  }
})
