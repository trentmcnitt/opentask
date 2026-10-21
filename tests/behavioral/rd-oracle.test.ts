/**
 * RD-ORACLE: the recurrence engine against an independent oracle (2026-10-21).
 *
 * Four engine fixes in ten days (#255 the interval grid's timezone, #258
 * every-N from the creation day, #260 yearly on the 1st of every month, #298
 * "1st Saturday" firing every Saturday) were one class: the engine walked a
 * rule wrong and no test ran that rule through it. Formatting tests used
 * `BYDAY=1MO` strings, but parse them on their own path, so they passed.
 *
 * This file generates rules over the grammar OpenTask accepts (DAILY, WEEKLY,
 * MONTHLY, YEARLY; INTERVAL; BYDAY with and without ordinals; BYMONTHDAY,
 * negative and several; BYMONTH; BYSETPOS) in timezones with and without DST,
 * north and south, and checks:
 *
 *  - RD-ORACLE-01: `computeNextOccurrence` (from_due) gives the same instant
 *    as `expectedNext`, a brute-force walk over local calendar days that
 *    knows nothing of rrule.js: the first day after the reference whose date
 *    satisfies the rule (RFC 5545 semantics), at the rule's time of day.
 *  - RD-ORACLE-02: parse → build gives the canonical string back, and
 *    build → parse gives the components back.
 *  - RD-ORACLE-03: a rule that never occurs (April 31st) is refused by
 *    validation and never given a made-up date.
 *
 * The grid ("every N", and bare rules that take their day from the task's
 * own occurrence, see `phaseFloats` in compute-next.ts) is anchored at
 * `anchorAt`'s local period: its date for DAILY, its Monday-start week for
 * WEEKLY, its month for MONTHLY, its year for YEARLY. Rules that pin their
 * own phase are given an anchor too, and must ignore it.
 *
 * Only rule walking is checked here, not what done or skip do with the
 * result (those move with the repeat-anchor work).
 *
 * Seeded, so a failure reproduces: the message carries the rule, zone,
 * reference and anchor.
 */
import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import {
  buildRRule,
  computeNextOccurrence,
  isValidRRule,
  normalizeRRule,
  parseRRule,
  type RRuleComponents,
} from '@/core/recurrence'
import { NEVER_OCCURS_MESSAGE } from '@/core/recurrence/compute-next'

const SEED = 20261021
const CASES = 3000

/** mulberry32: a tiny seeded PRNG (as in tm-invariants.test.ts). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Zones whose DST changes happen at 01:00–03:00 local, never at midnight, so
 * the times below always exist exactly once. Kolkata (+05:30, no DST) and
 * Sydney/Auckland (southern DST) catch offset and hemisphere assumptions.
 */
const ZONES = [
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Asia/Kolkata',
  'UTC',
]
const HOURS = [0, 7, 9, 12, 18, 23]
const MINUTES = [0, 30]

/** References are spread over three years and crowded around DST changes. */
const REF_START = DateTime.fromISO('2026-01-01T00:00:00Z')
const DST_EDGES = [
  '2026-03-08',
  '2026-03-29',
  '2026-04-05',
  '2026-09-27',
  '2026-10-04',
  '2026-10-25',
  '2026-11-01',
  '2027-03-14',
  '2027-03-28',
]

type Pick = <T>(xs: readonly T[]) => T

function genComponents(r: () => number, pick: Pick): RRuleComponents {
  const freq = pick(['DAILY', 'WEEKLY', 'MONTHLY', 'MONTHLY', 'MONTHLY', 'YEARLY'] as const)
  const interval = r() < 0.3 ? pick([2, 2, 3, 4, 6, 10, 22]) : 1
  const days = (k: number) =>
    [...new Set(Array.from({ length: k }, () => Math.floor(r() * 7)))].sort((a, b) => a - b)
  const c: RRuleComponents = { freq }
  if (interval > 1) c.interval = interval

  if (freq === 'DAILY') {
    // DAILY;BYDAY=… (e.g. weekdays) only at INTERVAL 1.
    if (interval === 1 && r() < 0.4) c.byday = days(1 + Math.floor(r() * 5)).map((day) => ({ day }))
  } else if (freq === 'WEEKLY') {
    c.byday = days(1 + Math.floor(r() * 3)).map((day) => ({ day }))
  } else {
    if (freq === 'YEARLY') {
      // Most yearly rules name a month; a bare FREQ=YEARLY floats on the anchor's date.
      if (r() < 0.85) c.bymonth = r() < 0.85 ? [1 + Math.floor(r() * 12)] : [3, 9]
    }
    const shape = r()
    if (freq === 'YEARLY' && !c.bymonth) {
      // bare
    } else if (shape < 0.35) {
      c.bymonthday = pick([
        1,
        1,
        15,
        28,
        29,
        30,
        31,
        -1,
        -1,
        -2,
        [1, 15],
        [10, 20, 30],
      ] as const) as number | number[]
    } else if (shape < 0.75) {
      // Ordinal weekdays: 1st Saturday, last Friday, 1st and 3rd Monday…
      const day = Math.floor(r() * 7)
      const ns = pick([[1], [2], [3], [4], [5], [-1], [-1], [-2], [1, 3], [2, 4]] as const)
      c.byday = ns.map((n) => ({ day, n }))
    } else if (shape < 0.85) {
      // The last / first weekday of the month.
      c.byday = [0, 1, 2, 3, 4].map((day) => ({ day }))
      c.bysetpos = pick([1, -1] as const)
    } else if (shape < 0.95) {
      // Friday the 13th: plain weekday ∩ month day.
      c.byday = [{ day: Math.floor(r() * 7) }]
      c.bymonthday = pick([1, 13, 28, 31] as const)
    } else {
      c.byday = days(2).map((day) => ({ day }))
    }
    if (freq === 'YEARLY' && c.bymonth && !c.byday && c.bymonthday === undefined) {
      c.bymonthday = 1
    }
  }
  return c
}

// ─── The oracle ──────────────────────────────────────────────────────────
//
// It walks plain calendar dates (a day number, no zone, no rrule.js): Luxon
// is used once, at the end, to put the found date's time of day in the zone.

const DAY_MS = 86_400_000

/** A calendar date: `n` days since 1970-01-01. */
interface CalDay {
  n: number
  year: number
  month: number // 1..12
  day: number
  dow: number // 0 = Monday, as the engine
  dim: number // days in its month
  ordinal: number // day of its year, 1..366
}

function calDay(n: number): CalDay {
  const d = new Date(n * DAY_MS)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  return {
    n,
    year,
    month,
    day: d.getUTCDate(),
    dow: (d.getUTCDay() + 6) % 7,
    dim: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    ordinal: n - Date.UTC(year, 0, 1) / DAY_MS + 1,
  }
}

const dayNumber = (year: number, month: number, day: number) =>
  Date.UTC(year, month - 1, day) / DAY_MS

/** Whether the ordinal `n` (1..5, -1..-5) holds for day `d` within its month. */
function nthInMonth(d: CalDay, n: number): boolean {
  if (n > 0) return Math.ceil(d.day / 7) === n
  return Math.floor((d.dim - d.day) / 7) + 1 === -n
}

/** The rule's day-of-month filter alone (BYMONTHDAY ∩ BYDAY), before BYSETPOS. */
function dayFilter(d: CalDay, c: RRuleComponents, anchor: CalDay): boolean {
  const mds = c.bymonthday === undefined ? null : [c.bymonthday].flat()
  if (!mds && !c.byday?.length) return d.day === anchor.day // bare: the anchor's day
  if (mds && !mds.some((m) => (m > 0 ? d.day === m : d.day === d.dim + m + 1))) return false
  if (c.byday?.length) {
    const ok = c.byday.some((b) => b.day === d.dow && (b.n === undefined || nthInMonth(d, b.n)))
    if (!ok) return false
  }
  return true
}

/** Whether date `d` is a day of the rule, the grid aside. */
function dayOfRule(d: CalDay, c: RRuleComponents, anchor: CalDay): boolean {
  if (c.freq === 'DAILY') return !c.byday?.length || c.byday.some((b) => b.day === d.dow)
  if (c.freq === 'WEEKLY') return c.byday!.some((b) => b.day === d.dow)
  if (c.freq === 'YEARLY') {
    if (c.bymonth ? !c.bymonth.includes(d.month) : d.month !== anchor.month) return false
  }
  if (c.bysetpos === undefined) return dayFilter(d, c, anchor)
  // BYSETPOS picks from the whole period's set (RFC 5545 §3.3.10): the month
  // for MONTHLY, the year (every BYMONTH month) for YEARLY.
  if (!dayFilter(d, c, anchor)) return false
  const yearly = c.freq === 'YEARLY'
  const first = yearly ? dayNumber(d.year, 1, 1) : dayNumber(d.year, d.month, 1)
  const last = yearly ? dayNumber(d.year, 12, 31) : dayNumber(d.year, d.month, d.dim)
  const set: number[] = []
  for (let x = first; x <= last; x++) {
    const xd = calDay(x)
    if (yearly && c.bymonth && !c.bymonth.includes(xd.month)) continue
    if (dayFilter(xd, c, anchor)) set.push(x)
  }
  const p = c.bysetpos
  return set[p > 0 ? p - 1 : set.length + p] === d.n
}

/** Whether date `d` is on the rule's grid of `interval` periods from the anchor's. */
function onGrid(d: CalDay, c: RRuleComponents, anchor: CalDay): boolean {
  const n = c.interval ?? 1
  if (n === 1) return true
  const mod = (x: number) => ((x % n) + n) % n
  if (c.freq === 'DAILY') return mod(d.n - anchor.n) === 0
  // Weeks start Monday.
  if (c.freq === 'WEEKLY') return mod((d.n - d.dow - (anchor.n - anchor.dow)) / 7) === 0
  if (c.freq === 'MONTHLY') return mod((d.year - anchor.year) * 12 + d.month - anchor.month) === 0
  return mod(d.year - anchor.year) === 0
}

/** How far the walk looks. A rarer rule (every 22 years on a 5th Wednesday) is checked only to here. */
const HORIZON_YEARS = 12

/** The first occurrence strictly after `ref`, by walking calendar dates; null past the horizon. */
function expectedNext(
  c: RRuleComponents,
  tz: string,
  ref: DateTime,
  hour: number,
  minute: number,
  anchorAt: DateTime,
): DateTime | null {
  const a = anchorAt.setZone(tz)
  const anchor = calDay(dayNumber(a.year, a.month, a.day))
  const r = ref.setZone(tz)
  const from = dayNumber(r.year, r.month, r.day)
  // The reference's own day counts only if the rule's time is still ahead on it.
  const startsToday = r.hour * 60 + r.minute < hour * 60 + minute
  for (let n = startsToday ? from : from + 1; n < from + HORIZON_YEARS * 365; n++) {
    const d = calDay(n)
    if (onGrid(d, c, anchor) && dayOfRule(d, c, anchor)) {
      return DateTime.fromObject(
        { year: d.year, month: d.month, day: d.day, hour, minute },
        { zone: tz },
      )
    }
  }
  return null
}

/**
 * A yearly rule on a day none of its months has (April 31st, "the 31st of
 * June or September"): it never occurs. Leap days count as possible.
 */
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
function neverOccurs(c: RRuleComponents): boolean {
  if (c.freq !== 'YEARLY' || !c.bymonth || c.bymonthday === undefined) return false
  const mds = [c.bymonthday].flat()
  return c.bymonth.every((m) => mds.every((d) => d > MAX_DAYS[m - 1] || -d > MAX_DAYS[m - 1]))
}

// ─── The tests ───────────────────────────────────────────────────────────

describe('RD-ORACLE: the recurrence engine against a calendar walk (seeded random)', () => {
  const r = rng(SEED)
  const pick: Pick = (xs) => xs[Math.floor(r() * xs.length)]
  const cases = Array.from({ length: CASES }, (_, i) => {
    const c = genComponents(r, pick)
    const tz = pick(ZONES)
    const hour = pick(HOURS)
    const minute = pick(MINUTES)
    const ref =
      r() < 0.4
        ? DateTime.fromISO(pick(DST_EDGES), { zone: tz }).plus({ hours: Math.floor(r() * 72) - 36 })
        : REF_START.plus({ minutes: Math.floor(r() * 3 * 365 * 24 * 60) })
    const anchorAt = ref.plus({ days: Math.floor(r() * 800) - 400, hours: Math.floor(r() * 24) })
    return { i, c, tz, hour, minute, ref, anchorAt }
  })

  test('RD-ORACLE-01: computeNextOccurrence lands where the calendar says', () => {
    const misses: string[] = []
    let checked = 0
    for (const { i, c, tz, hour, minute, ref, anchorAt } of cases) {
      const rule = normalizeRRule(buildRRule(c))
      if (!isValidRRule(rule)) continue
      checked++
      const want = expectedNext(c, tz, ref, hour, minute, anchorAt)
      const got = DateTime.fromJSDate(
        computeNextOccurrence({
          rrule: rule,
          recurrenceMode: 'from_due',
          anchorTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
          timezone: tz,
          completedAt: ref.toJSDate(),
          prevDueAt: null,
          anchorAt: anchorAt.toJSDate(),
        }),
      ).setZone(tz)
      // Nothing within the horizon: right only if the engine's answer is past it too.
      const agrees = want
        ? +got === +want
        : got > ref.plus({ years: HORIZON_YEARS }).minus({ days: 1 })
      if (!agrees) {
        misses.push(
          `#${i} ${rule} @${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${tz}` +
            ` ref=${ref.setZone(tz).toISO()} anchor=${anchorAt.setZone(tz).toISODate()}` +
            ` → got ${got.toISO()} want ${want?.toISO() ?? 'none'}`,
        )
      }
    }
    // Most generated rules are valid; a generator that drifted to mostly
    // invalid ones would check nothing.
    expect(checked).toBeGreaterThan(CASES * 0.9)
    expect(misses.slice(0, 20), `${misses.length} of ${checked} misses`).toEqual([])
  }, 60_000)

  test('RD-ORACLE-02: parse → build is the identity on canonical rules, and build → parse', () => {
    for (const { i, c } of cases) {
      const s = buildRRule(c)
      expect(buildRRule(parseRRule(s)), `#${i} ${s}`).toBe(s)
      expect(parseRRule(s), `#${i} ${s}`).toEqual(c)
    }
  })

  // Found by RD-ORACLE-01, 2026-10-21: FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31 (the
  // 31st of April, June, September or November) passed isValidRRule, and
  // computeNextOccurrence returned the reference + 1 day for it every time.
  // Fixed in 0a05049f: validation refuses a rule that never occurs, and the
  // engine throws rather than invent a date (an older row may still hold one).
  test('RD-ORACLE-03: a rule that never occurs is refused, and never given a date', () => {
    const generated = cases.filter((x) => neverOccurs(x.c))
    // The generator must keep producing them, or this checks nothing.
    expect(generated.length).toBeGreaterThan(0)
    const rules = [
      ...generated.map((x) => normalizeRRule(buildRRule(x.c))),
      'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31',
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=YEARLY;INTERVAL=2;BYMONTH=9;BYMONTHDAY=31',
      'FREQ=YEARLY;BYDAY=TH;BYMONTH=6;BYMONTHDAY=31',
      'FREQ=YEARLY;BYMONTH=4,6,9,11;BYMONTHDAY=31',
    ]
    for (const rule of rules) {
      expect(isValidRRule(rule), rule).toBe(false)
      expect(
        () =>
          computeNextOccurrence({
            rrule: rule,
            recurrenceMode: 'from_due',
            anchorTime: '09:00',
            timezone: 'America/Chicago',
            completedAt: new Date('2026-10-21T15:00:00Z'),
            prevDueAt: null,
            anchorAt: new Date('2026-10-21T14:00:00Z'),
          }),
        rule,
      ).toThrow(NEVER_OCCURS_MESSAGE)
    }
    // Leap day stays possible.
    expect(isValidRRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')).toBe(true)
  })
})
