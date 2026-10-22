/**
 * A RULE BEING EDITED (pure; 2026-10-22, editor plan §2.1). The recurrence
 * editors hold a rule as a `RuleDraft` — its frequency, interval, days, month
 * day and end — and turn it back into RRULE text with `buildRule`. The draft
 * has NO time of day: whose time the rule carries depends on what it repeats
 * (the target, or a deadline-anchored repeat's deadline), so the caller
 * passes it (`src/lib/every-time.ts` binds it, RT-2).
 *
 * Taken out of the old `RecurrencePicker.tsx` (its `parseInitialState` and
 * `useRRuleBuilder`; the picker was deleted in PR 4c, the every-time editor
 * builds rules with these). The text is the picker's, part for part:
 *   FREQ ; INTERVAL (>1) ; BYDAY (weekly) | BYDAY[;BYSETPOS] | BYMONTHDAY
 *   (monthly) | BYMONTH[;BYMONTHDAY] (yearly) ; BYHOUR ; BYMINUTE
 * BYHOUR/BYMINUTE are always written: every non-quota rule has a time
 * (`src/core/recurrence/rule-time.ts`).
 *
 * Two things a draft carries through untouched rather than rewriting:
 *  - a monthly rule on a weekday of the month ("the 1st Saturday": BYDAY=1SA,
 *    or BYDAY=FR;BYSETPOS=-1, `monthWeekday`) until a day of the month is
 *    picked — before 2026-10-20 any edit, even its time, made it BYMONTHDAY=1;
 *  - a yearly rule's date (BYMONTH / BYMONTHDAY, `yearDate`) — the picker
 *    used to drop it, which left a bare FREQ=YEARLY floating on whatever date
 *    the engine's grid started from.
 *
 * ENDS (repeat ends, 2026-10-22): the stored rule is end-free — an end lives
 * in the task's `repeat_count` / `repeat_until` fields. The draft still holds
 * the end (`endType` / `endCount` / `endDate`, filled from those fields by
 * `draftFromTask`), and `parseRule` still reads a legacy COUNT / UNTIL, but
 * `buildRule` NEVER writes one: the editor sends the end as its fields
 * (`draftToPatch`), so the rule text alone says whether the pattern changed.
 */

import { formatTime, monthlyDay, parseRRuleParts } from '@/lib/format-rrule'

export type RuleFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type RuleEndType = 'never' | 'count' | 'date'

/** A monthly rule on a weekday of the month, kept as written (see the module doc). */
export interface MonthlyWeekday {
  /** The BYDAY value: "1SA", or "FR" with a BYSETPOS. */
  byDay: string
  setPos: string | null
}

export interface RuleDraft {
  freq: RuleFrequency
  interval: number
  /** WEEKLY: plain RRULE days ("MO".."SU"), in the order picked. */
  days: string[]
  /** MONTHLY: a day of the month, or 'last' (BYMONTHDAY=-1). */
  monthDay: number | 'last'
  /** MONTHLY: a weekday of the month, carried through until a day is picked. */
  monthWeekday: MonthlyWeekday | null
  /** YEARLY: the rule's own BYMONTH[;BYMONTHDAY] parts, carried through. */
  yearDate: string | null
  endType: RuleEndType
  /** COUNT, when `endType` is 'count' (kept while another end is chosen). */
  endCount: number
  /** UNTIL's local date (yyyy-MM-dd), when `endType` is 'date'. */
  endDate: string
}

export const RULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

/** The day chips' labels, Monday first (the picker's `DAYS_OF_WEEK`). */
export const DAYS_OF_WEEK = [
  { id: 'MO', label: 'M', full: 'Monday' },
  { id: 'TU', label: 'T', full: 'Tuesday' },
  { id: 'WE', label: 'W', full: 'Wednesday' },
  { id: 'TH', label: 'T', full: 'Thursday' },
  { id: 'FR', label: 'F', full: 'Friday' },
  { id: 'SA', label: 'S', full: 'Saturday' },
  { id: 'SU', label: 'S', full: 'Sunday' },
] as const

/** A fresh draft's fields (the picker's defaults: every day, never ending). */
export function defaultRuleDraft(freq: RuleFrequency = 'DAILY'): RuleDraft {
  return {
    freq,
    interval: 1,
    days: [],
    monthDay: 1,
    monthWeekday: null,
    yearDate: null,
    endType: 'never',
    endCount: 10,
    endDate: '',
  }
}

/** "HH:MM" → { hour, minute }; null when it doesn't parse. */
export function parseHHMM(
  time: string | null | undefined,
): { hour: number; minute: number } | null {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return { hour: h, minute: m }
}

/** { hour, minute } → "HH:MM". */
export function toHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * The rule's time of day as written (BYHOUR/BYMINUTE), else `initialTime`
 * ("HH:MM"), else 9:00 — the picker's starting time.
 */
export function parseRuleTime(
  rrule: string | null | undefined,
  initialTime?: string | null,
): { hour: number; minute: number } {
  const fallback = parseHHMM(initialTime) ?? { hour: 9, minute: 0 }
  if (!rrule) return fallback
  const parts = parseRRuleParts(rrule)
  return {
    hour: parts.BYHOUR ? parseInt(parts.BYHOUR) : fallback.hour,
    minute: parts.BYMINUTE ? parseInt(parts.BYMINUTE) : fallback.minute,
  }
}

/**
 * The draft of a rule; null for no rule. Unknown frequencies (HOURLY, …) read
 * as daily — no editor can write one.
 */
export function parseRule(rrule: string | null | undefined): RuleDraft | null {
  if (!rrule) return null
  const parts = parseRRuleParts(rrule)
  const defaults = defaultRuleDraft()
  const freq = (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).find((f) => f === parts.FREQ)
  const yearParts = [
    parts.BYMONTH ? `BYMONTH=${parts.BYMONTH}` : null,
    parts.BYMONTHDAY ? `BYMONTHDAY=${parts.BYMONTHDAY}` : null,
  ].filter((p): p is string => p !== null)
  const yearDate = freq === 'YEARLY' && yearParts.length > 0 ? yearParts.join(';') : null
  return {
    freq: freq ?? defaults.freq,
    interval: parts.INTERVAL ? parseInt(parts.INTERVAL) : defaults.interval,
    // The weekly day toggles take plain days: a monthly "1SA" offers SA if the
    // user switches to Weekly (an ordinal is invalid on a weekly rule).
    days: parts.BYDAY
      ? [...new Set(parts.BYDAY.split(',').map((d) => d.replace(/^[+-]?\d+/, '').toUpperCase()))]
      : defaults.days,
    monthDay: parts.BYMONTHDAY
      ? parseInt(parts.BYMONTHDAY) === -1
        ? 'last'
        : parseInt(parts.BYMONTHDAY)
      : defaults.monthDay,
    monthWeekday:
      parts.FREQ === 'MONTHLY' && parts.BYDAY && !parts.BYMONTHDAY
        ? { byDay: parts.BYDAY, setPos: parts.BYSETPOS ?? null }
        : defaults.monthWeekday,
    yearDate,
    endType: parts.COUNT ? 'count' : parts.UNTIL ? 'date' : defaults.endType,
    endCount: parts.COUNT ? parseInt(parts.COUNT) : defaults.endCount,
    endDate: parts.UNTIL
      ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
      : defaults.endDate,
  }
}

/** The RRULE text of a draft at `time` ("HH:MM", or { hour, minute }). */
export function buildRule(
  draft: RuleDraft,
  time: string | { hour: number; minute: number },
): string {
  const { hour, minute } =
    typeof time === 'string' ? (parseHHMM(time) ?? { hour: 9, minute: 0 }) : time
  const parts: string[] = [`FREQ=${draft.freq}`]
  if (draft.interval > 1) parts.push(`INTERVAL=${draft.interval}`)
  if (draft.freq === 'WEEKLY' && draft.days.length > 0) parts.push(`BYDAY=${draft.days.join(',')}`)
  if (draft.freq === 'MONTHLY') {
    if (draft.monthWeekday) {
      parts.push(`BYDAY=${draft.monthWeekday.byDay}`)
      if (draft.monthWeekday.setPos) parts.push(`BYSETPOS=${draft.monthWeekday.setPos}`)
    } else if (draft.monthDay === 'last') {
      parts.push('BYMONTHDAY=-1')
    } else {
      parts.push(`BYMONTHDAY=${draft.monthDay}`)
    }
  }
  if (draft.freq === 'YEARLY' && draft.yearDate) parts.push(draft.yearDate)
  parts.push(`BYHOUR=${hour}`)
  parts.push(`BYMINUTE=${minute}`)
  // Never COUNT / UNTIL: an end travels as `repeat_count` / `repeat_until`
  // (see the module doc), so the rule text is the pattern alone.
  return parts.join(';')
}

/** "the 1st Sat" (`withArticle`) / "1st Sat" for the day select. */
export function monthWeekdayLabel(w: MonthlyWeekday, withArticle: boolean): string {
  const setPos = w.setPos && /^[+-]?\d+$/.test(w.setPos) ? parseInt(w.setPos) : null
  const text = monthlyDay(w.byDay.split(',')[0], setPos)
  return withArticle ? text : text.replace(/^the /, '')
}

function monthlyPreview(monthDay: number | 'last', monthWeekday: MonthlyWeekday | null): string {
  if (monthWeekday) return monthWeekdayLabel(monthWeekday, true)
  return monthDay === 'last' ? 'the last day' : `day ${monthDay}`
}

/** The weekly days in words: "Weekdays", "Weekends", or " on Monday, Friday". */
function weeklyWords(days: string[]): string | null {
  if (days.length === 0) return null
  const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR']
  if (days.length === 5 && weekdays.every((d) => days.includes(d))) return 'Weekdays'
  if (days.length === 2 && ['SA', 'SU'].every((d) => days.includes(d))) return 'Weekends'
  return null
}

/**
 * The draft in words, as the picker previews it: "Every week on Friday at
 * 4:00 PM", "Every month on the 1st Sat at 8:00 AM", "Weekdays at 9:00 AM".
 */
export function describeRuleDraft(
  draft: RuleDraft,
  time: { hour: number; minute: number },
): string {
  const n = draft.interval
  let base = ''
  switch (draft.freq) {
    case 'DAILY':
      base = n === 1 ? 'Every day' : `Every ${n} days`
      break
    case 'WEEKLY': {
      base = n === 1 ? 'Every week' : `Every ${n} weeks`
      const shortcut = weeklyWords(draft.days)
      if (shortcut) base = shortcut
      else if (draft.days.length > 0) {
        const names = draft.days.map((d) => DAYS_OF_WEEK.find((day) => day.id === d)?.full || d)
        base += ` on ${names.join(', ')}`
      }
      break
    }
    case 'MONTHLY':
      base = n === 1 ? 'Every month' : `Every ${n} months`
      base += ` on ${monthlyPreview(draft.monthDay, draft.monthWeekday)}`
      break
    case 'YEARLY':
      base = n === 1 ? 'Every year' : `Every ${n} years`
      break
  }
  base += ` at ${formatTime(time.hour, time.minute)}`
  return base
}

/**
 * A WEEKLY draft must name a day — except from_completion, which schedules N
 * weeks from the completion and ignores BYDAY (its chips are hidden). The
 * server refuses a weekly rule with none (`isValidRRule`).
 */
export function weeklyDayMissing(
  draft: Pick<RuleDraft, 'freq' | 'days'>,
  mode: 'from_due' | 'from_completion',
): boolean {
  return draft.freq === 'WEEKLY' && mode !== 'from_completion' && draft.days.length === 0
}

const PLAIN_DAY = /^(MO|TU|WE|TH|FR|SA|SU)$/
const ORDINAL_DAY = /^[+-]?\d{1,2}(MO|TU|WE|TH|FR|SA|SU)$/
const SINGLE_INT = /^-?\d+$/
const ALWAYS_OK = new Set(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'COUNT', 'UNTIL'])
const ALLOWED_BY_FREQ: Record<string, string[]> = {
  DAILY: [],
  WEEKLY: ['BYDAY'],
  MONTHLY: ['BYDAY', 'BYMONTHDAY', 'BYSETPOS'],
  YEARLY: ['BYMONTH', 'BYMONTHDAY'],
}

/**
 * WHETHER A RULE FITS THE DRAFT (2026-10-22, editor PR 4c review): a rule
 * the editor can't represent part for part must never be rebuilt — `parseRule`
 * would quietly lose what it can't hold (`parseInt('1,15')` makes
 * BYMONTHDAY=1,15 the 1st). The shapes a `RuleDraft` holds exactly:
 *  - DAILY: no BY-day parts;
 *  - WEEKLY: BYDAY of plain days;
 *  - MONTHLY: one BYMONTHDAY (a day or -1); or one BYDAY — an ordinal weekday
 *    ("1SA"), or a plain one with a single BYSETPOS;
 *  - YEARLY: at most one BYMONTH and one BYMONTHDAY;
 * plus FREQ, INTERVAL, one BYHOUR, one BYMINUTE, and a legacy COUNT/UNTIL.
 * Anything else (several month days, several months, BYWEEKNO, BYYEARDAY,
 * WKST, a list of hours, …) every-time mode shows read-only.
 */
export function ruleDraftable(rrule: string): boolean {
  const parts = parseRRuleParts(rrule)
  const freq = parts.FREQ ?? ''
  const allowed = ALLOWED_BY_FREQ[freq]
  if (!allowed) return false
  if (parts.INTERVAL && !/^\d+$/.test(parts.INTERVAL)) return false
  if ([parts.BYHOUR, parts.BYMINUTE].some((v) => v && !SINGLE_INT.test(v))) return false
  const extra = Object.keys(parts).filter((k) => !ALWAYS_OK.has(k))
  if (extra.some((k) => !allowed.includes(k))) return false
  if (freq === 'WEEKLY')
    return !parts.BYDAY || parts.BYDAY.split(',').every((d) => PLAIN_DAY.test(d))
  if (freq === 'MONTHLY') return monthlyDraftable(parts)
  return [parts.BYMONTH, parts.BYMONTHDAY].every((v) => !v || SINGLE_INT.test(v))
}

function monthlyDraftable(parts: Record<string, string>): boolean {
  const { BYDAY, BYMONTHDAY, BYSETPOS } = parts
  if (BYMONTHDAY) return !BYDAY && !BYSETPOS && SINGLE_INT.test(BYMONTHDAY)
  if (!BYDAY) return !BYSETPOS
  if (BYSETPOS) return PLAIN_DAY.test(BYDAY) && SINGLE_INT.test(BYSETPOS)
  return ORDINAL_DAY.test(BYDAY)
}
