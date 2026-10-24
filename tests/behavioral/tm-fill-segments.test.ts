/**
 * Every segment, every day (Trent, 2026-10-24: "always show every queue
 * segment, every day, in fixed positions"): `getTaskSegments(..., { fill })`,
 * `GET /api/reminders?fill=1` (the web). Every kind the caller draws comes
 * back in `SEGMENT_ORDER`, an empty one with no rows — the deadlines page and
 * the queue's two panels only with the switch on and a caller that draws
 * them. Display only: which task lands where is the same with or without it,
 * and without it (a native build) nothing changes.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/lib/sync-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync-events')>()
  return { ...actual, emitSyncEvent: vi.fn() }
})

import { createTask } from '@/core/tasks'
import { getTaskSegments } from '@/core/tasks/task-segments'
import { SEGMENT_ORDER } from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
// A Wednesday: not a check-in day, so Weekly, Monthly and Quarterly have no
// rows of their own — they still come back, empty.
const NOW = DateTime.fromISO('2026-10-21T10:00', { zone: tz }).toJSDate()

function segments(opts: Parameters<typeof getTaskSegments>[3]) {
  return getTaskSegments(TEST_USER_ID, tz, NOW, opts)
}

describe('TM-FILL: every segment, every day', () => {
  let dailyId: number
  beforeEach(() => {
    setupTestDb()
    vi.setSystemTime(NOW)
    dailyId = createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: { title: 'Daily one-off', horizon: 'days' },
    }).id
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TM-FILL01: switch on, a caller that draws everything: all of SEGMENT_ORDER, deadlines first', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const segs = segments({ queuePanels: true, deadlineRows: true, fill: true })
    expect(segs.map((s) => s.horizon)).toEqual([...SEGMENT_ORDER])
    expect(segs[0].horizon).toBe('deadlines')
    for (const seg of segs) {
      if (seg.horizon === 'days') {
        expect(seg.tasks.map((t) => t.task.id)).toEqual([dailyId])
        expect(seg.waiting).toBe(1)
      } else {
        expect(seg.tasks).toEqual([])
        expect([seg.waiting, seg.considered, seg.deferred, seg.nudge]).toEqual([0, 0, 0, false])
      }
    }
  })

  test('TM-FILL02: switch off: the horizons and Upcoming only, in order', () => {
    const segs = segments({ queuePanels: true, deadlineRows: true, fill: true })
    expect(segs.map((s) => s.horizon)).toEqual([
      'days',
      'upcoming',
      'weeks',
      'months',
      'eventually',
    ])
  })

  test('TM-FILL03: switch on, never a kind the caller does not draw', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(segments({ queuePanels: true, fill: true }).map((s) => s.horizon)).toEqual([
      'queue_today',
      'queue_previous',
      'days',
      'upcoming',
      'weeks',
      'months',
      'eventually',
    ])
    expect(segments({ deadlineRows: true, fill: true }).map((s) => s.horizon)).toEqual([
      'deadlines',
      'days',
      'upcoming',
      'weeks',
      'months',
      'eventually',
    ])
  })

  test('TM-FILL04: without fill, only segments with rows (a native build sees no change)', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(segments({ queuePanels: true, deadlineRows: true }).map((s) => s.horizon)).toEqual([
      'days',
    ])
    vi.unstubAllEnvs()
    expect(segments({}).map((s) => s.horizon)).toEqual(['days'])
  })

  test('TM-FILL05: display only — every row lands in the same segment either way', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const opts = { queuePanels: true, deadlineRows: true, deckRows: true, handledRows: true }
    const withRows = (segs: ReturnType<typeof segments>) => segs.filter((s) => s.tasks.length > 0)
    expect(withRows(segments({ ...opts, fill: true }))).toEqual(withRows(segments(opts)))
  })
})
