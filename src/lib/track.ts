/**
 * Track (REDESIGN-V03 §5) — the pure, client-safe half.
 *
 * `src/core/tasks/progress.ts` owns the mutation and imports the database; the
 * row component runs in the browser and only needs to read a task's tracked
 * state and name its period. Kept here so a client bundle never pulls core.
 */
import { DateTime } from 'luxon'
import { getLabelColor, LABEL_COLORS } from '@/lib/label-colors'
import { isReservedLabel } from '@/lib/label-vocabulary'
import { openTaskDayOf } from '@/lib/opentask-day'
import { quotaPeriodEnd, unitStartAt, type PeriodUnit, type WeekStart } from '@/lib/week-start'
import type { LabelColor, LabelConfig, Task } from '@/types'

/**
 * A tracked task is a quota: something to do N times per period. N > 1 implies
 * it; `is_tracked` marks one with N = 1 ("date night, once a month").
 */
export function isTracked(task: Pick<Task, 'progress_target' | 'is_tracked'>): boolean {
  return task.is_tracked === true || (task.progress_target ?? 1) > 1
}

export type TaskKind = 'quota' | 'reminder' | 'task'

/**
 * Which of the three things a task row is — each has its own editor, its own
 * home surface and its own noun. Quota is checked first, matching the order
 * the task page picks an editor in.
 */
export function taskKind(
  task: Pick<Task, 'progress_target' | 'is_tracked' | 'is_reminder'>,
): TaskKind {
  if (isTracked(task)) return 'quota'
  return task.is_reminder ? 'reminder' : 'task'
}

export interface TrackState {
  current: number
  target: number
  /** Reached (or passed) the target. The row stays open until the period rolls over. */
  met: boolean
  /** 0..1 of the target, capped — the bar never overflows even when the count does. */
  fraction: number
}

export function trackState(
  task: Pick<Task, 'progress_target' | 'progress_current'>,
  /** Optimistic override of `progress_current`, when a tap is in flight. */
  currentOverride?: number,
): TrackState {
  const target = Math.max(1, task.progress_target ?? 1)
  const current = Math.max(0, currentOverride ?? task.progress_current ?? 0)
  return { current, target, met: current >= target, fraction: Math.min(1, current / target) }
}

/**
 * The periods a quota can count within — ONE table, because it used to be five.
 *
 * The FREQ→period mapping was written out separately in `periodLabel`, in the
 * editor's chip list, in the editor's own copy of this regex, in
 * `periodShort`'s string rewriting and in `groupByPeriod`'s ordering — and two
 * of those had already drifted into silent data loss: a YEARLY quota and a
 * quota with no rule at all both read back as WEEKLY in the editor, so editing
 * only the target rewrote the schedule underneath the user (found 2026-09-06).
 * Anything that needs to know about periods reads this.
 */
export const QUOTA_PERIODS = [
  {
    freq: 'DAILY',
    label: 'today',
    word: 'today',
    short: 'day',
    suffix: 'd',
    editor: 'Every day',
    noun: 'the day',
  },
  {
    freq: 'WEEKLY',
    label: 'this week',
    word: 'week',
    short: 'week',
    suffix: 'wk',
    editor: 'Every week',
    noun: 'the week',
  },
  {
    freq: 'MONTHLY',
    label: 'this month',
    word: 'month',
    short: 'month',
    suffix: 'mo',
    editor: 'Every month',
    noun: 'the month',
  },
  {
    freq: 'YEARLY',
    label: 'this year',
    word: 'year',
    short: 'year',
    suffix: 'yr',
    editor: 'Every year',
    noun: 'the year',
  },
] as const

export type QuotaFreq = (typeof QUOTA_PERIODS)[number]['freq']

/** The FREQ in an rrule, or null when there isn't one this app understands. */
export function quotaFreqOf(rrule: string | null | undefined): QuotaFreq | null {
  const freq = /(?:^|;)FREQ=([A-Z]+)/i.exec(rrule ?? '')?.[1]?.toUpperCase()
  return QUOTA_PERIODS.find((p) => p.freq === freq)?.freq ?? null
}

/**
 * The period AND its interval — `FREQ=DAILY;INTERVAL=2` is "every other day".
 * `quotaFreqOf` alone reads that as daily, which is right for a label and
 * wrong for anything that counts days: the period rollover advances by
 * `interval` units, so the count resets every two days, not every day.
 */
export function quotaPeriodOf(
  rrule: string | null | undefined,
): { freq: QuotaFreq; interval: number } | null {
  const freq = quotaFreqOf(rrule)
  if (!freq) return null
  const raw = /(?:^|;)INTERVAL=(\d+)/i.exec(rrule ?? '')?.[1]
  const interval = raw ? Math.max(1, Number.parseInt(raw, 10)) : 1
  return { freq, interval }
}

const FREQ_UNIT = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' } as const

/**
 * `quotaPeriodOf` in the calendar units luxon and `quotaPeriodEnd` step by —
 * `FREQ=WEEKLY;INTERVAL=2` is `{ unit: 'weeks', interval: 2 }`. The rollover
 * cron and `effectiveProgress` both read a quota's period through here, so
 * they can't disagree about when it ends.
 */
export function quotaPeriodUnit(
  rrule: string | null | undefined,
): { unit: PeriodUnit; interval: number } | null {
  const period = quotaPeriodOf(rrule)
  return period ? { unit: FREQ_UNIT[period.freq], interval: period.interval } : null
}

/**
 * INTERVAL QUOTAS (2026-10-16): how many units one period may span — "every
 * 2 weeks" is `FREQ=WEEKLY;INTERVAL=2`. ONE table for the editor's "every N"
 * stepper range and the server's cap (`quotaIntervalAllowed`, refused on
 * create and edit), so the two cannot drift. A yearly quota has no stepper:
 * every year is the only choice.
 */
export const QUOTA_INTERVAL_MAX: Record<QuotaFreq, number> = {
  DAILY: 30,
  WEEKLY: 12,
  MONTHLY: 12,
  YEARLY: 1,
}

/** Is this rule's INTERVAL inside its period's range? A rule with no period has nothing to cap. */
export function quotaIntervalAllowed(rrule: string | null | undefined): boolean {
  const period = quotaPeriodOf(rrule)
  return period === null || period.interval <= QUOTA_INTERVAL_MAX[period.freq]
}

/**
 * A quota rule in canonical form: `FREQ=X`, plus `;INTERVAL=N` only above 1.
 * The validator refuses INTERVAL before FREQ, so every writer goes through here.
 */
export function quotaRule(freq: QuotaFreq, interval: number): string {
  return interval > 1 ? `FREQ=${freq};INTERVAL=${interval}` : `FREQ=${freq}`
}

/**
 * The start of the unit `local` falls in, by the user's clock — where a
 * quota's period is anchored: the day start of the user's first day of the
 * week, of the 1st of the month, of the day, of Jan 1 — by OpenTask date
 * ("Day starts at" PR 2, `unitStartAt`; midnight with the task queue off).
 * The ONE anchor rule: create, a period edit and the rollover's first pass
 * all anchor through here. INTERVAL plays no part — a fortnight made this
 * week starts on this week's first day.
 */
export function quotaUnitStart(
  local: DateTime,
  unit: PeriodUnit,
  weekStart: WeekStart,
  dayStart: string,
): DateTime {
  return unitStartAt(local, unit, weekStart, dayStart)
}

/**
 * The quota's CURRENT period window `[start, end)`, as of `now`, in `timezone`.
 *
 * The rollover's own stepping (`period-rollover.ts`), made pure: from the
 * stored anchor, step `start = end` while the window has ended. So a window
 * the cron has not closed yet (it runs every five minutes) already reads as
 * the next one — the label a client draws never names a period that is over.
 * A quota with no anchor yet (one made before anchors were stamped at create)
 * reads from the start of the unit it is in, which is where the rollover's
 * first pass will anchor it. Null for a row with no period.
 */
export function quotaWindow(
  task: Pick<Task, 'rrule' | 'progress_period_start'>,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): { start: DateTime; end: DateTime; interval: number } | null {
  const period = quotaPeriodUnit(task.rrule)
  if (!period) return null
  const local = DateTime.fromJSDate(now).setZone(timezone)
  if (!local.isValid) return null
  const anchored = task.progress_period_start
    ? DateTime.fromISO(task.progress_period_start, { zone: 'utc' }).setZone(timezone)
    : null
  let start =
    anchored && anchored.isValid
      ? anchored
      : quotaUnitStart(local, period.unit, weekStart, dayStart)
  let end = quotaPeriodEnd(start, period.unit, period.interval, weekStart, dayStart)
  while (local >= end) {
    start = end
    end = quotaPeriodEnd(start, period.unit, period.interval, weekStart, dayStart)
  }
  return { start, end, interval: period.interval }
}

/**
 * The period fields the server serves on every quota (tasks and prompts), so
 * no client — web or native — repeats `quotaPeriodEnd`:
 *
 * - `progress_period_end`: the current window's end, UTC, EXCLUSIVE.
 * - `period_interval`: the rule's INTERVAL (1 when it has none).
 * - `period_last_day`: the window's last OpenTask day, `YYYY-MM-DD` — the
 *   day the window's last instant belongs to (`openTaskDayOf`; with an 11 PM
 *   start a week ends on Saturday at 23:00 — its last day is Saturday). At
 *   midnight, the end minus one day.
 * - `period_label`: "by Oct 24" (that last day) for an interval above 1;
 *   NULL at interval 1, where every client keeps its own words ("this week",
 *   "wk", "today") — a fortnight cannot be called "this week", but a week can.
 *
 * All null on a row that is not a quota, or has no period.
 */
export interface QuotaPeriodFields {
  progress_period_end: string | null
  period_interval: number | null
  period_last_day: string | null
  period_label: string | null
}

export const NO_QUOTA_PERIOD: QuotaPeriodFields = {
  progress_period_end: null,
  period_interval: null,
  period_last_day: null,
  period_label: null,
}

/** "by Oct 24": a window's inclusive last day (`period_last_day`, yyyy-MM-dd). */
export function periodByLabel(lastDay: string): string {
  return `by ${DateTime.fromISO(lastDay).toFormat('LLL d')}`
}

/**
 * A window's inclusive last day: the OpenTask day of its last instant (with
 * `CALENDAR_DAY_START`, the calendar day before its end).
 */
function periodLastDay(end: DateTime, timezone: string, dayStart: string): string {
  return openTaskDayOf(new Date(end.toMillis() - 1), timezone, dayStart)
}

export function quotaPeriodFields(
  task: Pick<Task, 'rrule' | 'progress_period_start' | 'progress_target' | 'is_tracked'>,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): QuotaPeriodFields {
  if (!isTracked(task)) return NO_QUOTA_PERIOD
  const window = quotaWindow(task, timezone, now, weekStart, dayStart)
  if (!window) return NO_QUOTA_PERIOD
  const lastDay = periodLastDay(window.end, timezone, dayStart)
  return {
    progress_period_end: window.end.toUTC().toISO(),
    period_interval: window.interval,
    period_last_day: lastDay,
    period_label: window.interval > 1 ? periodByLabel(lastDay) : null,
  }
}

/**
 * The count that is TRUE right now: `progress_current`, or 0 once its period
 * has ended.
 *
 * The rollover cron closes a period up to five minutes after the boundary
 * (`period-rollover.ts`). Until it runs, the row still carries the old
 * period's count — at 00:03 a daily quota met yesterday reads "2/2" — and
 * anything deciding what to show or do TODAY from it would be deciding from
 * yesterday. Every such reader goes through here. Writes don't need to: they
 * run the rollover inline first (`rolloverQuotaNow`).
 *
 * A quota with no anchor yet (never seen by the rollover, or no period at all)
 * has nothing to expire: its count is its count.
 */
export function effectiveProgress(
  task: Pick<Task, 'rrule' | 'progress_current' | 'progress_period_start'>,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): number {
  const current = Math.max(0, task.progress_current ?? 0)
  const period = quotaPeriodUnit(task.rrule)
  if (!period || !task.progress_period_start) return current
  const start = DateTime.fromISO(task.progress_period_start, { zone: 'utc' }).setZone(timezone)
  if (!start.isValid) return current
  // The rollover's own end rule — a weekly anchor off the user's week-start
  // boundary ends at the next boundary, not a full week on.
  const end = quotaPeriodEnd(start, period.unit, period.interval, weekStart, dayStart)
  return DateTime.fromJSDate(now) >= end ? 0 : current
}

/**
 * The period a quota counts within, as the user would say it — read from the
 * rrule's FREQ, which the §9 migration rewrote to the bare period
 * ("FREQ=WEEKLY" for "2x/week"). No rrule means no period: the count simply
 * accumulates until the task is completed.
 *
 * FREQ only — an interval quota reads as its unit ("this week" for a
 * fortnight). Anything that names a SPECIFIC quota's period reads
 * `taskPeriodLabel` instead, which says "by Oct 24" for it.
 */
export function periodLabel(rrule: string | null | undefined): string | null {
  return freqLabel(quotaFreqOf(rrule))
}

/**
 * A FREQ's period as the user would say it — "today", "this week" — the words
 * the Track panel's section headings use (`trackSections`). For callers that
 * already hold the FREQ rather than an rrule (a quota prompt's `period`).
 */
export function freqLabel(freq: string | null | undefined): string | null {
  return QUOTA_PERIODS.find((p) => p.freq === freq)?.label ?? null
}

/**
 * "every 2 weeks", "every 3 days" — an interval quota's period as a name, the
 * heading of its Track section and the fallback when no served label is at
 * hand. Interval 1 is the FREQ's own label ("this week").
 */
export function intervalPeriodName(freq: QuotaFreq, interval: number): string {
  if (interval <= 1) return freqLabel(freq) as string
  const word = QUOTA_PERIODS.find((p) => p.freq === freq)!.word
  return `every ${interval} ${freq === 'DAILY' ? 'day' : word}s`
}

/**
 * ONE quota's period, as words — what a row, a chip's accessible name or a
 * popover says after its count. Interval quotas (2026-10-16): the server's
 * served label ("by Oct 24", `period_label`) wins, so the date is never
 * re-derived here; a row without it (built by hand, or from a server that
 * predates it) says "every 2 weeks". Interval 1 keeps "this week" / "today".
 */
export function taskPeriodLabel(task: Pick<Task, 'rrule' | 'period_label'>): string | null {
  const period = quotaPeriodOf(task.rrule)
  if (!period) return null
  if (period.interval <= 1) return freqLabel(period.freq)
  return task.period_label ?? intervalPeriodName(period.freq, period.interval)
}

/**
 * The key a quota's period groups by — its FREQ, and its INTERVAL above 1
 * ("WEEKLY", "WEEKLY/2"). Grouping by the label string would file a fortnight
 * under "this week", whose clock it does not share. `'NONE'` = no period.
 */
export function quotaPeriodKey(rrule: string | null | undefined): string {
  const period = quotaPeriodOf(rrule)
  if (!period) return 'NONE'
  return period.interval > 1 ? `${period.freq}/${period.interval}` : period.freq
}

/** "this week" → "week", for the period tag on a Quotas page row. */
export function periodShort(label: string): string {
  return QUOTA_PERIODS.find((p) => p.label === label)?.short ?? label
}

/**
 * "this week" → "wk", for the two-letter suffix a chip's count carries.
 *
 * Null rather than the label when the period is not one this app knows: the
 * suffix is decoration on a count, and printing "0/3·this week" inside a chip
 * would be worse than printing nothing. In the table with everything else about
 * a period, because that table exists precisely because this mapping used to be
 * written out in five places and two of them had drifted.
 */
export function periodSuffix(label: string): string | null {
  return QUOTA_PERIODS.find((p) => p.label === label)?.suffix ?? null
}

export interface TrackSummary {
  /** Logged, each quota capped at its target — overflow on one never pays for another. */
  done: number
  /** The targets added up. */
  total: number
}

/**
 * Capped progress over summed targets: "2 of 23 this week".
 *
 * It was the Track panel's period-card number until the panel moved to label
 * clusters (2026-09-09) — a label group mixes periods, so adding its targets
 * up would have been meaningless there (see `quotaGroupSummary`, which counts
 * quotas instead). The panel groups by period again as of 2026-09-23
 * (`trackSections`), where every quota in a group shares one clock and the sum
 * is honest — this is that section's bar fill.
 */
export function trackSummary(
  tasks: Pick<Task, 'progress_target' | 'progress_current'>[],
): TrackSummary {
  let done = 0
  let total = 0
  for (const task of tasks) {
    const state = trackState(task)
    done += Math.min(state.current, state.target)
    total += state.target
  }
  return { done, total }
}

/**
 * Quotas by period, day-to-year, each group keeping the order it was given.
 *
 * The Track panel's top-level grouping again as of 2026-09-23 (`trackSections`
 * builds its sections on this); label clusters live INSIDE each period now,
 * where `trackStream` used to be the panel's only grouping.
 *
 * Ordered by QUOTA_PERIODS rather than a hand-written list, so a period added
 * to the table cannot be silently dropped from the grouping — and the
 * period-less bucket is last and explicit, because a quota with no rule is a
 * real state rather than an oversight.
 *
 * INTERVAL QUOTAS (2026-10-16) get a group of their own per (FREQ, INTERVAL)
 * — keyed by `quotaPeriodKey`, never by the label string — right after their
 * unit's interval-1 group, shortest first: "this week", "every 2 weeks",
 * "every 3 weeks", "this month"… A fortnight does not run on this week's
 * clock, so it cannot share that section's "N days left".
 */
export function groupByPeriod(quotas: Pick<Task, 'rrule'>[]): {
  /** The group's key (`quotaPeriodKey`): "WEEKLY", "WEEKLY/2", "NONE". */
  key: string
  freq: QuotaFreq | null
  interval: number
  /** As the user would say it: "this week", "every 2 weeks" — null for no period. */
  period: string | null
  tasks: Task[]
}[] {
  const by = new Map<string, Task[]>()
  for (const t of quotas as Task[]) {
    const key = quotaPeriodKey(t.rrule)
    by.set(key, [...(by.get(key) ?? []), t])
  }
  const rank = (key: string): [number, number] => {
    if (key === 'NONE') return [QUOTA_PERIODS.length, 0]
    const [freq, n] = key.split('/')
    return [QUOTA_PERIODS.findIndex((p) => p.freq === freq), n ? Number(n) : 1]
  }
  return [...by.keys()]
    .sort((a, b) => {
      const [fa, ia] = rank(a)
      const [fb, ib] = rank(b)
      return fa - fb || ia - ib
    })
    .map((key) => {
      const period = quotaPeriodOf(by.get(key)![0].rrule)
      return {
        key,
        freq: period?.freq ?? null,
        interval: period?.interval ?? 1,
        period: period ? intervalPeriodName(period.freq, period.interval) : null,
        tasks: by.get(key)!,
      }
    })
}

/**
 * What a label group's header says: how many quotas, and how many are met.
 *
 * NOT `trackSummary`. That adds targets up, which is honest for one period and
 * meaningless across several — "2 a day + 3 a week + 1 a month = 7" is a number
 * nobody can act on, and a label group mixes periods by construction. Counting
 * quotas survives the mixing, and "met" is per-quota (`trackState`), so it
 * means the same thing in every group.
 */
export function quotaGroupSummary(tasks: Pick<Task, 'progress_target' | 'progress_current'>[]): {
  count: number
  met: number
} {
  return { count: tasks.length, met: tasks.filter((t) => trackState(t).met).length }
}

/** What a folded Track header says about the group it is standing in for. */
export interface QuotaShortfall {
  /** Every quota in the group has hit its target. */
  allMet: boolean
  /** A label cluster's form: "3 left". */
  short: string
  /** The whole panel's form, which also carries the total: "3 of 22 left". */
  full: string
}

/**
 * The wording for a shut Track header, in the panel's form and a cluster's.
 *
 * ONE FUNCTION FOR BOTH so the "everything is done" case cannot drift between
 * them again. It used to: a cluster read "all met" while the panel header
 * beside it read "0 of 22 left", which is the same fact stated as a failure.
 * The two forms differ only in whether the total is worth repeating — a cluster
 * sits next to its own chips, the panel header stands in for all of them.
 */
export function quotaShortfall(summary: { count: number; met: number }): QuotaShortfall {
  const allMet = summary.count > 0 && summary.met === summary.count
  const left = summary.count - summary.met
  return {
    allMet,
    short: allMet ? 'all met' : `${left} left`,
    full: allMet ? 'all met' : `${left} of ${summary.count} left`,
  }
}

/**
 * The one label a quota is filed under: the first MEANING it carries, or none.
 *
 * Reserved `ai-*` labels are skipped. They are machinery, not filing — created
 * by `createTask` (`ai-to-process`, `ai-proposed`, `ai-added`) and by
 * enrichment (`ai-failed`), often without the user ever typing one. Taking
 * `labels[0]` blindly gave a quota whose only label was operational a group
 * header reading "AI-FAILED", and showed that as its pressed chip in the
 * editor. A quota carrying nothing else is unlabelled, which is the truth.
 */
export function quotaLabelOf(quota: Pick<Task, 'labels'>): string | null {
  return quota.labels?.find((l) => !isReservedLabel(l)) ?? null
}

/**
 * Quotas by label — the Quotas page's grouping (Trent, 2026-09-08: "I think we
 * need to have one label for quotas… there's a bunch of stuff for the kids and
 * there are other things").
 *
 * ONE label per quota: the editor writes a single entry, and a quota that
 * still carries two from before that rule is filed under the FIRST — the
 * migration deliberately left those rows alone, so this has to have an answer
 * for them rather than putting one quota in two places.
 *
 * Alphabetical, with the unlabelled group last: it is the leftovers, not a
 * name that happens to sort after "website". `sensitivity: 'base'` matches the
 * within-group order `trackedItems` uses, so the page sorts by one rule
 * throughout. Each group keeps the order it was given (that frozen alphabetical
 * order), because logging on one quota must never reorder the others under the
 * user's finger.
 *
 * The dashboard's Track panel groups by this too (see `trackStream`), so a
 * quota sits under the same name in both places. Neither surface can carry a
 * summed progress bar as a result — a label group mixes days, weeks and months
 * by construction — so the period travels with each quota instead: a suffix on
 * the panel's chips, a `· week` on the page's rows.
 */
export function groupByLabel(
  quotas: Pick<Task, 'labels'>[],
): { label: string | null; tasks: Task[] }[] {
  // Grouped case-INSENSITIVELY, displayed in the spelling seen first.
  //
  // The registry's UNIQUE is case-sensitive, so "Kids" and "kids" are two rows
  // and can both end up on quotas. Grouping by the raw string then drew two
  // separate cards whose headers both read "KIDS", which reads as a bug every
  // time. `labels_add`/`labels_remove` already dedupe case-insensitively
  // (collect-field-changes.ts), so this matches a rule the app already keeps
  // rather than inventing one. Nothing about the schema changes: the two rows
  // still exist, they just file together.
  const by = new Map<string | null, Task[]>()
  const display = new Map<string, string>()
  for (const t of quotas as Task[]) {
    const label = quotaLabelOf(t)
    const key = label === null ? null : label.toLowerCase()
    if (label !== null && !display.has(key as string)) display.set(key as string, label)
    by.set(key, [...(by.get(key) ?? []), t])
  }
  const labels = [...by.keys()]
    .filter((l): l is string => l !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const order: (string | null)[] = by.has(null) ? [...labels, null] : labels
  return order.map((key) => ({
    label: key === null ? null : (display.get(key) ?? key),
    tasks: by.get(key)!,
  }))
}

/**
 * The name the no-label cluster goes by — a group of things, not a gap.
 *
 * "Other", not the Quotas page's "Unlabelled" (Trent, 2026-09-09). The panel's
 * titles sit inline among the chips at a small size, where "Unlabelled" reads
 * as a state of the quotas under it rather than as the name of a group; the
 * page has a card header with room to say the longer word. The grouping key is
 * still `unlabelled` in both places — it is the same null label.
 */
const NO_LABEL_NAME = 'Other'

/** A cluster's heading: the label's name, and the colour it is drawn in. */
export interface TrackStreamTitle {
  kind: 'title'
  /** As shown — the label, or "Unlabelled". */
  name: string
  /** The label itself, null for the unlabelled cluster. The grouping key. */
  label: string | null
  /** From `label_config`; null when the label has no colour configured. */
  color: LabelColor | null
}

/** One quota, carrying the colour of the cluster it belongs to. */
export interface TrackStreamChip {
  kind: 'chip'
  task: Task
  color: LabelColor | null
}

export type TrackStreamItem = TrackStreamTitle | TrackStreamChip

/**
 * ONE period section's quotas as a flat stream: a title, its quotas, the next
 * title, its quotas (Trent, 2026-09-09, choosing variation G from the mockup).
 *
 * Flat, rather than the nested `{ label, tasks }[]` `groupByLabel` returns,
 * because a section renders it as a single wrapping flex row in which a title
 * is just another item — chips wrap in after it, and the row costs the least
 * height of the variations drawn. Nesting the clusters in their own elements
 * would put a wrap boundary between them and undo that.
 *
 * SCOPED TO ONE PERIOD as of 2026-09-23. This used to be the whole panel's
 * only grouping — one call over every quota the user had. `trackSections`
 * groups by period first now (Trent, choosing the period-first mock over the
 * label-first one this had been drawing since 09-09), and calls this once per
 * section, over just that section's quotas, so a label like "kids" that has
 * both weekly and monthly quotas gets a cluster in EACH section rather than
 * one cluster spanning periods a bar could not honestly summarise.
 *
 * Order is `groupByLabel`'s — alphabetical, case-insensitive, the unlabelled
 * cluster last — and within a cluster the frozen alphabetical order `trackedItems`
 * gave, so logging on one quota never reorders the others under a finger.
 *
 * The colour is resolved once per cluster and copied onto its chips: the chip
 * needs it for its stripe and the title for its swatch, and they must not be
 * able to disagree.
 */
/**
 * Neutral: no colour configured, the unlabelled cluster, or a colour the panel
 * cannot spend.
 */
export const TRACK_NEUTRAL_CLASS = 'bg-muted-foreground/60'

/**
 * The flat colour a chip's stripe and a cluster's swatch are painted in.
 *
 * GREEN IS NOT AVAILABLE HERE. Green already means "met" on these chips — the
 * fill and the border both turn green at the target — so a label configured
 * green would put a permanent met-coloured mark on quotas that are not met.
 * Settings offers green like any other colour and should keep doing so; the
 * label's chips elsewhere in the app are unaffected. Only this stripe declines
 * it, and falls back to neutral.
 */
export function trackStripeClass(color: LabelColor | null): string {
  if (color === null || color === 'green') return TRACK_NEUTRAL_CLASS
  return LABEL_COLORS[color].dot
}

export function trackStream(quotas: Task[], labelConfig: LabelConfig[]): TrackStreamItem[] {
  const out: TrackStreamItem[] = []
  for (const group of groupByLabel(quotas)) {
    const color = group.label ? getLabelColor(group.label, labelConfig) : null
    out.push({ kind: 'title', name: group.label ?? NO_LABEL_NAME, label: group.label, color })
    for (const task of group.tasks) out.push({ kind: 'chip', task, color })
  }
  return out
}

/**
 * A period's [start, end) window in the user's timezone — the boundaries every
 * function below measures against. The unit the OpenTask date of `now` is in
 * ("Day starts at" PR 2: with 3:00 AM a week runs from Sunday 03:00), from
 * its start (`unitStartAt`, the quota anchor rule) to the next unit's start
 * — the rollover's own end rule for an aligned anchor (`quotaPeriodEnd`). A
 * CALENDAR addition on the dates, not 24/168/etc. hours, so a DST day of 23
 * or 25 real hours is still exactly "one day" here and the fraction below
 * comes out right without a special case for it. The user's week (Sunday by
 * default, or Monday) — never Luxon's ISO-Monday `startOf('week')`.
 */
function periodBounds(
  freq: QuotaFreq,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): { start: DateTime; end: DateTime } {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const unit = FREQ_UNIT[freq]
  const start = unitStartAt(local, unit, weekStart, dayStart)
  return { start, end: quotaPeriodEnd(start, unit, 1, weekStart, dayStart) }
}

/**
 * How much of a quota's period has already run, 0..1 — the period bar's
 * `aria-valuetext` ("43% of the week gone"). It drew a notch on the bar
 * until 2026-10-16, when the bar became the Reminders period hairline.
 *
 * The fraction is a ratio of two REAL durations (`end.diff(start)`, both
 * absolute instants), not a ratio of calendar units — which is what makes it
 * DST-safe. A 23-hour spring-forward day divides `now - start` by 23 real
 * hours here, not by a hard-coded 24, so the fraction lands at the same clock
 * time it would on any other day rather than drifting an hour off on the one
 * day a naive `hoursSinceMidnight / 24` would get wrong.
 */
export function periodElapsedFraction(
  freq: QuotaFreq,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): number {
  const { start, end } = periodBounds(freq, timezone, now, weekStart, dayStart)
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const total = end.diff(start).as('milliseconds')
  if (total <= 0) return 0
  const elapsed = local.diff(start).as('milliseconds')
  return Math.min(1, Math.max(0, elapsed / total))
}

/**
 * Days left in a quota's period, TODAY COUNTED (Trent's mock: Wednesday with
 * 5 days left in a Monday-start week — Wed, Thu, Fri, Sat, Sun; 4 in the
 * default Sunday-start week — Wed, Thu, Fri, Sat).
 *
 * Counted on OpenTask dates, from today's to the period's last day
 * ("Day starts at" PR 2), not from `now` itself, so the number does not tick
 * down at the moment `now`'s clock passes; it only changes when the day
 * turns (the day start — 01:30 with 3:00 AM is still yesterday), the way a
 * person reading "5 days left" expects.
 */
export function periodDaysLeft(
  freq: QuotaFreq,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): number {
  const { end } = periodBounds(freq, timezone, now, weekStart, dayStart)
  const today = openTaskDayOf(now, timezone, dayStart)
  const lastDay = periodLastDay(end, timezone, dayStart)
  const gap = DateTime.fromISO(lastDay, { zone: 'utc' }).diff(
    DateTime.fromISO(today, { zone: 'utc' }),
    'days',
  ).days
  return Math.round(gap) + 1
}

/**
 * The section heading's muted clause: "N days left" for a week or longer, and
 * nothing at all for a day. "Today" already says when it ends — "ends tonight"
 * beside it was noise (Trent, 2026-09-24) — and routing DAILY through
 * `periodDaysLeft` would say "1 day left" today and "0 days left" a minute
 * before midnight.
 */
export function periodTimeLeftText(
  freq: QuotaFreq,
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  dayStart: string,
): string | null {
  if (freq === 'DAILY') return null
  const days = periodDaysLeft(freq, timezone, now, weekStart, dayStart)
  return `${days} day${days === 1 ? '' : 's'} left`
}

/**
 * A period section's math and quotas, ready for the panel to draw a section
 * from — see the Quotas panel's own top-of-file comment for the 2026-09-23
 * period-first redesign this exists for.
 */
export interface TrackSection {
  /**
   * The section's DOM/order key (`quotaPeriodKey`): the FREQ ("WEEKLY"), the
   * FREQ and INTERVAL of an interval section ("WEEKLY/2"), or `'NONE'`.
   */
  key: string
  freq: QuotaFreq | null
  /** The section's INTERVAL — 1 for an ordinary period. */
  interval: number
  /** As `periodLabel` would say it — 'today' … 'this year' — 'every 2 weeks', or 'no period'. */
  heading: string
  /**
   * "N days left" — null for the no-period section and for an INTERVAL
   * section, which has no shared clock (each of its quotas carries its own
   * end, `period_label`, on its chip).
   */
  timeLeft: string | null
  /** 0..1, how much of the period has run (the bar's `aria-valuetext`) — null for the no-period and interval sections. */
  elapsedFraction: number | null
  /** sum(min(current,target)) / sum(target) over the section's quotas — partial credit, capped per quota. */
  barFraction: number
  /** The bar's accessible description: "67% done, 43% of the week gone" — no elapsed clause with no clock. */
  barAriaLabel: string
  /** Quotas met vs. total in this section — a count of quotas, not a sum of targets. */
  summary: { count: number; met: number }
  allMet: boolean
  tasks: Task[]
}

/**
 * The Track panel's quotas, grouped by period and ready to draw — the
 * section-summary helper the panel builds its heading and bar from.
 *
 * Built on `groupByPeriod` (day-to-year order, period-less last, empty
 * sections omitted) plus `trackSummary`/`quotaGroupSummary` for the numbers.
 * The panel resolves each section's label clusters separately, with
 * `trackStream(section.tasks, labelConfig)` — see that function's comment for
 * why a cluster is scoped to one section rather than spanning periods.
 *
 * An interval section ("every 2 weeks", 2026-10-16 — the design doc's option
 * (a)) has a bar and a met count like any other, but NO clock: two fortnights
 * made in adjacent weeks end on different days, so one elapsed fraction and one "N days
 * left" would be wrong for one of them. Its chips say their own end instead.
 */
export function trackSections(
  quotas: Task[],
  timezone: string,
  now: Date,
  weekStart: WeekStart,
  /** The user's day boundary (`useDayStart`): periods run on OpenTask dates. */
  dayStart: string,
): TrackSection[] {
  return groupByPeriod(quotas).map(({ key, freq, interval, period, tasks }) => {
    const summary = quotaGroupSummary(tasks)
    const { done, total } = trackSummary(tasks)
    const barFraction = total === 0 ? 0 : done / total
    const clock = freq !== null && interval === 1 ? freq : null
    const elapsedFraction = clock
      ? periodElapsedFraction(clock, timezone, now, weekStart, dayStart)
      : null
    const fillPct = Math.round(barFraction * 100)
    const elapsedPct = elapsedFraction === null ? null : Math.round(elapsedFraction * 100)
    const noun = clock ? QUOTA_PERIODS.find((p) => p.freq === clock)?.noun : null
    return {
      key,
      freq,
      interval,
      heading: period ?? 'no period',
      timeLeft: clock ? periodTimeLeftText(clock, timezone, now, weekStart, dayStart) : null,
      elapsedFraction,
      barFraction,
      barAriaLabel:
        elapsedPct === null
          ? `${fillPct}% done`
          : `${fillPct}% done, ${elapsedPct}% of ${noun} gone`,
      summary,
      allMet: summary.count > 0 && summary.met === summary.count,
      tasks,
    }
  })
}
