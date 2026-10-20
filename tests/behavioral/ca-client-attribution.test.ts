/**
 * Client attribution (2026-10-20)
 *
 * Every undo_log and activity_log row records which client made it. These
 * tests cover the inference table (`inferClient`), the request context
 * reaching `logAction` / `logActivity` inside `withTransaction` (through the
 * real `withLogging` wrapper), `system` for writes outside a request and
 * inside `runAsSystem`, and the throttled `api_tokens.last_used_at`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import { bulkSnooze } from '@/core/tasks/bulk'
import { incrementProgress } from '@/core/tasks/progress'
import { createApiToken } from '@/core/auth/tokens'
import { validateBearerToken } from '@/core/auth/bearer'
import { currentAttribution, runAsSystem, setClientHint } from '@/core/request-context'
import { inferClient, clientLabel, type ClientInferenceInput } from '@/lib/client-attribution'
import { withLogging } from '@/lib/with-logging'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

const BASE: ClientInferenceInput = {
  header: null,
  path: '/api/tasks',
  authMethod: null,
  tokenName: null,
  tokenSource: null,
  hint: null,
}

describe('inferClient', () => {
  // [description, input overrides, expected]. The token names are the real
  // ones in use (shortcuts, Claude Code, iOS App, hub, Automation).
  const cases: Array<[string, Partial<ClientInferenceInput>, string]> = [
    ['header wins over everything', { header: 'watch', authMethod: 'session' }, 'watch'],
    ['header is case- and space-insensitive', { header: ' Widget ' }, 'widget'],
    ['header desk', { header: 'desk', authMethod: 'token', tokenSource: 'ios' }, 'desk'],
    [
      'unknown header value is unknown, not inferred',
      { header: 'toaster', authMethod: 'session' },
      'unknown',
    ],
    ['empty header is unknown', { header: '', authMethod: 'session' }, 'unknown'],
    ['header cannot claim system', { header: 'system' }, 'unknown'],
    [
      'notification actions path',
      {
        path: '/api/notifications/actions',
        authMethod: 'token',
        tokenName: 'iOS App',
        tokenSource: 'ios',
      },
      'notification',
    ],
    [
      'snooze-overdue notify:false hint beats the ios token',
      {
        path: '/api/tasks/bulk/snooze-overdue',
        hint: 'shortcut',
        authMethod: 'token',
        tokenName: 'iOS App',
        tokenSource: 'ios',
      },
      'shortcut',
    ],
    ['session cookie is web', { authMethod: 'session' }, 'web'],
    ['proxy login is web', { authMethod: 'proxy' }, 'web'],
    [
      'manual "shortcuts" token',
      { authMethod: 'token', tokenName: 'shortcuts', tokenSource: 'manual' },
      'shortcut',
    ],
    [
      'manual "My Shortcut" token',
      { authMethod: 'token', tokenName: 'My Shortcut', tokenSource: 'manual' },
      'shortcut',
    ],
    [
      '"Claude Code" token',
      { authMethod: 'token', tokenName: 'Claude Code', tokenSource: 'manual' },
      'cli',
    ],
    ['"hub" token', { authMethod: 'token', tokenName: 'hub', tokenSource: 'manual' }, 'cli'],
    ['"cli" token', { authMethod: 'token', tokenName: 'laptop cli', tokenSource: 'manual' }, 'cli'],
    ['"iOS App" token', { authMethod: 'token', tokenName: 'iOS App', tokenSource: 'ios' }, 'ios'],
    [
      '"Automation" token',
      { authMethod: 'token', tokenName: 'Automation', tokenSource: 'manual' },
      'unknown',
    ],
    [
      '"github" is not "hub"',
      { authMethod: 'token', tokenName: 'github', tokenSource: 'manual' },
      'unknown',
    ],
    ['no auth at all', {}, 'unknown'],
  ]

  test.each(cases)('%s', (_name, overrides, expected) => {
    expect(inferClient({ ...BASE, ...overrides })).toBe(expected)
  })
})

describe('clientLabel', () => {
  test('human labels, nothing for unknown or missing', () => {
    expect(clientLabel('ios')).toBe('iPhone')
    expect(clientLabel('watch')).toBe('Watch')
    expect(clientLabel('system')).toBe('System')
    expect(clientLabel('cli')).toBe('CLI')
    expect(clientLabel('unknown')).toBeNull()
    expect(clientLabel(null)).toBeNull()
    expect(clientLabel('something-new')).toBeNull()
  })
})

interface LogRow {
  client: string | null
  token_name: string | null
}

function lastUndo(): LogRow {
  return getDb()
    .prepare('SELECT client, token_name FROM undo_log ORDER BY id DESC LIMIT 1')
    .get() as LogRow
}

function activityFor(taskId: number): LogRow[] {
  return getDb()
    .prepare('SELECT client, token_name FROM activity_log WHERE task_id = ? ORDER BY id')
    .all(taskId) as LogRow[]
}

function makeTask(title: string): number {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, due_at: localTime(9, 0, -1) },
  }).id
}

/** Run `body` inside a real withLogging-wrapped handler and return its result. */
async function inRequest<T>(
  headers: Record<string, string>,
  body: (request: NextRequest) => Promise<T> | T,
  path = '/api/tasks/bulk/snooze',
): Promise<T> {
  let out: T | undefined
  const handler = withLogging(async function TEST(request: NextRequest) {
    out = await body(request)
    return new Response(null, { status: 204 })
  })
  await handler(new NextRequest(`http://localhost:3000${path}`, { method: 'POST', headers }), {})
  return out as T
}

describe('request context reaches logAction and logActivity', () => {
  let rawToken: string

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
    rawToken = createApiToken(TEST_USER_ID, 'shortcuts').raw
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('a write outside any request is system (the cron path)', () => {
    const id = makeTask('cron-made')
    expect(lastUndo()).toEqual({ client: 'system', token_name: null })
    expect(activityFor(id)).toEqual([{ client: 'system', token_name: null }])
  })

  test('a Bearer-token write, after an await, inside withTransaction', async () => {
    const id = makeTask('swept')
    await inRequest({}, async () => {
      expect(validateBearerToken(rawToken)).not.toBeNull()
      // ALS must survive the await between auth and the write.
      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [id],
        until: localTime(9, 0, 2),
      })
    })
    expect(lastUndo()).toEqual({ client: 'shortcut', token_name: 'shortcuts' })
    expect(activityFor(id).at(-1)).toEqual({ client: 'shortcut', token_name: 'shortcuts' })
  })

  test('the header wins over the token inference', async () => {
    const id = makeTask('watch-swept')
    await inRequest({ 'X-OpenTask-Client': 'watch' }, () => {
      validateBearerToken(rawToken)
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [id],
        until: localTime(9, 0, 2),
      })
    })
    expect(lastUndo()).toEqual({ client: 'watch', token_name: 'shortcuts' })
  })

  test('a route hint applies when the header is absent', async () => {
    const ios = createApiToken(TEST_USER_ID, 'iOS App', 'ios').raw
    const client = await inRequest({}, () => {
      validateBearerToken(ios)
      const before = currentAttribution().client
      setClientHint('shortcut')
      return [before, currentAttribution().client]
    })
    expect(client).toEqual(['ios', 'shortcut'])
  })

  test('runAsSystem inside a request is system, including after an await', async () => {
    const ids = await inRequest({}, async () => {
      validateBearerToken(rawToken)
      return runAsSystem(async () => {
        await Promise.resolve()
        return makeTask('ai-made')
      })
    })
    expect(lastUndo()).toEqual({ client: 'system', token_name: null })
    expect(activityFor(ids)).toEqual([{ client: 'system', token_name: null }])
  })

  test('two concurrent requests keep their own context', async () => {
    const ios = createApiToken(TEST_USER_ID, 'iOS App', 'ios').raw
    let releaseA!: () => void
    const gate = new Promise<void>((resolve) => (releaseA = resolve))
    const a = inRequest({}, async () => {
      validateBearerToken(rawToken)
      await gate
      return currentAttribution()
    })
    const b = inRequest({}, () => {
      validateBearerToken(ios)
      const seen = currentAttribution()
      releaseA()
      return seen
    })
    expect(await b).toEqual({ client: 'ios', tokenName: 'iOS App' })
    expect(await a).toEqual({ client: 'shortcut', tokenName: 'shortcuts' })
  })
})

describe('api_tokens.last_used_at', () => {
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  function lastUsed(id: number): string | null {
    return (
      getDb().prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(id) as {
        last_used_at: string | null
      }
    ).last_used_at
  }

  test('written on first use, then at most once a minute', () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
    const { id, raw } = createApiToken(TEST_USER_ID, 'cli')
    expect(lastUsed(id)).toBeNull()

    validateBearerToken(raw)
    expect(lastUsed(id)).toBe('2026-01-15T16:00:00.000Z')

    vi.setSystemTime(new Date('2026-01-15T16:00:59Z'))
    validateBearerToken(raw)
    expect(lastUsed(id)).toBe('2026-01-15T16:00:00.000Z')

    vi.setSystemTime(new Date('2026-01-15T16:01:01Z'))
    validateBearerToken(raw)
    expect(lastUsed(id)).toBe('2026-01-15T16:01:01.000Z')
  })

  test('an invalid token writes nothing', () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
    const { id } = createApiToken(TEST_USER_ID, 'cli')
    expect(validateBearerToken('x'.repeat(64))).toBeNull()
    expect(lastUsed(id)).toBeNull()
  })
})

describe('api_tokens.last_used_at never fails or blocks a request', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    teardownTestDb()
  })

  /** Spy on the db's `prepare`, optionally making the last_used_at UPDATE throw. */
  function spyOnTouch(throwOnUpdate: boolean): () => number {
    const db = getDb()
    const original = db.prepare.bind(db)
    let updates = 0
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/^\s*UPDATE api_tokens/.test(sql)) {
        updates++
        if (throwOnUpdate) throw new Error('database is locked')
      }
      return original(sql)
    }) as typeof db.prepare)
    return () => updates
  }

  test('a throwing UPDATE still authenticates', () => {
    const { raw } = createApiToken(TEST_USER_ID, 'cli')
    const updates = spyOnTouch(true)
    expect(validateBearerToken(raw)?.id).toBe(TEST_USER_ID)
    expect(updates()).toBe(1)
  })

  test('a fresh last_used_at does no UPDATE at all', () => {
    const { id, raw } = createApiToken(TEST_USER_ID, 'cli')
    getDb()
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run('2026-01-15T15:59:30.000Z', id)
    const updates = spyOnTouch(false)
    expect(validateBearerToken(raw)?.id).toBe(TEST_USER_ID)
    expect(updates()).toBe(0)

    // A minute after the last stamp it writes again.
    vi.setSystemTime(new Date('2026-01-15T16:00:31Z'))
    validateBearerToken(raw)
    expect(updates()).toBe(1)
  })
})

describe('quota period rollover rows are system, even inside a request', () => {
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('a +1 that closes last week: period_rollover is system, the +1 is the client', async () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z')) // Thursday
    setupTestDb()
    const quotaId = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Eggs', rrule: 'FREQ=WEEKLY', progress_target: 2, is_tracked: true },
    }).id
    const { raw } = createApiToken(TEST_USER_ID, 'shortcuts')

    vi.setSystemTime(new Date('2026-01-20T16:00:00Z')) // the next Tuesday: last week ended
    await inRequest({}, () => {
      validateBearerToken(raw)
      incrementProgress({ userId: TEST_USER_ID, taskId: quotaId, delta: 1 })
    })

    const rollover = getDb()
      .prepare(
        "SELECT client, token_name FROM activity_log WHERE task_id = ? AND action = 'period_rollover'",
      )
      .all(quotaId) as LogRow[]
    expect(rollover.length).toBeGreaterThan(0)
    for (const row of rollover) expect(row).toEqual({ client: 'system', token_name: null })
    expect(lastUndo()).toEqual({ client: 'shortcut', token_name: 'shortcuts' })
  })
})
