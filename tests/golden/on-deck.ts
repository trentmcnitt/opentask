/**
 * ON DECK (2026-10-20), as day-by-day timelines — written from the design
 * (`on-deck-design.md`: rules 1–6 and the red-team resolutions A1–A3, B1, B5,
 * B6) and the D1 brief, not from the simulator's output.
 *
 * Every scenario runs with the task queue on (`queue`): periods 06:30 / 12:00
 * / 20:30 (the rollover is 06:30) and morning_time 08:30, read at 21:00.
 * Policy `never` unless a scenario says otherwise, so a queued row stays
 * queued and moves from "today" to "previous" the next morning.
 *
 * How to read a line (see `dayLine`): "deck" = on deck for today (the On
 * deck section, `onDeckToday`); "upcoming" = a future deck's (or a picked
 * target's) heads-up day; "queue_today queued" / "queue_previous queued" =
 * in the task queue's panels. A deck is quiet otherwise: no horizon segment,
 * no over target.
 */
import { expect } from 'vitest'
import { bulkSnooze, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { deckTasks } from '@/core/tasks/deck'
import { runRolloverNow } from '@/core/tasks/rollover-now'
import { getTaskSegments } from '@/core/tasks/task-segments'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { iso } from './helpers'

/** Put tasks on deck (`day` omitted = today; null = take off). */
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

/** A deck refused for one task (A1): nothing changes. */
function refused(name: string, day: string, reason: string) {
  return (ctx: SimContext) => {
    const r = deckTasks({ userId: ctx.userId, timezone: ctx.timezone, ids: [ctx.ids[name]], day })
    expect(r.refused, `${name} on deck ${day}`).toEqual([{ id: ctx.ids[name], reason }])
  }
}

/** A check on the stored row at a moment the 21:00 line can't show. */
function check(name: string, fields: Record<string, unknown>) {
  return (ctx: SimContext) => {
    const task = getTaskById(ctx.ids[name])!
    for (const [k, v] of Object.entries(fields)) {
      expect((task as unknown as Record<string, unknown>)[k], `${name}.${k}`).toEqual(v)
    }
  }
}

const QUEUE = {}
const UNDATED = { title: 'Synthetic undated one-off' }

export const onDeckScenarios: GoldenScenario[] = [
  {
    id: 'od-today-not-done',
    title: 'On deck today, not done: Queued at the next rollover, then Previously queued',
    source: 'rule 4; B5',
    from: '2026-10-19',
    to: '2026-10-24',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [
      { at: '2026-10-19T10:00', run: deck(['task']) },
      {
        at: '2026-10-20T06:31',
        run: check('task', { on_deck_day: null, queued_from_deck_day: '2026-10-19' }),
      },
    ],
    expect: {
      task: {
        '2026-10-19': 'deck',
        '2026-10-20': 'queue_today queued',
        '2026-10-21..2026-10-24': 'queue_previous queued',
      },
    },
  },
  {
    id: 'od-1am',
    title: 'A deck for "today" made at 1 AM is the coming calendar day: it lasts that day',
    source: 'A2',
    from: '2026-10-19',
    to: '2026-10-22',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [
      { at: '2026-10-20T01:00', run: deck(['task']) },
      { at: '2026-10-20T01:01', run: check('task', { on_deck_day: '2026-10-20' }) },
      // Still on deck after the 6:30 rollover the same morning.
      { at: '2026-10-20T06:31', run: check('task', { on_deck_day: '2026-10-20' }) },
    ],
    expect: {
      task: {
        '2026-10-20': 'deck',
        '2026-10-21': 'queue_today queued',
        '2026-10-22': 'queue_previous queued',
      },
    },
  },
  {
    id: 'od-saturday',
    title: 'A Saturday deck made Monday: Upcoming Friday, on deck Saturday, Queued Sunday',
    source: 'rule 5 (Upcoming heads-up, wait 5 → the day before); rule 4',
    from: '2026-10-19',
    to: '2026-10-26',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [{ at: '2026-10-19T10:00', run: deck(['task'], '2026-10-24') }],
    expect: {
      task: {
        '2026-10-23': 'upcoming',
        '2026-10-24': 'deck',
        '2026-10-25': 'queue_today queued',
        '2026-10-26': 'queue_previous queued',
      },
    },
  },
  {
    id: 'od-redeck',
    title: 'Re-deck: on deck today, moved to tomorrow in the evening — on deck again, then Queued',
    source: 'gesture 7 (re-deck = hold → Tomorrow)',
    from: '2026-10-19',
    to: '2026-10-21',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [
      { at: '2026-10-19T10:00', run: deck(['task']) },
      { at: '2026-10-19T22:00', run: deck(['task'], '2026-10-20') },
    ],
    expect: {
      task: {
        '2026-10-19': 'deck',
        '2026-10-20': 'deck',
        '2026-10-21': 'queue_today queued',
      },
    },
  },
  {
    id: 'od-then-pick',
    title: 'A pick clears the deck: the task is a picked target from then on',
    source: 'rule 1; B1',
    from: '2026-10-19',
    to: '2026-10-23',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [
      { at: '2026-10-19T10:00', run: deck(['task'], '2026-10-21') },
      {
        at: '2026-10-20T10:00',
        run: (ctx) =>
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { due_at: iso('2026-10-22T15:00') },
          }),
      },
      { at: '2026-10-20T10:01', run: check('task', { on_deck_day: null }) },
    ],
    expect: {
      task: {
        // Picked Tue for Thu (wait 2): the day-before heads-up, Wed.
        '2026-10-21': 'upcoming',
        '2026-10-22': 'over 1×',
        '2026-10-23': 'queue_today queued 1×',
      },
    },
  },
  {
    id: 'od-deadline',
    title:
      'A deadline task: decked within its lead, refused after it; the auto target nags as ever',
    source: 'A1; rule 1 ("the deadline protects regardless"); B5',
    from: '2026-10-19',
    to: '2026-10-27',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        // Deadline Fri Oct 30 23:59, set Mon: wait 11 → lead 3 → auto Tue Oct 27 08:30.
        input: { title: 'Synthetic deadline one-off', deadline_at: iso('2026-10-30T23:59') },
      },
    ],
    events: [
      { at: '2026-10-19T10:00', run: refused('task', '2026-10-28', 'after_auto_target') },
      { at: '2026-10-19T10:01', run: deck(['task'], '2026-10-24') },
      {
        at: '2026-10-19T10:02',
        run: check('task', {
          on_deck_day: '2026-10-24',
          due_at: iso('2026-10-27T08:30'),
          target_auto: true,
        }),
      },
      // In the queue with its automatic target kept, until that target arrives.
      { at: '2026-10-25T06:31', run: check('task', { due_at: iso('2026-10-27T08:30') }) },
      // Its auto target has arrived: refused now.
      { at: '2026-10-27T10:00', run: refused('task', '2026-10-27', 'deadline_nagging') },
    ],
    expect: {
      task: {
        // A deck outranks its horizon segment (the deadline would pull it to days).
        '2026-10-23': 'upcoming',
        '2026-10-24': 'deck',
        '2026-10-25': 'queue_today queued',
        '2026-10-26': 'queue_previous queued',
        '2026-10-27': 'over queued 1×',
      },
    },
  },
  {
    id: 'od-deadline-added',
    title: 'A deadline added to a decked task keeps the deck (an automatic target is not a pick)',
    source: 'B1 (the pick-only clear)',
    from: '2026-10-19',
    to: '2026-10-23',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [
      { at: '2026-10-19T10:00', run: deck(['task'], '2026-10-22') },
      {
        at: '2026-10-20T10:00',
        run: (ctx) =>
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { deadline_at: iso('2026-10-30T23:59') },
          }),
      },
      {
        at: '2026-10-20T10:01',
        run: check('task', {
          on_deck_day: '2026-10-22',
          target_auto: true,
          due_at: iso('2026-10-27T08:30'),
        }),
      },
    ],
    expect: {
      task: {
        // The deadline restamped target_set_at (Tue): wait 2 → the day before.
        '2026-10-21': 'upcoming',
        '2026-10-22': 'deck',
        '2026-10-23': 'queue_today queued',
      },
    },
  },
  {
    id: 'od-p4',
    title: 'An Urgent deck goes to Queued too, at the top of the panel',
    source: 'rule 4 ("at every priority"); A8',
    from: '2026-10-19',
    to: '2026-10-20',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      { name: 'low', created: '2026-10-19T09:00', input: UNDATED },
      { name: 'urgent', created: '2026-10-19T09:00', input: { ...UNDATED, priority: 4 } },
    ],
    events: [
      { at: '2026-10-19T10:00', run: deck(['low', 'urgent']) },
      {
        at: '2026-10-20T07:00',
        run: (ctx) => {
          const [panel] = getTaskSegments(ctx.userId, ctx.timezone, new Date(), {
            queuePanels: true,
          })
          expect(panel.horizon).toBe('queue_today')
          expect(panel.tasks.map((r) => r.task.id)).toEqual([ctx.ids.urgent, ctx.ids.low])
        },
      },
      // A sweep at night never touches a deck (it has no target).
      {
        at: '2026-10-19T22:00',
        run: (ctx) =>
          bulkSnooze({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskIds: [ctx.ids.low, ctx.ids.urgent],
            until: iso('2026-10-20T08:30'),
            source: 'sweep',
          }),
      },
    ],
    expect: {
      low: { '2026-10-19': 'deck', '2026-10-20': 'queue_today queued' },
      urgent: { '2026-10-19': 'deck', '2026-10-20': 'queue_today queued' },
    },
  },
  {
    id: 'od-roll-over-now',
    title: "Roll over now strips today's deck and leaves tomorrow's",
    source: 'A3',
    from: '2026-10-19',
    to: '2026-10-21',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      { name: 'today', created: '2026-10-19T09:00', input: UNDATED },
      { name: 'tomorrow', created: '2026-10-19T09:00', input: UNDATED },
    ],
    events: [
      { at: '2026-10-19T10:00', run: deck(['today']) },
      { at: '2026-10-19T10:01', run: deck(['tomorrow'], '2026-10-20') },
      {
        at: '2026-10-19T20:00',
        run: (ctx) => {
          const r = runRolloverNow({ userId: ctx.userId })
          expect(r.ids.deck_stripped).toEqual([ctx.ids.today])
        },
      },
    ],
    expect: {
      // Handed to the coming OpenTask day: "today" until Tuesday's rollover passes.
      today: {
        '2026-10-19': 'queue_today queued',
        '2026-10-20': 'queue_today queued',
        '2026-10-21': 'queue_previous queued',
      },
      tomorrow: { '2026-10-20': 'deck', '2026-10-21': 'queue_today queued' },
    },
  },
  {
    id: 'od-dst-spring-forward',
    title:
      'DST: a 02:30 first period on Mar 14 2027 rolls over at 03:00; a 1:30 AM deck that day lasts it',
    source: 'A2; rolloverMoment (next valid minute)',
    from: '2027-03-13',
    to: '2027-03-16',
    policy: ['never'],
    queue: { periods: ['02:30', '12:00', '20:30'] },
    tasks: [
      { name: 'sat', created: '2027-03-13T09:00', input: UNDATED },
      { name: 'sun', created: '2027-03-13T09:00', input: UNDATED },
    ],
    events: [
      { at: '2027-03-13T10:00', run: deck(['sat']) },
      // 01:30 Sunday, before the swallowed 02:30: "today" is calendar Sunday.
      { at: '2027-03-14T01:30', run: deck(['sun']) },
      {
        at: '2027-03-14T03:01',
        run: check('sat', { on_deck_day: null, queued_from_deck_day: '2027-03-13' }),
      },
      { at: '2027-03-14T03:02', run: check('sun', { on_deck_day: '2027-03-14' }) },
    ],
    expect: {
      sat: {
        '2027-03-13': 'deck',
        '2027-03-14': 'queue_today queued',
        '2027-03-15..2027-03-16': 'queue_previous queued',
      },
      sun: {
        // Undated on Saturday, the check-in day: its weeks segment (unset = weeks).
        '2027-03-13': 'weeks',
        '2027-03-14': 'deck',
        '2027-03-15': 'queue_today queued',
        '2027-03-16': 'queue_previous queued',
      },
    },
  },
]
