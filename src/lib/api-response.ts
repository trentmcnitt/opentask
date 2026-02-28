/**
 * API response utilities for consistent error handling
 */

import { NextResponse } from 'next/server'
import { AppError } from '@/core/errors'
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
 * 503 Service Unavailable - feature disabled or temporarily unavailable
 */
export function serviceUnavailable(message: string = 'Service unavailable'): NextResponse {
  return error(message, 'SERVICE_UNAVAILABLE', 503)
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
 * Handle general errors from core operations.
 *
 * Typed errors (AppError subclasses) produce deterministic status codes.
 * Plain Error instances return 500 with a generic message to avoid leaking internals.
 */
export function handleError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return error(err.message, err.code, err.statusCode)
  }
  if (err instanceof SyntaxError) {
    return badRequest('Invalid JSON in request body')
  }
  if (err instanceof Error) {
    return internalError('Internal server error')
  }
  return internalError('Unknown error')
}
