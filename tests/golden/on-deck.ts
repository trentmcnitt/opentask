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
 * deck section, `onDeckToday`); "tomorrow" / "later" = a future deck's (or a
 * picked target's) Upcoming day, by section (2026-10-25: Tomorrow the day
 * before, Later the lead's day); "queue_today queued" / "queue_previous queued" =
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
    title:
      'At 1 AM "today" is the day that is ending: a deck for today is queued at the 6:30 rollover; one for Tomorrow lasts the coming day',
    // "Day starts at" PR 2 (Trent, 2026-10-24: everything uses the OpenTask
    // date). Under A2 a 1 AM deck for "today" was the coming CALENDAR day and
    // lasted it; a deck day is now an OpenTask date, so at 01:00 Tuesday
    // (06:30 start) "today" is Monday — its rollover at 06:30 queues the
    // deck — and the late night's pick for the coming day is Tomorrow
    // (Tuesday), which is on deck all Tuesday and queued at Wednesday's.
    source: '"Day starts at" PR 2 (replaces A2); rule 4',
    from: '2026-10-19',
    to: '2026-10-22',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      { name: 'task', created: '2026-10-19T09:00', input: UNDATED },
      { name: 'late', created: '2026-10-19T09:00', input: UNDATED },
    ],
    events: [
      { at: '2026-10-20T01:00', run: deck(['task']) },
      { at: '2026-10-20T01:01', run: deck(['late'], '2026-10-20') },
      { at: '2026-10-20T01:02', run: check('task', { on_deck_day: '2026-10-19' }) },
      // The 6:30 rollover the same morning: Monday's deck has ended.
      {
        at: '2026-10-20T06:31',
        run: check('task', { on_deck_day: null, queued_from_deck_day: '2026-10-19' }),
      },
      { at: '2026-10-20T06:32', run: check('late', { on_deck_day: '2026-10-20' }) },
    ],
    expect: {
      task: {
        '2026-10-20': 'queue_today queued',
        '2026-10-21..2026-10-22': 'queue_previous queued',
      },
      late: {
        '2026-10-20': 'deck',
        '2026-10-21': 'queue_today queued',
        '2026-10-22': 'queue_previous queued',
      },
    },
  },
  {
    id: 'od-saturday',
    title: 'A Saturday deck made Monday: Upcoming Friday, on deck Saturday, Queued Sunday',
    source: 'rule 5 (Upcoming heads-up, wait 5 → the day before: Tomorrow); rule 4',
    from: '2026-10-19',
    to: '2026-10-26',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [{ at: '2026-10-19T10:00', run: deck(['task'], '2026-10-24') }],
    expect: {
      task: {
        '2026-10-23': 'tomorrow',
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
        // Picked Tue for Thu (wait 2): Tomorrow on Wed.
        '2026-10-21': 'tomorrow',
        '2026-10-22': 'over 1×',
        '2026-10-23': 'queue_today queued 1×',
      },
    },
  },
  {
    id: 'od-deadline',
    title:
      'A deadline task: decked up to its deadline day, refused after it; the expired deck is cleared, never queued',
    source: 'A1 (the deadlines page, 2026-10-22, plan §5); rule 7',
    from: '2026-10-19',
    to: '2026-10-31',
    policy: ['never'],
    queue: QUEUE,
    tasks: [
      {
        name: 'task',
        created: '2026-10-19T09:00',
        // Deadline Fri Oct 30 23:59, set Mon: wait 11 → lead 3 → lead day Tue Oct 27.
        input: { title: 'Synthetic deadline one-off', deadline_at: iso('2026-10-30T23:59') },
      },
    ],
    events: [
      // A1: any day up to the deadline's own day; the day after is refused.
      { at: '2026-10-19T10:00', run: refused('task', '2026-10-31', 'after_auto_target') },
      { at: '2026-10-19T10:01', run: deck(['task'], '2026-10-24') },
      {
        at: '2026-10-19T10:02',
        run: check('task', {
          on_deck_day: '2026-10-24',
          due_at: null,
          target_auto: false,
          lead_from: '2026-10-27',
        }),
      },
      // A deadline task's expired deck is cleared, never queued (plan §5).
      { at: '2026-10-25T06:31', run: check('task', { on_deck_day: null, queued_at: null }) },
      // The deadline has passed: refused now.
      { at: '2026-10-31T10:00', run: refused('task', '2026-10-31', 'deadline_nagging') },
    ],
    expect: {
      task: {
        // Rule 3 (the Upcoming split, 2026-10-25, strict): a target-less
        // deadline task is never in Upcoming — no deck row before its deck
        // day, no heads-up before its lead day. The deck day itself is the On
        // deck section's.
        '2026-10-24': 'deck',
        '2026-10-27..2026-10-28': 'deadlines',
        '2026-10-29..2026-10-31': 'deadlines net',
      },
    },
  },
  {
    id: 'od-deadline-added',
    title:
      'A deadline added to a decked task keeps the deck; the expired deck is cleared, never queued',
    source: 'B1 (the pick-only clear); plan §5',
    from: '2026-10-19',
    to: '2026-10-28',
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
        // Tue → Fri Oct 30: wait 10 → lead 3 → Tue Oct 27.
        run: check('task', {
          on_deck_day: '2026-10-22',
          target_auto: false,
          due_at: null,
          lead_from: '2026-10-27',
        }),
      },
      { at: '2026-10-23T06:31', run: check('task', { on_deck_day: null, queued_at: null }) },
    ],
    expect: {
      task: {
        // Rule 3 (2026-10-25, strict): with its deadline it is a target-less
        // deadline task — no Upcoming row for its deck, none before its lead
        // day. On deck on its deck day, then the page.
        '2026-10-22': 'deck',
        '2026-10-27..2026-10-28': 'deadlines',
      },
    },
  },
  {
    id: 'od-deadline-wins',
    title: 'A deadline added BEFORE the deck day wins: the deck goes, the deadlines page holds it',
    source: 'A1 (plan §5): a deck day after the deadline day is refused',
    from: '2026-10-19',
    to: '2026-10-25',
    policy: ['never'],
    queue: QUEUE,
    tasks: [{ name: 'task', created: '2026-10-19T09:00', input: UNDATED }],
    events: [
      { at: '2026-10-19T10:00', run: deck(['task'], '2026-10-24') },
      // Tue: deadline Fri Oct 23 23:59, before the deck's Saturday: the
      // deadline wins. Wait 3 → lead 1 → Thu Oct 22, the safety net's start.
      {
        at: '2026-10-20T10:00',
        run: (ctx) =>
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { deadline_at: iso('2026-10-23T23:59') },
          }),
      },
      {
        at: '2026-10-20T10:01',
        run: check('task', { on_deck_day: null, due_at: null, lead_from: '2026-10-22' }),
      },
    ],
    expect: {
      task: {
        // Quiet until its lead day (rule 3, 2026-10-25: no heads-up before it).
        '2026-10-22..2026-10-25': 'deadlines net',
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
      'DST: a 02:30 first period on Mar 14 2027 rolls over at 03:00; a 1:30 AM deck for "today" is Saturday\'s, one for Tomorrow lasts Sunday',
    // "Day starts at" PR 2 (2026-10-24): at 01:30 Sunday, before the swallowed
    // 02:30, the OpenTask day is still Saturday (it runs to 03:00, the next
    // valid minute), so a deck for "today" is Saturday's and the 03:00
    // rollover queues it with Saturday's; Tomorrow — Sunday — is on deck from
    // 03:00 and queued at Monday's 02:30. (Under A2 a 1:30 deck for "today"
    // was calendar Sunday.)
    source: '"Day starts at" PR 2 (replaces A2); dayStartMoment (next valid minute)',
    from: '2027-03-13',
    to: '2027-03-16',
    policy: ['never'],
    queue: { periods: ['02:30', '12:00', '20:30'], dayStart: '02:30' },
    tasks: [
      { name: 'sat', created: '2027-03-13T09:00', input: UNDATED },
      { name: 'sun', created: '2027-03-13T09:00', input: UNDATED },
      { name: 'late', created: '2027-03-13T09:00', input: UNDATED },
    ],
    events: [
      { at: '2027-03-13T10:00', run: deck(['sat']) },
      // 01:30 Sunday, before the swallowed 02:30: "today" is still Saturday.
      { at: '2027-03-14T01:30', run: deck(['late']) },
      { at: '2027-03-14T01:31', run: deck(['sun'], '2027-03-14') },
      { at: '2027-03-14T01:32', run: check('late', { on_deck_day: '2027-03-13' }) },
      {
        at: '2027-03-14T03:01',
        run: check('sat', { on_deck_day: null, queued_from_deck_day: '2027-03-13' }),
      },
      {
        at: '2027-03-14T03:02',
        run: check('late', { on_deck_day: null, queued_from_deck_day: '2027-03-13' }),
      },
      { at: '2027-03-14T03:03', run: check('sun', { on_deck_day: '2027-03-14' }) },
    ],
    expect: {
      sat: {
        '2027-03-13': 'deck',
        '2027-03-14': 'queue_today queued',
        '2027-03-15..2027-03-16': 'queue_previous queued',
      },
      late: {
        // Undated on Saturday, the check-in day: its weeks segment (unset = weeks).
        '2027-03-13': 'weeks',
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
