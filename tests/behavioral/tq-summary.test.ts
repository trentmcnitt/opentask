/**
 * Task queue PR 1: the one summary line (spec rule 4) — `bulkSnoozeMessage`
 * extended, shared by the web toast, snooze-overdue's `message`, the
 * sweep-feedback push and (later) the native apps. Pure.
 *
 * Also the guard that keeps every fixed-SQL target writer clearing the
 * queue state, beside `target_set_at`'s own guard (UP-090).
 */

import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import fs from 'fs'
import path from 'path'
import { describe, test, expect } from 'vitest'
import { bulkSnoozeMessage, type BulkSnoozeSkips } from '@/lib/snooze'
import { decideSweepFeedback } from '@/core/notifications/sweep-feedback'
import { bulkSnoozeCountSummary } from '@/core/tasks/bulk'

const AT = '6:30 AM'

describe('TQ-S: the summary line', () => {
  const cases: [string, BulkSnoozeSkips, string][] = [
    [
      'switch off: the line is unchanged',
      { affected: 3, high: 1, urgent: 1, deadline: 0, capped: 1 },
      'Deferred 3 tasks (1 high, 1 urgent skipped) · 1 stopped at its deadline',
    ],
    [
      'switch off: High only, the second press of a double snooze',
      { affected: 2, highAffected: 2, high: 0, urgent: 0 },
      'Deferred 2 high-priority tasks',
    ],
    ['nothing moved', { affected: 0, high: 0, urgent: 0, queued: 0 }, 'No deferrable tasks'],
    [
      'all queued',
      { affected: 5, high: 0, urgent: 0, queued: 5, queueAt: AT },
      '5 will move to the Tasks queue at 6:30 AM',
    ],
    [
      'one queued, named',
      { affected: 1, high: 0, urgent: 0, queued: 1, queuedName: 'Call the bank', queueAt: AT },
      '"Call the bank" will move to the Tasks queue at 6:30 AM',
    ],
    [
      'one task moved, named',
      { affected: 1, high: 0, urgent: 0, singleName: 'Water the plants' },
      'Deferred "Water the plants"',
    ],
    [
      'the one High moved, named, with the rest of the tier left',
      { affected: 1, highAffected: 1, high: 2, urgent: 1, highName: 'Pay rent' },
      'Deferred high-priority "Pay rent" (2 high, 1 urgent skipped)',
    ],
    [
      'the one "High" is a passed-deadline P1',
      { affected: 1, high: 1, urgent: 0, highName: 'File taxes', highByDeadline: true },
      'Deferred past-deadline "File taxes" (1 high skipped)',
    ],
    [
      'THE MIXED PRESS: marked (repeating among them) + deadline-capped + one High named',
      {
        affected: 6,
        highAffected: 1,
        high: 1,
        urgent: 1,
        queued: 4,
        queueAt: AT,
        capped: 1,
        highName: 'Pay rent',
      },
      '4 will move to the Tasks queue at 6:30 AM · Deferred 2 tasks, including high-priority "Pay rent" (1 high, 1 urgent skipped) · 1 stopped at its deadline',
    ],
    [
      'queued and a repeating task stopped at its next occurrence',
      { affected: 3, high: 0, urgent: 0, queued: 2, queueAt: AT, cappedOccurrence: 1 },
      '2 will move to the Tasks queue at 6:30 AM · Deferred 1 task · 1 stopped at its next occurrence',
    ],
    [
      'queued with only skips beside it',
      { affected: 2, high: 0, urgent: 2, deadline: 1, queued: 2, queueAt: AT },
      '2 will move to the Tasks queue at 6:30 AM (1 past deadline, 2 urgent skipped)',
    ],
    [
      'several stopped at both kinds of cap',
      { affected: 4, high: 0, urgent: 0, capped: 2, cappedOccurrence: 2 },
      'Deferred 4 tasks · 2 stopped at their deadline · 2 stopped at their next occurrence',
    ],
  ]

  test.each(cases)('TQ-S: %s', (_name, skips, expected) => {
    expect(bulkSnoozeMessage(skips)).toBe(expected)
  })

  test('TQ-S20: one line — never a newline', () => {
    for (const [, skips] of cases) expect(bulkSnoozeMessage(skips)).not.toMatch(/\n/)
  })
})

describe('TQ-F: the sweep-feedback push uses the count-only summary', () => {
  test('TQ-F00: bulkSnoozeCountSummary names nothing; summary does', () => {
    const result = {
      tasksAffected: 2,
      tasksSkipped: 1,
      urgentSkipped: 1,
      highSkipped: 1,
      highSnoozed: 1,
      reminderSkipped: 0,
      noDueDateSkipped: 0,
      deadlineSkipped: 0,
      deadlineCapped: 0,
      snoozedIds: [1, 2],
      queued: 1,
      queuedName: 'Call the bank',
      cappedOccurrence: 0,
      snoozedHighName: 'Pay rent',
      queuedUntil: '2026-10-21T11:30:00.000Z',
      summary: 'unused',
    }
    expect(bulkSnoozeCountSummary(result, 'America/Chicago')).toBe(
      '1 will move to the Tasks queue at 6:30 AM · Deferred 1 high-priority task (1 high skipped)',
    )
  })

  const user = { is_demo: 0, notifications_enabled: 1, sweep_feedback_notifications_enabled: 1 }
  const base = {
    viaBearer: true,
    notify: undefined,
    counts: { affected: 3, highAffected: 0, high: 2, urgent: 0 },
    until: '2026-10-21T13:30:00.000Z',
    timezone: 'America/Chicago',
    dayStart: CALENDAR_DAY_START,
    totalOverdueCount: 2,
  }

  test('TQ-F01: switch on (a count summary passed): the title is that line', () => {
    const countSummary = '3 will move to the Tasks queue at 6:30 AM (2 high skipped)'
    const fb = decideSweepFeedback({ ...base, countSummary }, user)!
    expect(fb.title).toBe(countSummary)
    // One High per press: the next press moves one, not "the High ones".
    expect(fb.body).toBe('2 High still overdue. Defer again to move the next one')
  })

  test('TQ-F02: switch off (no summary): exactly as before', () => {
    const fb = decideSweepFeedback(base, user)!
    expect(fb.title).toMatch(/^Deferred 3 tasks until /)
    expect(fb.body).toBe('2 High still overdue. Defer again to move the High ones')
  })
})

/**
 * The guard: a file that sets `target_set_at` in a fixed SQL statement
 * (`${TARGET_SET_FIELD} = ?`) is a target writer outside `collectFieldChanges`,
 * so it must clear the queue state in the same statement (`QUEUE_CLEAR_SQL`).
 * `create.ts` is exempt: a new row starts with the columns' defaults.
 */
describe('TQ-G: queue-state guard', () => {
  const EXEMPT = new Set([
    'src/core/tasks/create.ts',
    'src/core/tasks/target-set.ts',
    // The rollover (task-queue PR 2) is the deliberate exception: it is the
    // writer that SETS the queue state (`queued_at`, the kept target), and
    // writes every queue column explicitly in each statement — clearing
    // them would undo its own strip. Its tests: tq-rollover.test.ts.
    'src/core/tasks/task-rollover.ts',
  ])

  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return files(p)
      return /\.ts$/.test(e.name) ? [p] : []
    })
  }

  test('TQ-G01: every fixed-SQL target_set_at writer also clears the queue state', () => {
    const root = process.cwd()
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !EXEMPT.has(f))
      .filter((f) => /\$\{TARGET_SET_FIELD\} = \?/.test(fs.readFileSync(f, 'utf8')))
      .filter((f) => !fs.readFileSync(f, 'utf8').includes('QUEUE_CLEAR_SQL'))
    expect(offenders).toEqual([])
  })
})
