/**
 * The creation day is day 0 (Trent, 2026-10-12): a repeating task made with
 * no date, on a rule whose phase floats (every N days/weeks/months, or a bare
 * FREQ=WEEKLY with no day), takes its first occurrence from the day it is
 * made — that day itself if its time has not passed, else the next grid point
 * — and every later occurrence stays on that grid, whenever it is done
 * (`computeFirstOccurrence`, `phaseFloats` in compute-next.ts).
 *
 * "If I create it on a Sunday and it's every 7 days, and I complete it on
 * that Thursday, then it should pop up on the Sunday."
 *
 * None of these tasks is created with a date. Before the fix the first date
 * came from the 2020 epoch's grid (every 22 days made Oct 12 → Oct 22; a bare
 * weekly → a Wednesday).
 *
 * Expected lines, from docs/TASK-MODEL.md: the occurrence's day is over target
 * from its time ("over 1×", +1 each further day, no 3× offer on a repeating
 * task); done advances to the next grid point, attempts reset, and that
 * occurrence's wait counts from the completion — a heads-up the day before
 * when the wait is 2+, and one more (3 days before under 16, 4 at 16+) when
 * it is over 7. The done day itself is quiet.
 */
import { markDone } from '@/core/tasks/mark-done'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario } from './types'
import { headsUps, iso, upcoming } from './helpers'

const EVERY_7_DAYS = 'FREQ=DAILY;INTERVAL=7;BYHOUR=12;BYMINUTE=0'
const BARE_WEEKLY = 'FREQ=WEEKLY;BYHOUR=12;BYMINUTE=0'

function doneAt(at: string): NonNullable<GoldenScenario['events']>[number] {
  return {
    at,
    run: (ctx: SimContext) => {
      markDone({ userId: ctx.userId, userTimezone: ctx.timezone, taskId: ctx.ids.task })
    },
  }
}

/**
 * Made Sun Oct 11 at 10:00 for noon, done Thu Oct 15 at 18:00 → Sun Oct 18.
 * Sun–Wed over target (1×–4×); Thursday's completion makes the wait to
 * Sunday 3 days: Tomorrow on Saturday (no Later: lead 1).
 */
function sundayDoneThursday(id: string, rrule: string, what: string): GoldenScenario {
  return {
    id,
    title: `${what}, made Sunday before its time, done Thursday → the next Sunday`,
    source: 'Trent 10-12 "created on a Sunday … complete it on that Thursday"',
    from: '2026-10-11',
    to: '2026-10-18',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-11T10:00',
        input: { title: 'Synthetic every-week task', rrule },
      },
    ],
    events: [doneAt('2026-10-15T18:00')],
    expect: {
      task: {
        '2026-10-11': 'over 1×',
        '2026-10-12': 'over 2×',
        '2026-10-13': 'over 3×',
        '2026-10-14': 'over 4×',
        '2026-10-17': 'tomorrow',
        '2026-10-18': 'over 1×',
      },
    },
  }
}

export const creationDayScenarios: GoldenScenario[] = [
  sundayDoneThursday('cd-every-7-days-sunday', EVERY_7_DAYS, 'Every 7 days'),
  sundayDoneThursday('cd-bare-weekly-sunday', BARE_WEEKLY, 'Weekly with no day (bare FREQ=WEEKLY)'),
  {
    id: 'cd-every-22-days-before-its-time',
    title: 'Every 22 days at 8 PM, made Mon Oct 12 at 10 AM — first Oct 12, then Nov 3, Nov 25',
    source: 'Trent 10-12 "every 22 days … the creation day is day 0"',
    from: '2026-10-12',
    to: '2026-11-25',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        input: {
          title: 'Synthetic 22-day task',
          rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=20;BYMINUTE=0',
        },
      },
    ],
    // Each occurrence done on its day (21:00): the wait to the next is 22 —
    // Later 4 days before, Tomorrow the day before.
    expect: {
      task: {
        ...upcoming({
          later: ['2026-10-30', '2026-11-21'],
          tomorrow: ['2026-11-02', '2026-11-24'],
        }),
        ...headsUps(['2026-10-12', '2026-11-03', '2026-11-25'], 'over 1×'),
      },
    },
  },
  {
    id: 'cd-every-22-days-after-its-time',
    title:
      'Every 22 days at 9 AM, made Mon Oct 12 at 10 AM — time passed: first Nov 3, then Nov 25',
    source: 'Trent 10-12 "if the time has already passed → Nov 3"',
    from: '2026-10-12',
    to: '2026-11-25',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        input: {
          title: 'Synthetic 22-day task',
          rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0',
        },
      },
    ],
    expect: {
      task: {
        ...upcoming({
          later: ['2026-10-30', '2026-11-21'],
          tomorrow: ['2026-11-02', '2026-11-24'],
        }),
        ...headsUps(['2026-11-03', '2026-11-25'], 'over 1×'),
      },
    },
  },
  {
    id: 'cd-bare-weekly-done-late',
    title:
      'Weekly with no day, made Sunday: done on the day, then done Tuesday late → still Sunday',
    source: 'Trent 10-12 (done late stays on the grid)',
    from: '2026-10-11',
    to: '2026-10-25',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-11T10:00',
        input: { title: 'Synthetic every-week task', rrule: BARE_WEEKLY },
      },
    ],
    // Oct 11 done 14:00 → Oct 18 (wait 7: Tomorrow Saturday). Oct 18 missed;
    // done Tue Oct 20 → Sun Oct 25, not Tue Oct 27 (wait 5: Tomorrow Saturday).
    events: [doneAt('2026-10-11T14:00'), doneAt('2026-10-20T15:00')],
    expect: {
      task: {
        '2026-10-17': 'tomorrow',
        '2026-10-18': 'over 1×',
        '2026-10-19': 'over 2×',
        '2026-10-24': 'tomorrow',
        '2026-10-25': 'over 1×',
      },
    },
  },
  {
    id: 'cd-every-7-days-done-early',
    title: 'Every 7 days, made Sunday: done on the day, then done Friday early → the Sunday after',
    source: 'Trent 10-12 (done early: one cycle, on the grid)',
    from: '2026-10-11',
    to: '2026-10-25',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-11T10:00',
        input: { title: 'Synthetic every-week task', rrule: EVERY_7_DAYS },
      },
    ],
    // Oct 11 done 14:00 → Oct 18. Done Fri Oct 16 (before Oct 18) → Oct 25:
    // Saturday Oct 17's heads-up never comes; the wait Fri → Sun is 9 (Later
    // Thu, Tomorrow Sat).
    events: [doneAt('2026-10-11T14:00'), doneAt('2026-10-16T18:00')],
    expect: {
      task: {
        '2026-10-22': 'later',
        '2026-10-24': 'tomorrow',
        '2026-10-25': 'over 1×',
      },
    },
  },
  // A repeat MADE WITH A DATE today whose time has passed starts at its next
  // occurrence (designer 2026-10-16, the same day-0 ruling; createTask →
  // rollPassedFirstOccurrence). Fri Oct 16 2026.
  {
    id: 'cd-weekly-friday-dated-made-after-its-time',
    title: 'Weekly Friday 5 PM, given today 5 PM, made Fri 8:30 PM — first next Friday',
    source: 'designer 10-16 ("submit my timesheet every Friday by 5pm" made Fri 8:30 PM)',
    from: '2026-10-16',
    to: '2026-10-23',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-16T20:30',
        input: {
          title: 'Synthetic weekly Friday task',
          due_at: iso('2026-10-16T17:00'),
          rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
        },
      },
    ],
    // Not over target the evening it is made. The wait to Oct 23 is under 7
    // days: Tomorrow only.
    expect: { task: { '2026-10-22': 'tomorrow', '2026-10-23': 'over 1×' } },
  },
  {
    id: 'cd-weekly-friday-dated-made-before-its-time',
    title: 'Weekly Friday 5 PM, given today 5 PM, made Fri 3 PM — today is the first',
    source: 'designer 10-16 (time still ahead: unchanged)',
    from: '2026-10-16',
    to: '2026-10-16',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-16T15:00',
        input: {
          title: 'Synthetic weekly Friday task',
          due_at: iso('2026-10-16T17:00'),
          rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
        },
      },
    ],
    expect: { task: { '2026-10-16': 'over 1×' } },
  },
  {
    // An EARLIER DAY rolls too (designer 2026-10-16 follow-up): the mortgage
    // case, "pay mortgage on the 15th of every month" made Oct 16 and dated
    // Oct 15 by the model → its next occurrence, Nov 15.
    id: 'cd-monthly-15th-dated-yesterday',
    title: '15th of every month at 9 AM, given Oct 15, made Fri Oct 16 — first Nov 15',
    source: 'designer 10-16 ("pay mortgage on the 15th of every month")',
    from: '2026-10-16',
    to: '2026-11-15',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-16T10:00',
        input: {
          title: 'Synthetic monthly task',
          due_at: iso('2026-10-15T09:00'),
          rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
        },
      },
    ],
    // Not over target at birth. The wait to Nov 15 is 30 days: Later 4 days
    // before, Tomorrow the day before.
    expect: {
      task: {
        ...upcoming({ later: ['2026-11-11'], tomorrow: ['2026-11-14'] }),
        '2026-11-15': 'over 1×',
      },
    },
  },
  {
    id: 'cd-daily-dated-made-after-its-time',
    title: 'Daily 7 AM, given today 7 AM, made at 10 AM — first tomorrow 7 AM',
    source: 'designer 10-16',
    from: '2026-10-16',
    to: '2026-10-17',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-16T10:00',
        input: {
          title: 'Synthetic daily task',
          due_at: iso('2026-10-16T07:00'),
          rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
        },
      },
    ],
    expect: { task: { '2026-10-17': 'over 1×' } },
  },
]
