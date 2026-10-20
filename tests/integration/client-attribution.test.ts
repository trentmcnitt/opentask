/**
 * Client attribution integration tests (2026-10-20)
 *
 * Over real HTTP: a write records which client made it — from the
 * X-OpenTask-Client header, else inferred (`inferClient`) — in both the undo
 * log and the activity log, and GET /api/undo/history returns it.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import path from 'path'
import Database from 'better-sqlite3'
import { apiFetch, resetTestData, baseUrl, sessionCookieFromToken, TOKEN_A } from './helpers'

interface Attribution {
  client: string | null
  token_name: string | null
}

function query<T>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(path.join(process.cwd(), 'data', 'test-integration.db'), {
    readonly: true,
  })
  try {
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

/** Make task 1 overdue, so a sweep has something to move. */
async function makeOverdue() {
  const res = await apiFetch('/api/tasks/1', {
    method: 'PATCH',
    body: { due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), priority: 0 },
  })
  expect(res.status).toBe(200)
}

async function sweep(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
    method: 'POST',
    body: { delta_minutes: 60, ...body },
    headers,
  })
  expect(res.status).toBe(200)
  expect((await res.json()).data.tasks_affected).toBeGreaterThan(0)
}

function latestUndo(): Attribution & { action: string } {
  return query<Attribution & { action: string }>(
    'SELECT action, client, token_name FROM undo_log WHERE user_id = 1 ORDER BY id DESC LIMIT 1',
  )[0]
}

function latestActivity(action: string): Attribution {
  return query<Attribution>(
    'SELECT client, token_name FROM activity_log WHERE user_id = 1 AND action = ? ORDER BY id DESC LIMIT 1',
    action,
  )[0]
}

describe('Client attribution', () => {
  beforeEach(async () => {
    await resetTestData()
    await makeOverdue()
  })

  test('token sweep without the header: unknown client, token name recorded', async () => {
    await sweep()
    // 'Test Token A' is neither a Shortcuts, CLI nor iOS token.
    expect(latestUndo()).toEqual({
      action: 'bulk_snooze',
      client: 'unknown',
      token_name: 'Test Token A',
    })
    expect(latestActivity('snooze')).toEqual({ client: 'unknown', token_name: 'Test Token A' })
  })

  test('token sweep with the header: the header names the client', async () => {
    await sweep({ 'X-OpenTask-Client': 'watch' })
    expect(latestUndo()).toMatchObject({ client: 'watch', token_name: 'Test Token A' })
    expect(latestActivity('snooze')).toEqual({ client: 'watch', token_name: 'Test Token A' })
  })

  test('notify: false without the header is a shortcut', async () => {
    await sweep({}, { notify: false })
    expect(latestUndo()).toMatchObject({ client: 'shortcut', token_name: 'Test Token A' })
  })

  test('an unrecognised header value is unknown and never rejected', async () => {
    await sweep({ 'X-OpenTask-Client': 'toaster' })
    expect(latestUndo()).toMatchObject({ client: 'unknown' })
  })

  test('a session-cookie write is web, with no token name', async () => {
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await fetch(`${baseUrl()}/api/tasks/bulk/snooze-overdue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ delta_minutes: 60 }),
    })
    expect(res.status).toBe(200)
    expect(latestUndo()).toMatchObject({ client: 'web', token_name: null })
    expect(latestActivity('snooze')).toEqual({ client: 'web', token_name: null })
  })

  test('a notification action (token in the body) is notification', async () => {
    const res = await fetch(`${baseUrl()}/api/notifications/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', task_id: 1, token: TOKEN_A }),
    })
    expect(res.status).toBe(200)
    expect(latestUndo()).toMatchObject({ client: 'notification', token_name: 'Test Token A' })
  })

  test('GET /api/undo/history returns client and token_name', async () => {
    await sweep({ 'X-OpenTask-Client': 'ios' })
    const res = await apiFetch('/api/undo/history?limit=1')
    expect(res.status).toBe(200)
    const entry = (await res.json()).data.history[0]
    expect(entry.action).toBe('bulk_snooze')
    expect(entry.client).toBe('ios')
    expect(entry.token_name).toBe('Test Token A')
  })

  test('Bearer auth stamps api_tokens.last_used_at', async () => {
    const [row] = query<{ last_used_at: string | null }>(
      "SELECT last_used_at FROM api_tokens WHERE name = 'Test Token A'",
    )
    expect(row.last_used_at).not.toBeNull()
    expect(Date.now() - Date.parse(row.last_used_at!)).toBeLessThan(5 * 60 * 1000)
  })
})
