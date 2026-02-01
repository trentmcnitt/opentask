/**
 * API response utilities for consistent error handling
 */

import { NextResponse } from 'next/server'
import type { ErrorCode } from '@/types'

/**
 * Create a successful JSON response
 */
export function success<T>(data: T, status: number = 200): NextResponse {
  return NextResponse.json({ data }, { status })
}

/**
 * Create an error JSON response
 */
export function error(
  message: string,
  code: ErrorCode,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    {
      error: message,
      code,
      details,
    },
    { status },
  )
}

/**
 * 400 Bad Request - validation errors, invalid input
 */
export function badRequest(message: string, details?: Record<string, unknown>): NextResponse {
  return error(message, 'VALIDATION_ERROR', 400, details)
}

/**
 * 401 Unauthorized - authentication required
 */
export function unauthorized(message: string = 'Authentication required'): NextResponse {
  return error(message, 'UNAUTHORIZED', 401)
}

/**
 * 403 Forbidden - authenticated but not allowed
 */
export function forbidden(message: string = 'Access denied'): NextResponse {
  return error(message, 'FORBIDDEN', 403)
}

/**
 * 404 Not Found
 */
export function notFound(message: string, details?: Record<string, unknown>): NextResponse {
  return error(message, 'NOT_FOUND', 404, details)
}

/**
 * 409 Conflict - e.g., stale review session
 */
export function conflict(message: string, details?: Record<string, unknown>): NextResponse {
  return error(message, 'CONFLICT', 409, details)
}

/**
 * 500 Internal Server Error
 */
export function internalError(message: string = 'Internal server error'): NextResponse {
  return error(message, 'INTERNAL_ERROR', 500)
}

/**
 * Handle Zod validation errors
 */
export function handleZodError(err: unknown): NextResponse {
  if (err && typeof err === 'object' && 'issues' in err) {
    const zodError = err as { issues: Array<{ path: (string | number)[]; message: string }> }
    const details: Record<string, string> = {}
    for (const issue of zodError.issues) {
      const path = issue.path.join('.')
      details[path] = issue.message
    }
    return badRequest('Validation failed', details)
  }
  return badRequest(String(err))
}

/**
 * Handle general errors from core operations
 */
export function handleError(err: unknown): NextResponse {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // Check for specific error patterns
    if (msg.includes('not found')) {
      return notFound(err.message)
    }
    if (msg.includes('access denied') || msg.includes('forbidden')) {
      return forbidden(err.message)
    }
    if (
      msg.includes('invalid') ||
      msg.includes('must be') ||
      msg.includes('cannot') ||
      msg.includes('already')
    ) {
      return badRequest(err.message)
    }
    return internalError(err.message)
  }
  return internalError('Unknown error')
}
