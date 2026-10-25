/**
 * Repeating reference rows: v7's repeating tables and the 10-12 cases —
 * daily, codes-blog (weekly Sunday, done on the day and done early), a weekly
 * Friday task, every 2 weeks on a Monday, every 10 days over 5 cycles, every
 * 22 days, the monthly 1st across Nov/Dec/Jan (and the Nov 1 DST change),
 * gutters every 6 months, taxes yearly. A weekly Sunday across the March DST
 * change.
 *
 * Policy `tap` + `complete-repeating`: heads-ups considered the day they show,
 * each occurrence done on its day (at 21:00, so the day counted 1×) — the
 * next occurrence's wait then counts from that completion (`target_set_at`).
 * The early heads-up follows the spec's 3/4 rule where v7's wait/6 differs
 * (monthly Nov 1: Wed Oct 28, not Tue Oct 27; Dec 1: Fri Nov 27, not Thu Nov
 * 26; gutters Apr 17: Tue Apr 13, not Sat Apr 10).
 */
import { markDone } from '@/core/tasks/mark-done'
import type { SimContext } from '@/core/sim/day-simulator'
import type { GoldenScenario, GoldenTask } from './types'
import { iso, backdate, headsUps, upcoming } from './helpers'

function repeating(
  id: string,
  title: string,
  source: string,
  from: string,
  to: string,
  task: GoldenTask,
  timeline: Record<string, string>,
  events?: GoldenScenario['events'],
): GoldenScenario {
  return {
    id,
    title,
    source,
    from,
    to,
    policy: ['tap', 'complete-repeating'],
    tasks: [task],
    events,
    expect: { task: timeline },
  }
}

/**
 * Upcoming's days by section and the occurrence days ("over 1×", then done by
 * the policy). Sections (2026-10-25): Tomorrow is each occurrence's day
 * before (wait ≥ 2); Later its default lead (3 days before at a wait of
 * 8–15, 4 at 16+, none up to 7) — the 10-12 heads-up days, unmoved.
 */
function cycles(
  heads: { later?: string[]; tomorrow?: string[] },
  occurrences: string[],
): Record<string, string> {
  return { ...upcoming(heads), ...headsUps(occurrences, 'over 1×') }
}

const SUNDAY_NOON = 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0'

export const repeatingScenarios: GoldenScenario[] = [
  repeating(
    'rep-daily',
    'Daily — wait 1: never a heads-up',
    'spec §2 reference dates; v7 daily',
    '2026-10-12',
    '2026-10-15',
    {
      name: 'task',
      created: '2026-10-12T08:00',
      input: { title: 'Synthetic daily', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    },
    cycles({}, ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']),
  ),
  repeating(
    'rep-codes-blog-on-the-day',
    'Codes-blog, weekly Sunday noon, done on the day — wait 7: Saturday only',
    'spec §2 reference dates; v7 weekly; Trent 10-12 "codes-blog"',
    '2026-10-11',
    '2026-11-01',
    {
      name: 'task',
      created: '2026-10-11T13:00',
      input: { title: 'Synthetic weekly post', rrule: SUNDAY_NOON },
    },
    cycles({ tomorrow: ['2026-10-17', '2026-10-24', '2026-10-31'] }, [
      '2026-10-18',
      '2026-10-25',
      '2026-11-01',
    ]),
  ),
  repeating(
    'rep-codes-blog-early',
    'Codes-blog done Friday for Sunday — the next is the following Sunday, wait 9: Thu and Sat',
    'spec §2 reference dates; Trent 10-12 "codes-blog … done early"',
    '2026-10-11',
    '2026-10-25',
    {
      name: 'task',
      created: '2026-10-11T13:00',
      input: { title: 'Synthetic weekly post', rrule: SUNDAY_NOON },
    },
    // Done Fri Oct 16 18:00: Sat Oct 17's heads-up never comes; the Oct 25
    // occurrence's wait is Fri → Sun, 9 days.
    cycles({ later: ['2026-10-22'], tomorrow: ['2026-10-24'] }, ['2026-10-25']),
    [
      {
        at: '2026-10-16T18:00',
        run: (ctx) => {
          markDoneById(ctx, 'task')
        },
      },
    ],
  ),
  repeating(
    'rep-weekly-friday',
    'Weekly Friday 4 PM — Thursday heads-up each week',
    'Trent 10-12 "a weekly Friday task"; v5/v6 weekly Friday',
    '2026-10-09',
    '2026-10-23',
    {
      name: 'task',
      created: '2026-10-09T17:00',
      input: { title: 'Synthetic Friday task', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0' },
    },
    cycles({ tomorrow: ['2026-10-15', '2026-10-22'] }, ['2026-10-16', '2026-10-23']),
  ),
  repeating(
    'rep-every-2-weeks-monday',
    'Every 2 weeks on a Monday — wait 14: Friday and Sunday',
    'spec §2 reference dates; v7 every 2 weeks; Trent 10-12',
    '2026-10-12',
    '2026-11-23',
    {
      name: 'task',
      created: '2026-10-12T10:00',
      input: {
        title: 'Synthetic fortnightly task',
        rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
        due_at: iso('2026-10-26T09:00'),
      },
    },
    cycles(
      {
        later: ['2026-10-23', '2026-11-06', '2026-11-20'],
        tomorrow: ['2026-10-25', '2026-11-08', '2026-11-22'],
      },
      ['2026-10-26', '2026-11-09', '2026-11-23'],
    ),
  ),
  repeating(
    'rep-every-10-days',
    'Every 10 days (from completion) over 5 cycles — 3 days before and the day before each',
    // v7's "from Thu Oct 8" is counted from each completion, so this is the
    // from-completion mode. (A from-due rule runs on the task's own grid from
    // its first date — see rep-every-22-days — and gives the same days here,
    // each done on its day.)
    'v7 every 10 days; Trent 10-12',
    '2026-10-08',
    '2026-11-27',
    {
      name: 'task',
      created: '2026-10-08T10:00',
      input: {
        title: 'Synthetic ten-day task',
        rrule: 'FREQ=DAILY;INTERVAL=10;BYHOUR=9;BYMINUTE=0',
        recurrence_mode: 'from_completion',
        due_at: iso('2026-10-18T09:00'),
      },
    },
    cycles(
      {
        later: ['2026-10-15', '2026-10-25', '2026-11-04', '2026-11-14', '2026-11-24'],
        tomorrow: ['2026-10-17', '2026-10-27', '2026-11-06', '2026-11-16', '2026-11-26'],
      },
      ['2026-10-18', '2026-10-28', '2026-11-07', '2026-11-17', '2026-11-27'],
    ),
  ),
  repeating(
    'rep-every-22-days',
    'Every 22 days (from due), first target Tue Nov 3 — next Nov 25, Dec 17; wait 22: 4 days before',
    // An "every N" rule runs on the task's OWN grid, anchored at its first
    // target (`gridDtstart`, compute-next.ts; Trent 10-12). Before, the grid
    // was a fixed 2020 epoch's, and a first target off it — Nov 3 — made the
    // next one come early: Nov 13, not Nov 25.
    'v7 every 22 days; Trent 10-12',
    '2026-10-12',
    '2026-12-17',
    {
      name: 'task',
      created: '2026-10-12T10:00',
      input: {
        title: 'Synthetic 22-day task',
        rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0',
        due_at: iso('2026-11-03T09:00'),
      },
    },
    cycles(
      {
        later: ['2026-10-30', '2026-11-21', '2026-12-13'],
        tomorrow: ['2026-11-02', '2026-11-24', '2026-12-16'],
      },
      ['2026-11-03', '2026-11-25', '2026-12-17'],
    ),
  ),
  repeating(
    'rep-monthly-first',
    'Monthly on the 1st, 7 AM, across Nov / Dec / Jan (and the Nov 1 DST change)',
    'spec §2 reference dates (Tue Dec 1: Fri Nov 27, Mon Nov 30; Fri Jan 1: Mon Dec 28, Thu Dec 31); v7 monthly; Trent 10-12',
    '2026-10-01',
    '2027-01-01',
    {
      name: 'task',
      created: '2026-10-01T08:00',
      input: {
        title: 'Synthetic monthly task',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=7;BYMINUTE=0',
      },
    },
    cycles(
      {
        later: ['2026-10-28', '2026-11-27', '2026-12-28'],
        tomorrow: ['2026-10-31', '2026-11-30', '2026-12-31'],
      },
      ['2026-11-01', '2026-12-01', '2027-01-01'],
    ),
  ),
  repeating(
    'rep-gutters-6-months',
    'Gutters every 6 months — wait 182, across the March DST change',
    'v7 every 6 months (v7 said Sat Apr 10)',
    '2026-10-17',
    '2027-04-17',
    {
      name: 'task',
      created: '2026-10-17T10:00',
      input: {
        title: 'Synthetic half-yearly task',
        rrule: 'FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=17;BYHOUR=9;BYMINUTE=0',
        due_at: iso('2027-04-17T09:00'),
      },
    },
    cycles({ later: ['2027-04-13'], tomorrow: ['2027-04-16'] }, ['2027-04-17']),
  ),
  repeating(
    'rep-taxes-yearly',
    'Taxes yearly, last done Feb 1 2026 — wait 365: 4 days before',
    'v7 yearly (v7 said Mon Jan 25)',
    '2026-10-12',
    '2027-02-01',
    {
      name: 'task',
      created: '2026-10-12T10:00',
      input: {
        title: 'Synthetic yearly task',
        rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
        due_at: iso('2027-02-01T09:00'),
      },
      // Last done Feb 1 2026: the wait counts from that completion.
      after: (id) => backdate(id, 'target_set_at', '2026-02-01T09:30'),
    },
    cycles({ later: ['2027-01-28'], tomorrow: ['2027-01-31'] }, ['2027-02-01']),
  ),
  repeating(
    'rep-weekly-across-march-dst',
    'Weekly Sunday 9 AM across Sun Mar 14 2027 (spring forward)',
    'spec Testing: "across DST"',
    '2027-03-07',
    '2027-03-21',
    {
      name: 'task',
      created: '2027-03-07T10:00',
      input: { title: 'Synthetic Sunday task', rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0' },
    },
    cycles({ tomorrow: ['2027-03-13', '2027-03-20'] }, ['2027-03-14', '2027-03-21']),
  ),
]

function markDoneById(ctx: SimContext, name: string): void {
  markDone({ userId: ctx.userId, userTimezone: ctx.timezone, taskId: ctx.ids[name] })
}
