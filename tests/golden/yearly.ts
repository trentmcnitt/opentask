/**
 * A yearly rule in a named month with no day starts on the 1st (Trent,
 * 2026-10-13): "every year in March" said on Oct 13 is March 1st — not March
 * 13th, which the today rule for open weekly/monthly repeats had taught the AI.
 * The AI post-process stores FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1 with no date
 * (`pinYearlyFirstOfMonth` in src/core/ai/enrichment.ts); this is that task,
 * made with no date, through the real core.
 *
 * Expected lines, from docs/TASK-MODEL.md § Upcoming: the first occurrence is
 * the next March 1st; the wait from creation (Oct 13 → Mar 1) is 139 days, so
 * a heads-up 4 days before (16+) and the day before. Over target from its day
 * ("over 1×"); done that day advances a whole year, so the days after are quiet.
 */
import type { GoldenScenario } from './types'
import { upcoming } from './helpers'

export const yearlyScenarios: GoldenScenario[] = [
  {
    id: 'yr-every-year-in-march-first',
    title: 'Every year in March (no day), made Tue Oct 13 → first Mon Mar 1, not Mar 13',
    source: 'Trent 10-13 "every year in March is March 1st"',
    from: '2026-10-13',
    to: '2027-03-03',
    policy: ['tap', 'complete-repeating'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-13T10:00',
        input: {
          title: 'Synthetic every-March task',
          rrule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
        },
      },
    ],
    expect: {
      task: {
        ...upcoming({ later: ['2027-02-25'], tomorrow: ['2027-02-28'] }),
        '2027-03-01': 'over 1×',
      },
    },
  },
]
