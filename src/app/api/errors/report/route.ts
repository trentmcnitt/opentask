/**
 * Client-side error reporting endpoint
 *
 * Receives error reports from the browser (uncaught exceptions, promise
 * rejections, React component crashes, service worker errors) and
 * forwards them to ntfy via notifyError.
 *
 * No authentication required — error reporting must work even when
 * the session is expired or auth is broken. Rate-limited server-side
 * via notifyError's per-category rate limiter (5 min window).
 */

import { NextRequest } from 'next/server'
import { notifyError } from '@/lib/error-notify'
import { log } from '@/lib/logger'

const VALID_TYPES = new Set(['js_error', 'promise_rejection', 'react_error', 'sw_error'])

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    const type = String(body.type || 'unknown')
    const message = String(body.message || 'Unknown error').slice(0, 500)
    const stack = body.stack ? String(body.stack).slice(0, 2000) : undefined
    const url = body.url ? String(body.url).slice(0, 500) : undefined

    if (!VALID_TYPES.has(type)) {
      return new Response(null, { status: 400 })
    }

    const details = [
      message,
      url ? `Page: ${url}` : null,
      stack ? `Stack: ${stack.split('\n').slice(0, 5).join('\n')}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    log.warn('http', `Client ${type}: ${message}${url ? ` (${url})` : ''}`)
    notifyError('client-error', `Client ${type}`, details)

    return new Response(null, { status: 204 })
  } catch {
    return new Response(null, { status: 400 })
  }
}
