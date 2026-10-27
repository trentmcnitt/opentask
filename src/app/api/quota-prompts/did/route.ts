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
 *
 * CSRF (Push PR 4, 2026-10-26): the named quota-prompt push's "Did it" button
 * (public/sw.js) calls this with the session cookie alone, so a request
 * authenticated by the cookie — or by the proxy header, which rides the
 * proxy's own cookie — must also be same-origin (`isCrossSiteCookieRequest`,
 * src/core/auth/same-origin.ts), else 403. Bearer requests (the native apps,
 * integrations) are not checked.
 */

import { NextRequest } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { isCrossSiteCookieRequest } from '@/core/auth/same-origin'
import { success, unauthorized, forbidden, handleError, handleZodError } from '@/lib/api-response'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { validatePromptKeys } from '@/core/validation'
import { formatTaskResponse } from '@/lib/format-task'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { ZodError } from 'zod'
import { requestUndoId } from '@/core/request-context'

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    if (isCrossSiteCookieRequest(request)) {
      log.warn(
        'api',
        `POST /api/quota-prompts/did refused: cookie or proxy request for user ${user.id} is not same-origin ` +
          `(Origin ${request.headers.get('origin') ?? 'none'}, ` +
          `Sec-Fetch-Site ${request.headers.get('sec-fetch-site') ?? 'none'})`,
      )
      return forbidden('Cross-site request refused')
    }
    const { keys, source } = validatePromptKeys(await request.json())
    const result = actOnPrompts({
      userId: user.id,
      userTimezone: user.timezone,
      actions: keys.map((key) => ({ key, did: true })),
      source,
    })
    return success({
      considered: result.considered,
      did: result.did,
      tasks: result.tasks.map((t) => formatTaskResponse(t, user.timezone)),
      undo_id: requestUndoId(),
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/quota-prompts/did error:', err)
    return handleError(err)
  }
})
