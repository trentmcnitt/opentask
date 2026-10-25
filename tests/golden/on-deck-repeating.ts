/**
 * ON DECK FOR REPEATING TASKS (2026-10-20; Trent: "It needs to be added." —
 * docs/TASK-MODEL.md § On deck), as day-by-day timelines, written from the
 * ruling, not from the simulator's output:
 *
 *  - decking a repeating task decks its CURRENT occurrence for the day: no
 *    target while decked (`due_at` NULL, `occurrence_at` kept), so it never
 *    nags;
 *  - done completes that occurrence and advances normally (from the later of
 *    the occurrence and now);
 *  - at the rollover an un-done deck gets its target back on the occurrence
 *    and falls to the existing repeating rules: a daily rolls to that day's
 *    occurrence with a skip; a longer rule waits in the queue, then releases
 *    with an auto-skip on its day; High and Urgent are never rolled (they
 *    nag); from_completion never re-anchors;
 *  - a future deck that passes later occurrences absorbs them: ONE skip, of
 *    the decked occurrence.
 * A missed deck is never an attempt: the badge counts from the restore.
 *
 * Every scenario runs with the task queue on: periods 06:30 / 12:00 / 20:30
 * (the rollover is 06:30), morning 08:30, read at 21:00; policy `never`.
 */
import { expect } from 'vitest'
import { markDone } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { deckTasks } from '@/core/tasks/deck'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso } from './helpers'

function deck(names: string[], day?: string | null) {
  return (ctx: SimContext) => {
    deckTasks({
      userId: ctx.userId,
      timezone: ctx.timezone,
      ids: names.map((n) => ctx.ids[n]),
      day,
    })
  }
}

function done(name: string) {
  return (ctx: SimContext) => {
    markDone({ userId: ctx.userId, userTimezone: ctx.timezone, taskId: ctx.ids[name] })
  }
}

function check(name: string, fields: Record<string, unknown>) {
  return (ctx: SimContext) => {
    const task = getTaskById(ctx.ids[name])!
    for (const [k, v] of Object.entries(fields)) {
      expect((task as unknown as Record<string, unknown>)[k], `${name}.${k}`).toEqual(v)
    }
  }
}

/** Not over target right now (the badge's set), whatever its occurrence says. */
function notDue(name: string) {
  return (ctx: SimContext) => {
    expect(getCurrentlyDueTaskIds(ctx.userId), `${name} not due`).not.toContain(ctx.ids[name])
  }
}

const QUEUE = {}
const DAILY_8 = 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0'
const MONDAY_8 = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0'

export const onDeckRepeatingScenarios: GoldenScenario[] = [
  {
    id: 'odr-daily-not-done',
    title: 'A daily decked today, not done: never nags; next morning it rolls with a skip',
    source: 'repeating-deck ruling (daily → roll + skip); never nags',
    from: '2026-10-19',
    to: '2026-10-21',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic daily', rrule: DAILY_8 },
      },
    ],
    events: [
      { at: '2026-10-19T07:30', run: deck(['task']) },
      {
        at: '2026-10-19T07:31',
        run: check('task', {
          on_deck_day: '2026-10-19',
          due_at: null,
          occurrence_at: iso('2026-10-19T08:00'),
        }),
      },
      // Its occurrence has come: still not over target.
      { at: '2026-10-19T12:00', run: notDue('task') },
      {
        at: '2026-10-20T06:31',
        run: check('task', {
          on_deck_day: null,
          due_at: iso('2026-10-20T08:00'),
          occurrence_at: iso('2026-10-20T08:00'),
          skip_count: 1,
          queued_at: null,
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'deck',
        // Rolled with a skip: attempts afresh, over from 08:00.
        '2026-10-20..2026-10-21': 'over 1×',
      },
    },
  },
  {
    id: 'odr-weekly-waits',
    title: 'A weekly decked on its day, not done: waits in the queue, then auto-skips on its day',
    source: 'repeating-deck ruling (longer → wait, release + auto-skip); B3; queued_from_deck_day',
    from: '2026-10-19',
    to: '2026-10-26',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic weekly', rrule: MONDAY_8 },
      },
    ],
    events: [
      { at: '2026-10-19T07:30', run: deck(['task']) },
      {
        at: '2026-10-20T06:31',
        run: check('task', {
          on_deck_day: null,
          due_at: iso('2026-10-26T08:00'),
          occurrence_at: iso('2026-10-19T08:00'),
          queued_from_deck_day: '2026-10-19',
          queued_from_due_at: null,
          skip_count: 0,
          // The deck day was never an attempt.
          attempts: 0,
        }),
      },
      {
        at: '2026-10-26T06:31',
        run: check('task', {
          due_at: iso('2026-10-26T08:00'),
          occurrence_at: iso('2026-10-26T08:00'),
          queued_at: null,
          skip_count: 1,
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'deck',
        '2026-10-20': 'queue_today queued',
        '2026-10-21..2026-10-25': 'queue_previous queued',
        '2026-10-26': 'over 1×',
      },
    },
  },
  {
    id: 'odr-from-completion',
    title:
      'Every 3 days from completion, decked and missed: stepped from the occurrence, no re-anchor',
    source: 'repeating-deck ruling; red-team edge ("a system skip doesn\'t re-anchor")',
    from: '2026-10-19',
    to: '2026-10-22',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: {
          title: 'Synthetic from completion',
          rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=8;BYMINUTE=0',
          recurrence_mode: 'from_completion',
        },
      },
    ],
    events: [
      { at: '2026-10-19T07:30', run: deck(['task']) },
      // Mon 08:00 + 3 days = Thu 08:00 (never Tue + 3 = Fri).
      {
        at: '2026-10-20T06:31',
        run: check('task', {
          due_at: iso('2026-10-22T08:00'),
          occurrence_at: iso('2026-10-19T08:00'),
          queued_from_deck_day: '2026-10-19',
        }),
      },
      {
        at: '2026-10-22T06:31',
        run: check('task', { occurrence_at: iso('2026-10-22T08:00'), queued_at: null }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'deck',
        '2026-10-20': 'queue_today queued',
        '2026-10-21': 'queue_previous queued',
        '2026-10-22': 'over 1×',
      },
    },
  },
  {
    id: 'odr-waiting-decked-done',
    title:
      'A waiting weekly ("try the missed one, quietly") decked today and done: advances normally',
    source: 'repeating-deck ruling (queue waiting row; done advances normally)',
    from: '2026-10-19',
    to: '2026-10-26',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic weekly', rrule: MONDAY_8 },
      },
    ],
    events: [
      { at: '2026-10-20T10:00', run: deck(['task']) },
      {
        at: '2026-10-20T10:01',
        run: check('task', {
          on_deck_day: '2026-10-20',
          due_at: null,
          occurrence_at: iso('2026-10-19T08:00'),
          queued_at: null,
        }),
      },
      { at: '2026-10-20T15:00', run: done('task') },
      {
        at: '2026-10-20T15:01',
        run: check('task', {
          on_deck_day: null,
          due_at: iso('2026-10-26T08:00'),
          occurrence_at: iso('2026-10-26T08:00'),
          completion_count: 1,
          skip_count: 0,
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'over 1×',
        // Done Tue for Mon (wait 6): Tomorrow only (lead 1, no Later).
        '2026-10-25': 'tomorrow',
        '2026-10-26': 'over 1×',
      },
    },
  },
  {
    id: 'odr-future-deck',
    title:
      'A daily decked for Thursday on Monday passes three occurrences: one skip if missed, none if done',
    source: 'repeating-deck ruling (a future deck passing the next occurrence; absorbed, B2-like)',
    from: '2026-10-19',
    to: '2026-10-23',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'missed',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic daily', rrule: DAILY_8 },
      },
      {
        name: 'done',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic daily', rrule: DAILY_8 },
      },
    ],
    events: [
      { at: '2026-10-19T07:30', run: deck(['missed', 'done'], '2026-10-22') },
      // Tue and Wed: the decked occurrence (Mon) is not rolled, and never nags.
      {
        at: '2026-10-21T12:00',
        run: check('missed', { on_deck_day: '2026-10-22', skip_count: 0 }),
      },
      { at: '2026-10-21T12:00', run: notDue('missed') },
      { at: '2026-10-22T12:00', run: done('done') },
      {
        at: '2026-10-22T12:01',
        run: check('done', {
          due_at: iso('2026-10-23T08:00'),
          occurrence_at: iso('2026-10-23T08:00'),
          skip_count: 0,
        }),
      },
      {
        at: '2026-10-23T06:31',
        run: check('missed', {
          on_deck_day: null,
          due_at: iso('2026-10-23T08:00'),
          occurrence_at: iso('2026-10-23T08:00'),
          skip_count: 1,
        }),
      },
    ],
    expect: {
      // Decked Mon for Thu (wait 3): Tomorrow on Wed.
      missed: { '2026-10-21': 'tomorrow', '2026-10-22': 'deck', '2026-10-23': 'over 1×' },
      done: { '2026-10-21': 'tomorrow', '2026-10-23': 'over 1×' },
    },
  },
  {
    id: 'odr-high',
    title: 'A High daily decked and missed: its target comes back and it nags (High never rolls)',
    source: 'repeating-deck ruling (High/Urgent repeating can be decked); rollover EXCLUDED',
    from: '2026-10-19',
    to: '2026-10-21',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T07:00',
        input: { title: 'Synthetic daily', rrule: DAILY_8, priority: 3 },
      },
    ],
    events: [
      { at: '2026-10-19T07:30', run: deck(['task']) },
      {
        at: '2026-10-20T06:31',
        run: check('task', {
          on_deck_day: null,
          due_at: iso('2026-10-19T08:00'),
          occurrence_at: iso('2026-10-19T08:00'),
          skip_count: 0,
          queued_at: null,
        }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'deck',
        // The deck day is not an attempt: counted from the restore.
        '2026-10-20': 'over 1×',
        '2026-10-21': 'over 2×',
      },
    },
  },
]
