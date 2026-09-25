/**
 * Quota reminders (2026-09-24)
 *
 * POST /api/quota-prompts/did — the square checkbox on a quota prompt: "did
 * it". Logs progress AND considers the prompt. Body: { keys: [prompt_key, ...] }.
 *
 * Idempotent per key, so a double tap or a retried request logs once:
 * a daily quota's prompt #k raises today's count to at least k; any other
 * quota gets +1 unless that key was already done today. One transaction, one
 * undo entry; undo restores the count and brings the prompt back. See
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
      actions: keys.map((key) => ({ key, did: true })),
    })
    return success({
      considered: result.considered,
      did: result.did,
      tasks: result.tasks.map(formatTaskResponse),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/quota-prompts/did error:', err)
    return handleError(err)
  }
})
