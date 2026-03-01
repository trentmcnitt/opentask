/**
 * Integration tests for POST /api/errors/report
 *
 * The error report endpoint is intentionally unauthenticated —
 * error reporting must work even when auth is broken.
 */

import { describe, test, expect } from 'vitest'
import { baseUrl } from './helpers'

function post(body: Record<string, unknown>) {
  return fetch(`${baseUrl()}/api/errors/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/errors/report', () => {
  test('accepts valid js_error report', async () => {
    const res = await post({
      type: 'js_error',
      message: 'Cannot read property x of undefined',
      stack: 'Error: Cannot read property x\n    at foo.js:1:1',
      url: 'https://example.com/',
    })
    expect(res.status).toBe(204)
  })

  test('accepts valid react_error report', async () => {
    const res = await post({
      type: 'react_error',
      message: 'Hydration mismatch',
      url: 'https://example.com/tasks/1',
    })
    expect(res.status).toBe(204)
  })

  test('accepts valid promise_rejection report', async () => {
    const res = await post({
      type: 'promise_rejection',
      message: 'fetch failed',
    })
    expect(res.status).toBe(204)
  })

  test('accepts valid sw_error report', async () => {
    const res = await post({
      type: 'sw_error',
      message: 'Service worker push handler failed',
    })
    expect(res.status).toBe(204)
  })

  test('rejects invalid error type', async () => {
    const res = await post({
      type: 'invalid_type',
      message: 'test',
    })
    expect(res.status).toBe(400)
  })

  test('rejects malformed JSON', async () => {
    const res = await fetch(`${baseUrl()}/api/errors/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('works without authentication', async () => {
    // No Bearer token, no session — should still accept the report
    const res = await post({
      type: 'js_error',
      message: 'Unauthenticated error report',
    })
    expect(res.status).toBe(204)
  })

  test('handles missing optional fields gracefully', async () => {
    const res = await post({
      type: 'js_error',
      message: 'Minimal report',
      // no stack, no url
    })
    expect(res.status).toBe(204)
  })
})
