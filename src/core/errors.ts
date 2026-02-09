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
