/**
 * Quota reminders — put back (2026-09-25)
 *
 * POST /api/quota-prompts/restore — the filled dashed circle on a handled
 * prompt in a "considered" list (the web's "Show N considered", the
 * Reminders widget's DONE section). The prompt waits for today again; if it
 * was "did it", exactly the progress that did-it added is taken back. Body:
 * { keys: [prompt_key, ...] }. One transaction, one undo entry; a key that is
 * already waiting changes nothing. Keys from another day, or for a quota that
 * is not the caller's own, refuse the whole request (400). Never /undone —
 * a quota refuses it. See src/core/tasks/quota-prompt-actions.ts.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { restorePrompts } from '@/core/tasks/quota-prompt-actions'
import { validatePromptKeys } from '@/core/validation'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { keys } = validatePromptKeys(await request.json())
    const result = restorePrompts({ userId: user.id, userTimezone: user.timezone, keys })
    return success({
      restored: result.restored,
      tasks: result.tasks.map(formatTaskResponse),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/quota-prompts/restore error:', err)
    return handleError(err)
  }
})
