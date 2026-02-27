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
 * Usage:
 *   export const GET = withLogging(async function GET(request, context) { ... })
 */

import { NextRequest } from 'next/server'
import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'

export function withLogging<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>,
): (request: NextRequest, context: C) => Promise<Response> {
  return async (request: NextRequest, context: C) => {
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
      log.error('http', `${method} ${path} threw ${duration}ms [${authType}]`, err)
      notifyError(
        'server-error',
        `${method} ${path} threw`,
        err instanceof Error ? err.message : String(err),
      )
      throw err
    }

    const duration = Math.round(performance.now() - start)
    const status = response.status
    const line = `${method} ${path} ${status} ${duration}ms [${authType}]`

    if (status >= 500) {
      log.error('http', line)
      notifyError('server-error', `${method} ${path} ${status}`, `${duration}ms [${authType}]`)
    } else if (status >= 400) {
      log.warn('http', line)
    } else {
      log.info('http', line)
    }

    return response
  }
}
