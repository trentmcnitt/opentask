/**
 * Tests for handleError() — typed error classes produce deterministic HTTP status codes.
 *
 * No DB, no HTTP — tests the pure mapping from error types to response status/body.
 */

import { describe, test, expect } from 'vitest'
import { handleError } from '@/lib/api-response'
import { NotFoundError, ValidationError, ForbiddenError, AppError } from '@/core/errors'

describe('handleError', () => {
  test('NotFoundError → 404', async () => {
    const res = handleError(new NotFoundError('Task not found'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Task not found')
    expect(body.code).toBe('NOT_FOUND')
  })

  test('NotFoundError with default message → 404', async () => {
    const res = handleError(new NotFoundError())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Not found')
    expect(body.code).toBe('NOT_FOUND')
  })

  test('ValidationError → 400', async () => {
    const res = handleError(new ValidationError('Invalid input'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid input')
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  test('ForbiddenError → 403', async () => {
    const res = handleError(new ForbiddenError('Access denied to project'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Access denied to project')
    expect(body.code).toBe('FORBIDDEN')
  })

  test('ForbiddenError with default message → 403', async () => {
    const res = handleError(new ForbiddenError())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Access denied')
    expect(body.code).toBe('FORBIDDEN')
  })

  test('plain Error → 500 with generic message (no internal leak)', async () => {
    const res = handleError(new Error('Cannot find config'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')
    expect(body.code).toBe('INTERNAL_ERROR')
    // Must NOT contain the original error message
    expect(body.error).not.toContain('Cannot find config')
  })

  test('unknown error (string) → 500', async () => {
    const res = handleError('something went wrong')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Unknown error')
    expect(body.code).toBe('INTERNAL_ERROR')
  })

  test('unknown error (null) → 500', async () => {
    const res = handleError(null)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Unknown error')
    expect(body.code).toBe('INTERNAL_ERROR')
  })

  test('AppError base class with custom status → correct mapping', async () => {
    const res = handleError(new AppError('Rate limited', 429, 'VALIDATION_ERROR'))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('Rate limited')
  })
})
