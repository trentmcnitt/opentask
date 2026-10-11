/**
 * Typed error classes for deterministic HTTP status code mapping.
 *
 * Route handlers use handleError() which checks `instanceof AppError` to return
 * the correct status code. Plain `Error` instances become 500 Internal Server Error.
 */

import type { ErrorCode } from '@/types'

export class AppError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode

  constructor(message: string, statusCode: number, code: ErrorCode) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Not found') {
    super(message, 404, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'FORBIDDEN')
    this.name = 'ForbiddenError'
  }
}

/**
 * Missing or invalid credentials. `requireAuth()` throws it; re-exported from
 * `@/core/auth`. Being an AppError, `handleError()` turns it into a 401.
 */
export class AuthError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED')
    this.name = 'AuthError'
  }
}

/**
 * A snooze would move a task's target past its deadline (2026-10-10, spec §4).
 * Never a silent clamp — the app does not reinterpret an explicit instruction
 * — so a single snooze is refused with this (409, `PAST_DEADLINE`) and the
 * client asks first, resending with `allow_past_deadline: true`. Bulk paths
 * skip such a task and report it instead (`skipped_deadline`).
 */
export class PastDeadlineError extends AppError {
  constructor(message: string = PAST_DEADLINE_MESSAGE) {
    super(message, 409, 'PAST_DEADLINE')
    this.name = 'PastDeadlineError'
  }
}

export const PAST_DEADLINE_MESSAGE =
  'That snooze would move the target past the deadline — send allow_past_deadline: true to do it anyway'
