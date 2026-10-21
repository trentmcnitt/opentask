/**
 * AI task summaries (What's Next, Insights) — the 2026-10-10 task model
 *
 * - The cap (AI_SUMMARY_CAP) is split so untargeted tasks are not the first
 *   dropped when a user has more open tasks than the cap.
 * - A deadline-only task carries the deadline's AUTOMATIC target (§8.1,
 *   2026-10-12: stored, `target_auto`), printed "(from deadline)", instead of
 *   "target: none"; a target past its deadline is pulled back to it (§8.2).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import {
  AI_SUMMARY_CAP,
  AI_SUMMARY_UNTARGETED_SHARE,
  buildTaskSummaries,
  pickSummaryTasks,
  withEffectiveSummaryTarget,
} from '@/core/ai/task-summaries'
import { formatTaskLine } from '@/core/ai/format'
import type { TaskSummary } from '@/core/ai/types'

const NOW = new Date('2026-10-11T19:00:00Z') // Sun Oct 11, 2:00 PM Chicago

beforeAll(() => setupTestDb())
afterAll(() => teardownTestDb())
beforeEach(() => vi.setSystemTime(NOW))
afterEach(() => vi.useRealTimers())

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('pickSummaryTasks', () => {
  test('both sides over half the cap: each keeps its share', () => {
    const out = pickSummaryTasks(
      range(300).map((i) => `t${i}`),
      range(300).map((i) => `u${i}`),
    )
    expect(out).toHaveLength(AI_SUMMARY_CAP)
    expect(out.filter((x) => x.startsWith('u'))).toHaveLength(AI_SUMMARY_UNTARGETED_SHARE)
    // Order within a side is kept: the soonest targets, the first untargeted.
    expect(out[0]).toBe('t0')
    expect(out).toContain('u0')
    expect(out).not.toContain('t150')
  })

  test('a side under its share hands the rest to the other', () => {
    const few = pickSummaryTasks(
      range(30).map((i) => `t${i}`),
      range(400).map((i) => `u${i}`),
    )
    expect(few).toHaveLength(AI_SUMMARY_CAP)
    expect(few.filter((x) => x.startsWith('t'))).toHaveLength(30)

    const under = pickSummaryTasks(
      range(50).map((i) => `t${i}`),
      range(20).map((i) => `u${i}`),
    )
    expect(under).toHaveLength(70)
  })
})

describe('buildTaskSummaries', () => {
  test('over the cap, untargeted tasks keep their share; deadline-only ones ride their auto target; quotas never count', () => {
    const db = getDb()
    const deadlineIds: number[] = []
    db.transaction(() => {
      for (const i of range(150)) {
        createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: {
            title: `Targeted ${i}`,
            due_at: DateTime.fromJSDate(NOW)
              .plus({ hours: i + 1 })
              .toUTC()
              .toISO()!,
          },
        })
      }
      for (const i of range(120)) {
        createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: { title: `Untargeted ${i}` },
        })
      }
      for (const i of range(5)) {
        const t = createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: {
            title: `Deadline only ${i}`,
            // 2–4 days out: automatic targets the day before (2026-10-21).
            deadline_at: DateTime.fromJSDate(NOW)
              .plus({ days: 2 + Math.floor(i / 2) })
              .toUTC()
              .toISO()!,
          },
        })
        deadlineIds.push(t.id)
      }
      for (const i of range(10)) {
        createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: {
            title: `Quota ${i}`,
            rrule: 'FREQ=WEEKLY',
            is_tracked: true,
            progress_target: 3,
          },
        })
      }
    })()

    const summaries = buildTaskSummaries(TEST_USER_ID)
    expect(summaries).toHaveLength(AI_SUMMARY_CAP)
    expect(summaries.some((s) => s.title.startsWith('Quota'))).toBe(false)
    // Old order (target ascending, none last) kept every targeted task and only
    // 50 untargeted ones; now each side keeps its share. A deadline-only task
    // has a stored automatic target (§8.1) — within the next few days here —
    // so it sits on the targeted side, among the soonest, and is kept.
    expect(summaries.filter((s) => s.title.startsWith('Untargeted'))).toHaveLength(
      AI_SUMMARY_UNTARGETED_SHARE,
    )
    expect(summaries.filter((s) => s.title.startsWith('Targeted'))).toHaveLength(
      AI_SUMMARY_CAP - AI_SUMMARY_UNTARGETED_SHARE - deadlineIds.length,
    )
    const ids = new Set(summaries.map((s) => s.id))
    for (const id of deadlineIds) expect(ids.has(id)).toBe(true)

    // A deadline-only task reads with its automatic target, marked as such.
    const deadlineOnly = summaries.find((s) => s.id === deadlineIds[0])!
    expect(deadlineOnly.due_at).not.toBeNull()
    expect(deadlineOnly.target_implied).toBe(true)
  })
})

describe('withEffectiveSummaryTarget / formatTaskLine', () => {
  const ctx = { timezone: 'America/Chicago', morningTime: '09:00' }
  const base: TaskSummary = {
    id: 1,
    title: 'Use the voucher',
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: '2026-10-01T15:00:00Z',
    labels: [],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  }
  const now = DateTime.fromJSDate(NOW).setZone('America/Chicago')

  test('deadline only → the automatic target, "(from deadline)"', () => {
    // Deadline Fri Oct 16, 23:59 Chicago; today Sun Oct 11 → a 5-day wait →
    // the day before, Thu Oct 15 (2026-10-21's one lead table).
    const s = withEffectiveSummaryTarget({ ...base, deadline_at: '2026-10-17T04:59:00Z' }, ctx, NOW)
    expect(s.due_at).toBe('2026-10-15T14:00:00.000Z') // Thu Oct 15, 9:00 AM Chicago
    expect(s.target_implied).toBe(true)
    expect(formatTaskLine(s, 'America/Chicago', now)).toContain(
      'target: Thu, Oct 15, 9:00 AM (from deadline)',
    )
  })

  test("own target after the deadline → pulled back to the deadline, still the user's own", () => {
    const s = withEffectiveSummaryTarget(
      {
        ...base,
        priority: 3,
        due_at: '2026-10-25T14:00:00Z',
        original_due_at: '2026-10-20T14:00:00Z',
        deadline_at: '2026-10-17T04:59:00Z',
      },
      ctx,
      NOW,
    )
    expect(s.due_at).toBe('2026-10-17T04:59:00Z')
    expect(s.target_implied).toBeUndefined()
    expect(formatTaskLine(s, 'America/Chicago', now)).not.toContain('(from deadline)')
  })

  test('own target at or before the deadline, or no deadline → unchanged', () => {
    const own = { ...base, due_at: '2026-10-13T14:00:00Z', deadline_at: '2026-10-17T04:59:00Z' }
    expect(withEffectiveSummaryTarget(own, ctx, NOW)).toBe(own)
    expect(withEffectiveSummaryTarget(base, ctx, NOW)).toBe(base)
    expect(formatTaskLine(base, 'America/Chicago', now)).toContain('target: none')
  })
})
