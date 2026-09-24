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
import type { LabelColor, LabelConfig, Task } from '@/types'

/**
 * A tracked task is a quota: something to do N times per period. N > 1 implies
 * it; `is_tracked` marks one with N = 1 ("date night, once a month").
 */
export function isTracked(task: Pick<Task, 'progress_target' | 'is_tracked'>): boolean {
  return task.is_tracked === true || (task.progress_target ?? 1) > 1
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
    short: 'day',
    suffix: 'd',
    editor: 'Every day',
    noun: 'the day',
  },
  {
    freq: 'WEEKLY',
    label: 'this week',
    short: 'week',
    suffix: 'wk',
    editor: 'Every week',
    noun: 'the week',
  },
  {
    freq: 'MONTHLY',
    label: 'this month',
    short: 'month',
    suffix: 'mo',
    editor: 'Every month',
    noun: 'the month',
  },
  {
    freq: 'YEARLY',
    label: 'this year',
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
 * The period a quota counts within, as the user would say it — read from the
 * rrule's FREQ, which the §9 migration rewrote to the bare period
 * ("FREQ=WEEKLY" for "2x/week"). No rrule means no period: the count simply
 * accumulates until the task is completed.
 */
export function periodLabel(rrule: string | null | undefined): string | null {
  const freq = quotaFreqOf(rrule)
  return freq ? (QUOTA_PERIODS.find((p) => p.freq === freq)?.label ?? null) : null
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
 */
export function groupByPeriod(
  quotas: Pick<Task, 'rrule'>[],
): { period: string | null; tasks: Task[] }[] {
  const order: (string | null)[] = [...QUOTA_PERIODS.map((p) => p.label), null]
  const by = new Map<string | null, Task[]>()
  for (const t of quotas as Task[]) {
    const p = periodLabel(t.rrule)
    by.set(p, [...(by.get(p) ?? []), t])
  }
  return order.filter((p) => by.has(p)).map((p) => ({ period: p, tasks: by.get(p)! }))
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
 * function below measures against. `end` is exclusive and always
 * `start.plus({ <unit>: 1 })`: a CALENDAR addition, not 24/168/etc. hours, so a
 * DST day of 23 or 25 real hours is still exactly "one day" here and the
 * fraction below comes out right without a special case for it.
 */
function periodBounds(
  freq: QuotaFreq,
  timezone: string,
  now: Date,
): { start: DateTime; end: DateTime } {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  switch (freq) {
    case 'DAILY': {
      const start = local.startOf('day')
      return { start, end: start.plus({ days: 1 }) }
    }
    case 'WEEKLY': {
      // Luxon's week starts Monday (ISO 8601) — no option to set, and none
      // needed: that is the week the app already shows everywhere else.
      const start = local.startOf('week')
      return { start, end: start.plus({ weeks: 1 }) }
    }
    case 'MONTHLY': {
      const start = local.startOf('month')
      return { start, end: start.plus({ months: 1 }) }
    }
    case 'YEARLY': {
      const start = local.startOf('year')
      return { start, end: start.plus({ years: 1 }) }
    }
  }
}

/**
 * How much of a quota's period has already run, 0..1 — the Track panel's
 * notch sits at this fraction along the period's bar.
 *
 * The fraction is a ratio of two REAL durations (`end.diff(start)`, both
 * absolute instants), not a ratio of calendar units — which is what makes it
 * DST-safe. A 23-hour spring-forward day divides `now - start` by 23 real
 * hours here, not by a hard-coded 24, so the notch lands at the same clock
 * time it would on any other day rather than drifting an hour off on the one
 * day a naive `hoursSinceMidnight / 24` would get wrong.
 */
export function periodElapsedFraction(
  freq: QuotaFreq,
  timezone: string,
  now: Date = new Date(),
): number {
  const { start, end } = periodBounds(freq, timezone, now)
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const total = end.diff(start).as('milliseconds')
  if (total <= 0) return 0
  const elapsed = local.diff(start).as('milliseconds')
  return Math.min(1, Math.max(0, elapsed / total))
}

/**
 * Calendar days left in a quota's period, TODAY COUNTED (Trent's mock:
 * Wednesday with 5 days left in a Monday-start week — Wed, Thu, Fri, Sat, Sun).
 *
 * Measured from the start of TODAY to the period's end, not from `now` itself,
 * so the number does not tick down at the moment `now`'s clock passes; it only
 * changes at midnight, the way a person reading "5 days left" expects.
 */
export function periodDaysLeft(freq: QuotaFreq, timezone: string, now: Date = new Date()): number {
  const { end } = periodBounds(freq, timezone, now)
  const startOfToday = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  return Math.ceil(end.diff(startOfToday, 'days').days)
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
  now: Date = new Date(),
): string | null {
  if (freq === 'DAILY') return null
  const days = periodDaysLeft(freq, timezone, now)
  return `${days} day${days === 1 ? '' : 's'} left`
}

/** The Track panel's period bar: one darker tone, everywhere, no matter what it sits over. */
export const TRACK_NOTCH_CLASS = 'bg-black/14 dark:bg-white/14'

/**
 * A period section's math and quotas, ready for the panel to draw a section
 * from — see the Quotas panel's own top-of-file comment for the 2026-09-23
 * period-first redesign this exists for.
 */
export interface TrackSection {
  /** The FREQ, or `'NONE'` for the period-less bucket — the section's DOM/order key. */
  key: QuotaFreq | 'NONE'
  freq: QuotaFreq | null
  /** As `periodLabel` would say it — 'today' … 'this year' — or 'no period'. */
  heading: string
  /** "ends tonight" / "N days left" — null for the no-period section, which has no clock. */
  timeLeft: string | null
  /** 0..1, where the notch sits — null for the no-period section (no notch). */
  elapsedFraction: number | null
  /** sum(min(current,target)) / sum(target) over the section's quotas — partial credit, capped per quota. */
  barFraction: number
  /** The bar's accessible description: "67% done, 43% of the week gone" — no elapsed clause with no period. */
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
 */
export function trackSections(
  quotas: Task[],
  timezone: string,
  now: Date = new Date(),
): TrackSection[] {
  return groupByPeriod(quotas).map(({ period, tasks }) => {
    const freq =
      period === null ? null : (QUOTA_PERIODS.find((p) => p.label === period)?.freq ?? null)
    const summary = quotaGroupSummary(tasks)
    const { done, total } = trackSummary(tasks)
    const barFraction = total === 0 ? 0 : done / total
    const elapsedFraction = freq ? periodElapsedFraction(freq, timezone, now) : null
    const fillPct = Math.round(barFraction * 100)
    const elapsedPct = elapsedFraction === null ? null : Math.round(elapsedFraction * 100)
    const noun = freq ? QUOTA_PERIODS.find((p) => p.freq === freq)?.noun : null
    return {
      key: freq ?? 'NONE',
      freq,
      heading: period ?? 'no period',
      timeLeft: freq ? periodTimeLeftText(freq, timezone, now) : null,
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
