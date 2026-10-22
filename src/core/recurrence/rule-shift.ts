/**
 * MOVING A RULE'S DAYS (pure). A rule that walks one date of a repeating task
 * can be rewritten to walk another date a fixed number of local days away —
 * the deadline-anchor migration (`migrate-repeat-anchor.ts`) moves a rule
 * that walked the target onto its deadline, and the task editor's "every
 * time" mode (`src/lib/every-time.ts`) does the same when a deadline is added
 * at a time earlier in the day than the target's (the deadline goes on the
 * NEXT day, plan A2), and the reverse when a deadline-anchored repeat goes
 * back to its target (the rule moves back to the target's days, plan A3).
 *
 * Two steps, both needed:
 *  1. `shiftRuleDays` rewrites the text: each BYDAY weekday, each BYMONTHDAY.
 *     It refuses what it can't express (a BYSETPOS, a negative month day, a
 *     month day leaving 1–28);
 *  2. `shiftedRuleHolds` PROVES the rewrite: an ordinal weekday ("1SA" + 1 is
 *     "1SU", which is not always the day after the 1st Saturday) or a week
 *     boundary under INTERVAL can rewrite cleanly yet walk different days.
 *     Walking both rules (`deadlineWalk`: 60 occurrences or a year) settles it.
 *
 * Browser-safe: no database, only the recurrence engine and Luxon (the RT-11
 * guard in tests/behavioral/tm-every-time.test.ts walks the imports).
 */

import { DateTime } from 'luxon'
import { deadlineWalk, type RepeatRule } from '@/lib/task-segments'

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
/** Parts a day shift can't be expressed through: refused, never guessed. */
const UNSHIFTABLE = /^(BYSETPOS|BYYEARDAY|BYWEEKNO)=/i

/**
 * The rule's DAYS moved `days` local days (later when positive, earlier when
 * negative): each BYDAY weekday (its ordinal kept — "1SA" + 1 is "1SU", which
 * `shiftedRuleHolds` then checks), each BYMONTHDAY (only while both the old
 * and the new day are within 1–28, every month's days). Null when the shift
 * can't be expressed: a BYSETPOS / BYYEARDAY / BYWEEKNO, a negative or late
 * month day. Other parts (BYHOUR, INTERVAL, …) are kept as they are.
 */
export function shiftRuleDays(rrule: string, days: number): string | null {
  if (days === 0) return rrule
  const parts = rrule.split(';').filter((p) => p !== '')
  if (parts.some((p) => UNSHIFTABLE.test(p))) return null
  const out: string[] = []
  for (const part of parts) {
    const [key, value] = part.split('=')
    if (/^BYDAY$/i.test(key)) {
      const shifted = value.split(',').map((d) => {
        const m = /^([+-]?\d*)([A-Z]{2})$/i.exec(d)
        const i = m ? WEEKDAYS.indexOf(m[2].toUpperCase()) : -1
        // ((i + days) % 7 + 7) % 7: a negative shift wraps (MO − 1 = SU).
        return m && i >= 0 ? `${m[1]}${WEEKDAYS[(((i + days) % 7) + 7) % 7]}` : null
      })
      if (shifted.includes(null)) return null
      out.push(`BYDAY=${shifted.join(',')}`)
    } else if (/^BYMONTHDAY$/i.test(key)) {
      const from = value.split(',').map(Number)
      const shifted = from.map((n) => n + days)
      const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 28
      if (!from.every(inRange) || !shifted.every(inRange)) return null
      out.push(`BYMONTHDAY=${shifted.join(',')}`)
    } else out.push(part)
  }
  return out.join(';')
}

/**
 * The proof a shifted rule is the old one moved: walking the OLD rule from
 * `oldFrom` (one of its occurrences) and the NEW rule from `newFrom`, every
 * step must land `days` local days later, at `newTime` (HH:MM) — over the
 * shared walk (60 occurrences or a year).
 */
export function shiftedRuleHolds(
  old: RepeatRule,
  oldFrom: string,
  rule: RepeatRule,
  newFrom: string,
  days: number,
  newTime: string,
  timezone: string,
): boolean {
  const before = deadlineWalk(old, oldFrom, timezone)
  const after = deadlineWalk(rule, newFrom, timezone)
  if (before.length !== after.length) return false
  return before.every((b, i) => {
    const a = DateTime.fromJSDate(after[i]).setZone(timezone)
    const expected = DateTime.fromJSDate(b).setZone(timezone).plus({ days }).toISODate()
    return a.toISODate() === expected && a.toFormat('HH:mm') === newTime
  })
}
