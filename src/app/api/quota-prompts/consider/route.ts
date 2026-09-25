/**
 * Quota reminders (2026-09-24)
 *
 * POST /api/quota-prompts/consider — the round circle on a quota prompt:
 * handled for today, NO progress logged. Body: { keys: [prompt_key, ...] }.
 * One transaction, one undo entry for all of them; idempotent (considering a
 * considered prompt changes nothing). Keys from another day, or for a quota
 * that is not the caller's own, refuse the whole request. See
 * src/core/tasks/quota-prompt-actions.ts.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { validatePromptKeys } from '@/core/validation'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { keys } = validatePromptKeys(await request.json())
    const result = actOnPrompts({
      userId: user.id,
      userTimezone: user.timezone,
      actions: keys.map((key) => ({ key, did: false })),
    })
    return success({
      considered: result.considered,
      did: result.did,
      tasks: result.tasks.map(formatTaskResponse),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/quota-prompts/consider error:', err)
    return handleError(err)
  }
})
