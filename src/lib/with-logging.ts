/**
 * HTTP request logging wrapper for API route handlers.
 *
 * Wraps a Next.js route handler to log method, path, response status, duration,
 * and auth type for every request. Uses the `http` namespace so it can be filtered
 * via LOG_NAMESPACES.
 *
 * Log level varies by response status:
 *   - 5xx → error (always visible at default prod level)
 *   - 4xx → warn  (always visible at default prod level)
 *   - 2xx/3xx → info (requires LOG_LEVEL=info to see in prod)
 *
 * It also opens the request context (`src/core/request-context.ts`) around the
 * handler, so the undo and activity logs can record which client made a write,
 * and the log line names that client and, for a Bearer token, the token:
 * `POST /api/tasks/bulk/snooze-overdue 200 41ms [token · shortcut · "shortcuts"]`.
 *
 * Usage:
 *   export const GET = withLogging(async function GET(request, context) { ... })
 */

import { NextRequest } from 'next/server'
import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { CLIENT_HEADER } from '@/lib/client-attribution'
import {
  currentAttribution,
  getRequestContext,
  runWithRequestContext,
} from '@/core/request-context'

/**
 * `[token · shortcut · "shortcuts"]`: the auth type, the client, the token's
 * name. The auth type is what the auth step recorded when it ran (a token in
 * the notification actions' body included), else the guess from the
 * Authorization header.
 */
function authTag(headerAuthType: string): string {
  const { client, tokenName } = currentAttribution()
  const parts = [getRequestContext()?.authMethod ?? headerAuthType, client]
  if (tokenName) parts.push(JSON.stringify(tokenName))
  return `[${parts.join(' · ')}]`
}

export function withLogging<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>,
): (request: NextRequest, context: C) => Promise<Response> {
  return (request: NextRequest, context: C) =>
    runWithRequestContext(
      {
        path: new URL(request.url).pathname,
        header: request.headers.get(CLIENT_HEADER),
      },
      () => handle(request, context),
    )

  async function handle(request: NextRequest, context: C): Promise<Response> {
    const start = performance.now()
    const method = request.method
    const path = new URL(request.url).pathname

    const authHeader = request.headers.get('authorization')
    const authType = authHeader?.startsWith('Bearer ') ? 'token' : authHeader ? 'other' : 'session'

    let response: Response
    try {
      response = await handler(request, context)
    } catch (err) {
      const duration = Math.round(performance.now() - start)
      log.error('http', `${method} ${path} threw ${duration}ms ${authTag(authType)}`, err)
      notifyError(
        'server-error',
        `${method} ${path} threw`,
        err instanceof Error ? err.message : String(err),
      )
      throw err
    }

    const duration = Math.round(performance.now() - start)
    const status = response.status
    const tag = authTag(authType)
    const line = `${method} ${path} ${status} ${duration}ms ${tag}`

    if (status >= 500) {
      log.error('http', line)
      notifyError('server-error', `${method} ${path} ${status}`, `${duration}ms ${tag}`)
    } else if (status >= 400) {
      log.warn('http', line)
    } else {
      log.info('http', line)
    }

    return response
  }
}
