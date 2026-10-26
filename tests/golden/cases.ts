/**
 * The cases Trent raised on 10-12 that are not a plain reference row: the
 * deadline tomorrow at 3 PM made at 1:35 PM, the squeaky door moved Tuesday →
 * Saturday (attempts), the Nov 1 pile (carry-over, then attempts and the 3×
 * offer), the past-deadline case (a passed deadline, a picked target later:
 * quiet until it, then over target, High in bulk), and the age badge on
 * undated tasks.
 */
import { expect } from 'vitest'
import { createTask, updateTask, bulkSnooze } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import type { GoldenScenario, GoldenTask } from './types'
import { iso } from './helpers'

const NOV1_ONE_OFFS: GoldenTask[] = Array.from({ length: 8 }, (_, i) => ({
  name: `one-off ${i + 1}`,
  created: '2026-10-12T10:00',
  input: { title: `Synthetic Nov 1 task ${i + 1}`, due_at: iso('2026-11-01T09:00') },
}))
const NOV1_MONTHLY: GoldenTask[] = [7, 8].map((hour, i) => ({
  name: `monthly ${i + 1}`,
  created: '2026-10-01T09:00',
  input: {
    title: `Synthetic monthly ${i + 1}`,
    rrule: `FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=${hour};BYMINUTE=0`,
  },
}))
const NOV1_WEEKLY: GoldenTask[] = Array.from({ length: 4 }, (_, i) => ({
  name: `weekly ${i + 1}`,
  // Done last Sunday (made after its noon occurrence): next is Nov 1, wait 7.
  created: '2026-10-25T13:00',
  input: {
    title: `Synthetic Sunday ${i + 1}`,
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
  },
}))

// Sections (2026-10-25): Later from Wed Oct 28 (wait 20 → lead 4), carried
// over untapped through Fri Oct 30 (A − 2); Sat Oct 31 is Tomorrow.
const oneOffNov1 = {
  '2026-10-28..2026-10-30': 'later',
  '2026-10-31': 'tomorrow',
  '2026-11-01': 'over 1×',
  '2026-11-02': 'over 2×',
  '2026-11-03': 'over 3× →remove',
}
const repeatingNov1 = {
  '2026-11-01': 'over 1×',
  '2026-11-02': 'over 2×',
  // A repeating task's target goes only with its recurrence: no offer.
  '2026-11-03': 'over 3×',
}

export const caseScenarios: GoldenScenario[] = [
  {
    id: 'case-deadline-tomorrow-3pm',
    title: 'Deadline tomorrow 3 PM, made today at 1:35 PM — auto target tomorrow morning',
    source: 'Trent 10-12; the one lead table (2026-10-21: under 2 days, the deadline day)',
    from: '2026-10-12',
    to: '2026-10-14',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T13:35',
        input: { title: 'Synthetic quick deadline', deadline_at: iso('2026-10-13T15:00') },
      },
    ],
    // Wait 1 (2026-10-21's one lead table): the deadline day at the morning,
    // Tue 9:00 — before the deadline's 3 PM. Monday it is in Days (the
    // deadline is a day out); over target from Tuesday. An automatic target
    // offers nothing. (Until 10-21 the 3-day lead put it in the past: now.)
    expect: { task: { '2026-10-12': 'days', '2026-10-13': 'over 1×', '2026-10-14': 'over 2×' } },
  },
  {
    id: 'case-squeaky-door',
    title:
      'The squeaky door: Tue target, moved Tue → Sat — 1× Tue, kept to Sat, 2× Sat, 3× Sun + offer',
    source: 'Trent 10-12 "the squeaky door moved Tuesday → Saturday (attempts)"; ruling Q5',
    from: '2026-10-12',
    to: '2026-10-18',
    policy: ['tap'],
    tasks: [
      {
        name: 'door',
        created: '2026-10-12T10:00',
        input: { title: 'Fix the squeaky door', due_at: iso('2026-10-13T09:00') },
      },
    ],
    events: [
      {
        at: '2026-10-13T10:00',
        run: (ctx) =>
          void updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.door,
            input: { due_at: iso('2026-10-17T09:00') },
          }),
      },
    ],
    // Over target Tue 9:00 → 1× (the move at 10:00 keeps it). Moved Tue → Sat
    // is a wait of 4: Tomorrow on Fri (no Later: lead 1). Sat over again → 2×; Sun
    // 3× and the row offers "Remove target?".
    expect: {
      door: {
        '2026-10-13..2026-10-15': 'quiet 1×',
        '2026-10-16': 'tomorrow 1×',
        '2026-10-17': 'over 2×',
        '2026-10-18': 'over 3× →remove',
      },
    },
  },
  {
    id: 'case-nov-1-pile',
    title: 'The Nov 1 pile: 14 targets on the DST day, never tapped — carry-over, then attempts',
    source:
      'spec "Not in this spec" (leave it as is: Upcoming Oct 28 and Oct 31, over target Nov 1, then attempts and the remove-target offer); spec §5 DST',
    from: '2026-10-25',
    to: '2026-11-03',
    policy: ['never'],
    tasks: [...NOV1_ONE_OFFS, ...NOV1_MONTHLY, ...NOV1_WEEKLY],
    expect: {
      ...Object.fromEntries(NOV1_ONE_OFFS.map((t) => [t.name, oneOffNov1])),
      ...Object.fromEntries(
        NOV1_MONTHLY.map((t) => [
          t.name,
          // Made Oct 1 after 7/8 AM: Nov 1 is the first, wait 31 → Later Oct
          // 28, carried over to Oct 30; Tomorrow Oct 31.
          { '2026-10-28..2026-10-30': 'later', '2026-10-31': 'tomorrow', ...repeatingNov1 },
        ]),
      ),
      ...Object.fromEntries(
        NOV1_WEEKLY.map((t) => [t.name, { '2026-10-31': 'tomorrow', ...repeatingNov1 }]),
      ),
    },
    counts: {
      '2026-10-27': { upcoming: 0 },
      // Untapped rows carry over as the same single row: 10 from Wed Oct 28
      // (Later), 14 on Sat Oct 31 when the four weeklies join (all Tomorrow).
      // `upcoming` counts both sections.
      '2026-10-28': { upcoming: 10 },
      '2026-10-30': { upcoming: 10 },
      '2026-10-31': { upcoming: 14 },
      '2026-11-01': { over: 14 },
      '2026-11-03': { over: 14, offers: 8 },
    },
  },
  {
    id: 'case-past-deadline-picked-later',
    title:
      'Past deadline, picked target later: quiet until it (one heads-up), then over target; High in bulk',
    source: "Trent's ruling 2026-10-12 (a passed deadline: any target; bulk treats it as High)",
    from: '2026-10-05',
    to: '2026-10-17',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-05T10:00',
        input: { title: 'Synthetic client task', deadline_at: iso('2026-10-12T17:00') },
      },
    ],
    events: [
      {
        // The deadline passed yesterday. Pick Fri 9:00 — no cap once it has passed.
        at: '2026-10-13T10:00',
        run: (ctx) => {
          const r = updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { due_at: iso('2026-10-16T09:00') },
          })
          expect(r.task.due_at).toBe(iso('2026-10-16T09:00'))
          expect(r.task.target_auto).toBe(false)
        },
      },
      {
        // After the last day is read: in a sweep beside a plain P0 it waits
        // like High; alone, it moves.
        at: '2026-10-17T22:00',
        run: (ctx) => {
          const plain = createTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            input: { title: 'Synthetic plain task', due_at: iso('2026-10-17T08:00') },
          })
          const until = iso('2026-10-19T09:00')
          const first = bulkSnooze({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskIds: [ctx.ids.task, plain.id],
            until,
          })
          expect(first.snoozedIds).toEqual([plain.id])
          expect(first.deadlineSkipped).toBe(1)
          const second = bulkSnooze({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskIds: [ctx.ids.task],
            until,
          })
          expect(second.snoozedIds).toEqual([ctx.ids.task])
          expect(getTaskById(ctx.ids.task)!.due_at).toBe(until)
        },
      },
    ],
    // Mon Oct 5, deadline Mon Oct 12 17:00 (wait 7 → the day before, the one
    // lead table of 2026-10-21): the automatic target is Sun Oct 11 9:00;
    // until then the deadline pulls it into Days. Over target Sun–Mon (auto:
    // no offer). Tue 10:00 the picked target — Tuesday already counted (3×).
    // Wait Tue → Fri 3: Tomorrow on Thursday. Fri over again (4×). No "Back to
    // auto?": the deadline has passed.
    expect: {
      task: {
        '2026-10-05..2026-10-10': 'days',
        '2026-10-11': 'over 1×',
        '2026-10-12': 'over 2×',
        '2026-10-13..2026-10-14': 'quiet 3×',
        '2026-10-15': 'tomorrow 3×',
        '2026-10-16': 'over 4×',
        '2026-10-17': 'over 5×',
      },
    },
  },
  {
    id: 'case-age-undated',
    title: 'Undated tasks: weeks shows on Saturdays, ">1 mo" past a month; days daily, ">1 wk"',
    source: 'spec §7 age badge; rulings Q6',
    from: '2026-09-01',
    to: '2026-10-10',
    policy: ['tap'],
    tasks: [
      { name: 'weeks', created: '2026-09-01T10:00', input: { title: 'Synthetic someday task' } },
      {
        name: 'days',
        created: '2026-10-01T10:00',
        input: { title: 'Synthetic soon task', horizon: 'days' },
      },
    ],
    expect: {
      // Unset horizon = weeks: every Saturday (the default check-in day).
      // Past one month (Oct 1 10:00) it carries ">1 mo".
      weeks: {
        '2026-09-05': 'weeks',
        '2026-09-12': 'weeks',
        '2026-09-19': 'weeks',
        '2026-09-26': 'weeks',
        '2026-10-01..2026-10-02': 'quiet >1 mo',
        '2026-10-03': 'weeks >1 mo',
        '2026-10-04..2026-10-09': 'quiet >1 mo',
        '2026-10-10': 'weeks >1 mo',
      },
      days: { '2026-10-01..2026-10-07': 'days', '2026-10-08..2026-10-10': 'days >1 wk' },
    },
  },
]
