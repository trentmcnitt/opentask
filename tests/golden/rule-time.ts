/**
 * Every repeating task or reminder has a time of day (Trent, 2026-10-12:
 * "That's supposed to be the default for the day if nothing's set. Nothing
 * should have no time."). A non-quota rule sent with no BYHOUR is stored with
 * one: the time of a date sent with it, else the task's anchor_time, else its
 * date's time, else the user's Morning time setting — read from the setting,
 * never a constant. A quota keeps its bare period rule (`fillRuleTime`,
 * src/core/recurrence/rule-time.ts; docs/TASK-MODEL.md § Recurrence Model).
 *
 * The runner compares day lines, so each timeline is built to come out
 * differently if the wrong time were stored: the day is read between two
 * candidate times, or the task is made between them (the creation day is day
 * 0 only when the rule's time has not passed). Each scenario also reads the
 * stored rule directly (`expectRule`), since a time is a string first.
 *
 * Expected lines, from docs/TASK-MODEL.md: an occurrence is over target from
 * its time ("over 1×"); done advances one cycle, and a 7-day wait gets a
 * Tomorrow the day before, a 3-day wait too ("tomorrow" — no Later: lead 1).
 */
import { getDb } from '@/core/db'
import { getTaskById } from '@/core/tasks/read'
import { updateTask } from '@/core/tasks/update'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'

type GoldenEvent = NonNullable<GoldenScenario['events']>[number]

function setMorning(at: string, time: string): GoldenEvent {
  return {
    at,
    run: (ctx: SimContext) => {
      getDb().prepare('UPDATE users SET morning_time = ? WHERE id = ?').run(time, ctx.userId)
    },
  }
}

/** A direct read of what was stored — the runner's day lines can't show a string. */
function expectRule(
  at: string,
  name: string,
  rrule: string,
  anchorTime: string | null,
): GoldenEvent {
  return {
    at,
    run: (ctx: SimContext) => {
      const task = getTaskById(ctx.ids[name])!
      if (task.rrule !== rrule || task.anchor_time !== anchorTime) {
        throw new Error(
          `${name}: stored ${task.rrule} @ ${task.anchor_time}, expected ${rrule} @ ${anchorTime}`,
        )
      }
    },
  }
}

export const ruleTimeScenarios: GoldenScenario[] = [
  {
    id: 'rt-daily-no-time-gets-morning',
    title: 'FREQ=DAILY sent with no time, Morning 08:30 → daily at 08:30, from the creation day',
    source: 'Trent 10-12 "Nothing should have no time"',
    from: '2026-10-12',
    to: '2026-10-14',
    // Read at 08:45: after 08:30, before the 09:00 default — a daily at 08:30
    // is over every day; one at 09:00 (or a timeless one, which started a day
    // late at local midnight) would not be on Monday.
    at: '08:45',
    policy: ['complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T08:00',
        input: { title: 'Synthetic daily task', rrule: 'FREQ=DAILY' },
      },
    ],
    events: [
      setMorning('2026-10-12T07:00', '08:30'),
      expectRule('2026-10-12T08:01', 'task', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30', '08:30'),
    ],
    expect: {
      task: { '2026-10-12..2026-10-14': 'over 1×' },
    },
  },
  {
    id: 'rt-quota-bare-weekly-stays-bare',
    title: 'A quota on a bare FREQ=WEEKLY keeps it bare: no time, no date, never over target',
    source: 'Trent 10-12 ruling, quotas exempt (§5: a quota names a period, not a moment)',
    from: '2026-10-12',
    to: '2026-10-18',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'quota',
        created: '2026-10-12T08:00',
        input: { title: 'Synthetic quota', rrule: 'FREQ=WEEKLY', progress_target: 3 },
      },
    ],
    events: [
      setMorning('2026-10-12T07:00', '08:30'),
      expectRule('2026-10-12T08:01', 'quota', 'FREQ=WEEKLY', null),
      expectRule('2026-10-18T22:00', 'quota', 'FREQ=WEEKLY', null),
    ],
    // A quota is in no segment and has no target: quiet every day.
    expect: { quota: {} },
  },
  {
    id: 'rt-morning-setting-changed',
    title: 'Morning changed 09:00 → 08:30 between two every-7-days rules made at 08:40 and 08:45',
    source: 'Trent 10-12 ruling: the setting is read, never hardcoded (his own is 08:30)',
    from: '2026-10-12',
    to: '2026-10-19',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'before',
        created: '2026-10-12T08:40',
        input: { title: 'Synthetic weekly task A', rrule: 'FREQ=DAILY;INTERVAL=7' },
      },
      {
        name: 'after',
        created: '2026-10-12T08:45',
        input: { title: 'Synthetic weekly task B', rrule: 'FREQ=DAILY;INTERVAL=7' },
      },
    ],
    events: [
      setMorning('2026-10-12T07:00', '09:00'),
      setMorning('2026-10-12T08:42', '08:30'),
      expectRule(
        '2026-10-12T08:50',
        'before',
        'FREQ=DAILY;INTERVAL=7;BYHOUR=9;BYMINUTE=0',
        '09:00',
      ),
      expectRule(
        '2026-10-12T08:50',
        'after',
        'FREQ=DAILY;INTERVAL=7;BYHOUR=8;BYMINUTE=30',
        '08:30',
      ),
    ],
    expect: {
      // Made at 08:40 for 09:00: its creation day is day 0 — over Monday,
      // done, then a 7-day wait to Mon Oct 19 (heads-up Sunday).
      before: {
        '2026-10-12': 'over 1×',
        '2026-10-18': 'tomorrow',
        '2026-10-19': 'over 1×',
      },
      // Made at 08:45 for 08:30: the time has passed, so the first occurrence
      // is one cycle on — Mon Oct 19 (heads-up Sunday), Monday itself quiet.
      after: {
        '2026-10-18': 'tomorrow',
        '2026-10-19': 'over 1×',
      },
    },
  },
  {
    id: 'rt-anchor-time-before-morning',
    title: 'A rule with no BYHOUR on a task anchored at 10:00 → BYHOUR=10;BYMINUTE=0, not Morning',
    source: 'Coordinator 10-12: fill from the task anchor_time first, then Morning time',
    from: '2026-10-12',
    to: '2026-10-15',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T08:00',
        input: {
          title: 'Synthetic anchored task',
          rrule: 'FREQ=DAILY;INTERVAL=7;BYHOUR=10;BYMINUTE=0',
        },
        // A legacy row: the rule lost its time, the anchor kept 10:00.
        after: (id) => {
          getDb().prepare("UPDATE tasks SET rrule = 'FREQ=DAILY;INTERVAL=7' WHERE id = ?").run(id)
        },
      },
    ],
    events: [
      setMorning('2026-10-12T07:00', '09:00'),
      {
        // A new rule with no time, sent at 09:30 — after Morning (09:00), before 10:00.
        at: '2026-10-12T09:30',
        run: (ctx) => {
          updateTask({
            userId: ctx.userId,
            userTimezone: ctx.timezone,
            taskId: ctx.ids.task,
            input: { rrule: 'FREQ=DAILY;INTERVAL=3' },
          })
        },
      },
      expectRule('2026-10-12T09:31', 'task', 'FREQ=DAILY;INTERVAL=3;BYHOUR=10;BYMINUTE=0', '10:00'),
    ],
    expect: {
      // 10:00 has not passed at 09:30: today is day 0 — over Monday, done,
      // then a 3-day wait to Thu Oct 15 (heads-up Wednesday). Filled from
      // Morning (09:00, passed) it would have started Thursday instead.
      task: {
        '2026-10-12': 'over 1×',
        '2026-10-14': 'tomorrow',
        '2026-10-15': 'over 1×',
      },
    },
  },
]
