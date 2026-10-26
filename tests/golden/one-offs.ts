/**
 * One-off reference rows: the spec's "Reference dates" table (rev 3 §2) and
 * the one-off rows of `10-12-26-opentask-upcoming-table.md` v7, plus the
 * deadline-only row (§1, §8).
 *
 * WHERE v7 AND THE SPEC DIFFER, THE SPEC WINS. v7 placed the early heads-up at
 * wait/6 days (3–7); the approved rule (rev 3) is 3 days before when the wait
 * is under 16, 4 at 16 or more — so v7's snowmobile (Thu Oct 29; made Sep 1:
 * Sun Oct 25), taxes (Mon Jan 25) and gutters (Sat Apr 10) rows are restated
 * here with the spec's days. v7's deadline-only row (an Upcoming row on Sun
 * Oct 18, nagging Mon Oct 19) predates §8: the automatic target is stored,
 * 3 days before, and has no Upcoming rows — the deadline pull-in shows it.
 *
 * Policy `tap`: every heads-up is considered the day it shows, so a row shows
 * on its heads-up days exactly (carry-over is the Nov 1 pile's subject).
 *
 * SECTIONS (2026-10-25, the Upcoming split): the day before the target is
 * Tomorrow (wait ≥ 2); the default Later day (lead = `deadlineLeadDays(wait)`:
 * 3 days before at a wait of 8–15, 4 at 16+, none up to 7) is Later — the
 * same days as the 10-12 heads-ups.
 */
import type { GoldenScenario } from './types'
import { iso, upcoming } from './helpers'

/** A one-off made at `created` with a 9:00 target on `target`. */
function oneOff(
  id: string,
  title: string,
  source: string,
  created: string,
  target: string,
  heads: { later?: string[]; tomorrow?: string[] },
  after: Record<string, string>,
): GoldenScenario {
  const lastDay = Object.keys(after).sort().at(-1)!
  return {
    id,
    title,
    source,
    from: created.slice(0, 10),
    to: lastDay,
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created,
        input: { title: 'Synthetic one-off', due_at: iso(`${target}T09:00`) },
      },
    ],
    expect: { task: { ...upcoming(heads), ...after } },
  }
}

export const oneOffScenarios: GoldenScenario[] = [
  oneOff(
    'ref-made-sat-for-tue',
    'Made Sat Oct 10, target Tue Oct 13 — wait 3, the day before',
    'spec §2 reference dates; v7; Trent 10-12 "made Saturday for Tuesday"',
    '2026-10-10T10:00',
    '2026-10-13',
    { tomorrow: ['2026-10-12'] },
    { '2026-10-13': 'over 1×', '2026-10-14': 'over 2×' },
  ),
  oneOff(
    'ref-today-for-tomorrow',
    'Made today, target tomorrow — wait 1, no heads-up',
    'spec §2 reference dates; v7; Trent 10-12 "made today for tomorrow"',
    '2026-10-12T10:00',
    '2026-10-13',
    {},
    { '2026-10-13': 'over 1×' },
  ),
  oneOff(
    'ref-thu-oct-15',
    'Target Thu Oct 15 — wait 3',
    'v7 one-off table',
    '2026-10-12T10:00',
    '2026-10-15',
    { tomorrow: ['2026-10-14'] },
    { '2026-10-15': 'over 1×' },
  ),
  oneOff(
    'ref-tue-oct-20',
    'Target Tue Oct 20 — wait 8: 3 days before and the day before',
    'spec §2 reference dates; v7',
    '2026-10-12T10:00',
    '2026-10-20',
    { later: ['2026-10-17'], tomorrow: ['2026-10-19'] },
    { '2026-10-20': 'over 1×' },
  ),
  oneOff(
    'ref-mon-oct-26',
    'Target Mon Oct 26 — wait 14',
    'v7 one-off table',
    '2026-10-12T10:00',
    '2026-10-26',
    { later: ['2026-10-23'], tomorrow: ['2026-10-25'] },
    { '2026-10-26': 'over 1×' },
  ),
  oneOff(
    'ref-snowmobile',
    'Snowmobile, Sun Nov 1 (made Oct 12) — wait 20: 4 days before; DST day; 3× offer',
    'spec §2 reference dates; Trent 10-12 "snowmobile" (v7 said Thu Oct 29)',
    '2026-10-12T10:00',
    '2026-11-01',
    { later: ['2026-10-28'], tomorrow: ['2026-10-31'] },
    { '2026-11-01': 'over 1×', '2026-11-02': 'over 2×', '2026-11-03': 'over 3× →remove' },
  ),
  oneOff(
    'ref-snowmobile-sep-1',
    'Snowmobile, Sun Nov 1, made Sep 1 — wait 61: still 4 days before',
    'v7 one-off table (v7 said Sun Oct 25)',
    '2026-09-01T10:00',
    '2026-11-01',
    { later: ['2026-10-28'], tomorrow: ['2026-10-31'] },
    { '2026-11-01': 'over 1×' },
  ),
  oneOff(
    'ref-taxes',
    'Taxes, Mon Feb 1 2027 — wait 112',
    'spec §2 reference dates; Trent 10-12 "taxes" (v7 said Mon Jan 25)',
    '2026-10-12T10:00',
    '2027-02-01',
    { later: ['2027-01-28'], tomorrow: ['2027-01-31'] },
    { '2027-02-01': 'over 1×' },
  ),
  oneOff(
    'ref-gutters',
    'Gutters, Sat Apr 17 2027 — wait 187, across the March DST change',
    'spec §2 reference dates; Trent 10-12 "gutters" (v7 said Sat Apr 10)',
    '2026-10-12T10:00',
    '2027-04-17',
    { later: ['2027-04-13'], tomorrow: ['2027-04-16'] },
    { '2027-04-17': 'over 1×' },
  ),
  {
    id: 'ref-deadline-only',
    title: 'Deadline only, Fri Oct 23 23:59 (made Mon Oct 12): Days from D−6, auto target Tue',
    source:
      'spec §1 (deadline-only), §8.1/§8.5; TASK-MODEL "a 23:59 deadline 11 days out: Days on D−6 to D−4, then nagging from D−3" (v7 row predates §8)',
    from: '2026-10-12',
    to: '2026-10-24',
    policy: ['tap'],
    tasks: [
      {
        name: 'task',
        created: '2026-10-12T10:00',
        input: { title: 'Synthetic deadline task', deadline_at: iso('2026-10-23T23:59') },
      },
    ],
    // Wait 11 → lead 3 → the automatic target is Tue Oct 20, 9:00 (morning).
    // Until then its unset horizon (weeks) is pulled in by the deadline: weeks
    // through Fri (7.1 days left at 21:00 — and a weeks task made on Monday
    // waits for the next check-in day), days from Sat. Never in Upcoming.
    // An automatic target offers nothing at 3× (Q9).
    expect: {
      task: {
        '2026-10-17..2026-10-19': 'days',
        '2026-10-20': 'over 1×',
        '2026-10-21': 'over 2×',
        '2026-10-22': 'over 3×',
        '2026-10-23': 'over 4×',
        '2026-10-24': 'over 5×',
      },
    },
  },
]
