/**
 * "QUEUE TOMORROW" (Trent, 2026-10-31): a queue-marked target — a defer that
 * landed past the next rollover (B1, `planLanding`), so its target is the
 * rollover moment with `queue_mark` set — reads "Queue tomorrow" on every
 * surface instead of "Tomorrow 3:00 AM" (src/lib/queue-tomorrow.ts).
 *
 * - QT-W: the words: the lean row's chip, the card row's clipboard line, the
 *   Upcoming row, the details sheet's Target line.
 * - QT-N: nothing nags it between the defer and the rollover, nor at the
 *   rollover itself. Before 3:00 AM its target is still ahead, so nothing
 *   reads it as overdue; at 3:00 AM the guarantee is ORDER, not exclusion —
 *   the minute tick runs the rollover first (src/instrumentation.ts,
 *   `makeTaskRollover`), which strips the target, so the overdue checker that
 *   follows finds nothing. The test plays that order.
 * - QT-X: the chip's X (Remove target) takes the mark off with the target.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { bulkSnooze, createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { planOverdueSends } from '@/core/notifications/overdue-checker'
import { leanChipWords } from '@/lib/lean-chip-words'
import { upcomingGap } from '@/lib/task-segments'
import { formatTasksForClipboard } from '@/lib/format-task'
import { targetValueFor } from '@/components/quick-panel/this-one-props'
import { QUEUE_TOMORROW, queueMarked } from '@/lib/queue-tomorrow'
import { deckReplaces } from '@/lib/deck-menu'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const DAY_START = '03:00'

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function task(id: number): Task {
  return getTaskById(id)!
}

/** A Medium one-off over target this evening, swept at 10:12 PM to tomorrow morning. */
function marked(): Task {
  const t = createTask({
    ...u,
    input: { title: 'Task', priority: 2, due_at: at('2026-10-30T18:00') },
  })
  setClock('2026-10-30T22:12')
  bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-31T09:00'), source: 'sweep' })
  return task(t.id)
}

beforeEach(() => {
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-30T17:00')
  setupTestDb()
  getDb()
    .prepare('UPDATE users SET day_start_time = ?, last_rollover_date = ? WHERE id = ?')
    .run(DAY_START, '2026-10-30', TEST_USER_ID)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

afterAll(() => teardownTestDb())

describe('QT-W: a queue-marked target says "Queue tomorrow"', () => {
  test('QT-W01: the defer lands on the rollover moment, marked', () => {
    const t = marked()
    expect(t.due_at).toBe(at('2026-10-31T03:00'))
    expect(t.queue_mark).toBe(true)
    expect(queueMarked(t)).toBe(true)
  })

  test('QT-W02: the lean row chip, never "Tomorrow 3:00 AM"', () => {
    const t = marked()
    expect(leanChipWords(t, tz, DAY_START, new Date()).target).toBe(QUEUE_TOMORROW)
    // An unmarked target at the same moment keeps its time.
    const plain = { ...t, queue_mark: false }
    expect(leanChipWords(plain, tz, DAY_START, new Date()).target).toBe('Tomorrow 3:00 AM')
  })

  test('QT-W03: the Upcoming row, both sections', () => {
    const t = marked()
    expect(upcomingGap(t, tz, DAY_START, 'tomorrow').target).toBe(QUEUE_TOMORROW)
    expect(upcomingGap(t, tz, DAY_START, 'later').target).toBe(QUEUE_TOMORROW)
  })

  test('QT-W06: the On deck warning names it by the chip words', () => {
    const t = marked()
    expect(deckReplaces(t, tz)).toBe(QUEUE_TOMORROW)
    expect(deckReplaces({ ...t, queue_mark: false }, tz)).toBe('target Sat 3 AM')
  })

  test('QT-W04: the copied line', () => {
    const t = marked()
    const text = formatTasksForClipboard(
      [{ label: 'Inbox', tasks: [t], sort: 'due_date', reversed: false }],
      tz,
      DAY_START,
    )
    expect(text).toContain(QUEUE_TOMORROW)
    expect(text).not.toContain('3:00 AM')
  })

  test('QT-W05: the details sheet, until another target is staged', () => {
    const base = {
      timezone: tz,
      queued: false,
      queueMarked: true,
      none: null,
      header: 'Sat, Oct 31, 3:00 AM',
      relative: 'Tomorrow',
      past: false,
      delta: null,
      staged: null,
      deadline: null,
    }
    expect(targetValueFor({ ...base, dateDirty: false })).toMatchObject({
      kind: 'date',
      header: QUEUE_TOMORROW,
      past: false,
    })
    expect(targetValueFor({ ...base, dateDirty: true })).toMatchObject({
      header: 'Sat, Oct 31, 3:00 AM',
    })
  })
})

describe('QT-N: nothing nags it before or at the rollover', () => {
  const channels = { webPush: true, apns: true }

  test('QT-N01: between the defer and 3:00 AM it is not overdue', () => {
    const t = marked()
    for (const local of ['2026-10-30T22:13', '2026-10-31T00:30', '2026-10-31T02:59']) {
      const now = new Date(at(local))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID, now)).not.toContain(t.id)
      expect(planOverdueSends(now, channels).sends).toEqual([])
    }
  })

  test('QT-N02: at 3:00 the rollover (run first) pulls it, so the checker finds nothing', () => {
    const t = marked()
    const local = '2026-10-31T03:00:30'
    setClock(local)
    const now = new Date(at(local))
    // The order is the guarantee: without the rollover first, it would be due.
    expect(getCurrentlyDueTaskIds(TEST_USER_ID, now)).toContain(t.id)
    expect(planOverdueSends(now, channels).sends).toHaveLength(1)
    runTaskRollover({ now, userId: TEST_USER_ID })
    expect(task(t.id).due_at).toBeNull()
    expect(task(t.id).queue_mark).toBe(false)
    expect(task(t.id).queued_at).not.toBeNull()
    expect(getCurrentlyDueTaskIds(TEST_USER_ID, now)).not.toContain(t.id)
    expect(planOverdueSends(now, channels).sends).toEqual([])
  })
})

describe('QT-X: Remove target takes the mark with it', () => {
  test('QT-X01: no target, no mark, and the rollover leaves it alone', () => {
    const t = marked()
    updateTask({ ...u, taskId: t.id, input: { due_at: null } })
    expect(task(t.id).due_at).toBeNull()
    expect(task(t.id).queue_mark).toBe(false)
    expect(queueMarked(task(t.id))).toBe(false)
    setClock('2026-10-31T03:00:30')
    runTaskRollover({ now: new Date(at('2026-10-31T03:00:30')), userId: TEST_USER_ID })
    expect(task(t.id).queued_at).toBeNull()
  })
})
