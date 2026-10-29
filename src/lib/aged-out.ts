/**
 * AGED OUT (Trent, 2026-10-29, first pass — "let's start building that task
 * queue"): the tasks that have outlived their horizon are processed in the
 * task queue, not in Process (Process keeps its growth asks as "a nice
 * fallback but… rarely used"). docs/TASK-MODEL.md § Aged out.
 *
 * - MEMBERS: exactly the tasks Process's `growthAsk` asks about — a one-off
 *   with no picked target of its own, past its horizon's threshold (days 10
 *   days, weeks or unset a month, months a quarter), counted from the latest
 *   of `horizon_set_at` (else `created_at`) and `growth_kept_at`. Eventually
 *   never grows, so it is never here.
 * - CADENCE: weekly, on the check-in day (the Weeks segment's day): a task
 *   joins when it was already aged at the start of the latest check-in day,
 *   then carries over daily until handled — like every segment.
 * - NEVER TWO PLACES: on a day it shows here, the task is in no horizon
 *   segment (`getTaskSegments` places it first).
 * - HANDLED: Grow (one horizon step, `growStep`) or Keep (Process's
 *   `affirm_horizon`: `growth_kept_at`, so it returns one threshold later,
 *   and `growth_kept_count` + 1). Both also stamp `last_considered_at`, so the
 *   row stays today as considered and "N of M" holds.
 *
 * Behind a build flag (`AGED_OUT_ENABLED`, `NEXT_PUBLIC_AGED_OUT=1`: the dev
 * build) and a caller flag (`?aged=1`, the web only — a native build would
 * list an unknown segment kind as a page of its own). Pure: the clock, zone
 * and day start come in.
 */
import { growthAsk, type ProcessTaskFields } from '@/lib/process-rules'
import {
  openTaskDayOf,
  openTaskDaysBetween,
  openTaskLocalDay,
  openTaskLocalDayStart,
} from '@/lib/opentask-day'
import {
  AGE_THRESHOLDS,
  HORIZON_ORDER,
  UNSET_HORIZON,
  latestSegmentDay,
  type CheckInDay,
  type HorizonValue,
  type SegmentState,
} from '@/lib/task-segments'

/** The segment's name on screen — a working name, in one place. */
export const AGED_OUT_TITLE = 'Aged out'

/** The build flag: on in the dev build only (`NEXT_PUBLIC_AGED_OUT=1`). */
export const AGED_OUT_ENABLED = process.env.NEXT_PUBLIC_AGED_OUT === '1'

/** The query the web adds to `REMINDERS_URL` when the segment is on. */
export const AGED_OUT_QUERY = '&aged=1'

/**
 * Grow: one step out — Days → Weeks → Months → Eventually; unset counts as
 * Weeks, so it grows to Months. Eventually has nowhere to go (null).
 */
export function growStep(horizon: string | null): HorizonValue | null {
  const on = (HORIZON_ORDER as readonly string[]).includes(horizon ?? '')
    ? (horizon as HorizonValue)
    : UNSET_HORIZON
  return HORIZON_ORDER[HORIZON_ORDER.indexOf(on) + 1] ?? null
}

/** The fields Aged out reads. */
export interface AgedOutFields extends ProcessTaskFields {
  last_considered_at: string | null
  segment_deferred_at: string | null
}

/**
 * Where a task stands in Aged out today, or null when it is not there:
 * 'considered' when grown or kept today (it stays as a handled row),
 * 'deferred' when deferred today, else 'waiting'.
 */
export function agedOutState(
  task: AgedOutFields,
  timezone: string,
  now: Date,
  dayStart: string,
  checkInDay: CheckInDay,
): SegmentState | null {
  const today = openTaskDayOf(now, timezone, dayStart)
  const onToday = (iso: string | null | undefined) =>
    !!iso && openTaskDayOf(new Date(iso), timezone, dayStart) === today
  // Handled today — kept, or grown — stays as a considered row.
  if (
    onToday(task.last_considered_at) &&
    (onToday(task.growth_kept_at) || onToday(task.horizon_set_at))
  ) {
    return 'considered'
  }
  if (!growthAsk(task, timezone, now, dayStart)) return null
  // Weekly: aged already when the latest check-in day began.
  const shownDay = latestSegmentDay('weeks', openTaskLocalDay(now, timezone, dayStart), checkInDay)
  const shownStart = openTaskLocalDayStart(shownDay, timezone, dayStart)
  if (!growthAsk(task, timezone, shownStart, dayStart)) return null
  return onToday(task.segment_deferred_at) ? 'deferred' : 'waiting'
}

/**
 * What restarted the task's age clock after it was made, if anything — the
 * Aged out row's "why it's here" (Trent, 2026-10-29: "Weeks since Sep 3",
 * "kept Sep 3"). The clock is `growthAsk`'s: the latest of `horizon_set_at`
 * (else `created_at`) and `growth_kept_at`. Null when it runs from creation
 * (the row's created date says it all) — including a horizon set on the day
 * the task was made. OpenTask days, so a set and a creation on one day agree.
 */
export function agedClockRestart(
  task: Pick<AgedOutFields, 'created_at' | 'horizon' | 'horizon_set_at' | 'growth_kept_at'>,
  timezone: string,
  dayStart: string,
): { kind: 'kept' | 'set'; at: string } | null {
  const day = (iso: string) => openTaskDayOf(new Date(iso), timezone, dayStart)
  const setAt = task.horizon && task.horizon_set_at ? task.horizon_set_at : null
  const kept = task.growth_kept_at
  if (kept && (!setAt || Date.parse(kept) > Date.parse(setAt))) {
    return day(kept) > day(task.created_at) ? { kind: 'kept', at: kept } : null
  }
  return setAt && day(setAt) > day(task.created_at) ? { kind: 'set', at: setAt } : null
}

/**
 * How long, spelled out (Trent, 2026-10-29: "3 WKS, I just don't like how that
 * works… it's going to have to be spelled out all the way"): under 14 days
 * "N days", under 8 weeks "N weeks", under 12 months "N months", else
 * "N years" — singular at 1 ("1 week"). Counted in OpenTask days from `from`
 * (the creation, or what restarted the clock) to `now`. Null on the same day.
 */
export function ageWords(
  from: string,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): string | null {
  const days = openTaskDaysBetween(new Date(from), now, timezone, dayStart)
  if (days < 1) return null
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (days < 14) return unit(days, 'day')
  if (days < 56) return unit(Math.floor(days / 7), 'week')
  const months = Math.floor(days / (365.25 / 12))
  if (months < 12) return unit(months, 'month')
  return unit(Math.floor(days / 365.25), 'year')
}

/**
 * The cutoff a horizon's tasks age out at, for an Aged out group's heading
 * ("Days · >10 days"; Trent, 2026-10-29: ">" with no space): ">10 days",
 * ">1 month", ">3 months" — its `AGE_THRESHOLDS` entry, unset read as Weeks.
 */
export function cutoffWords(horizon: string | null): string {
  const on = (HORIZON_ORDER as readonly string[]).includes(horizon ?? '')
    ? (horizon as HorizonValue)
    : UNSET_HORIZON
  const { days, months } = AGE_THRESHOLDS[on]
  const n = days ?? months ?? 0
  return `>${n} ${days !== undefined ? 'day' : 'month'}${n === 1 ? '' : 's'}`
}

/**
 * AGED OUT'S GROUPS (Trent, 2026-10-29: "add little categories… so that all
 * the days, then all the weeks and months… are just grouped"): the horizon a
 * row is aged on, unset read as Weeks (`UNSET_HORIZON`). Eventually never
 * ages out, so there are three.
 */
export type AgedOutGroup = Exclude<HorizonValue, 'eventually'>

export function agedOutGroup(horizon: string | null): AgedOutGroup {
  const on = (HORIZON_ORDER as readonly string[]).includes(horizon ?? '')
    ? (horizon as HorizonValue)
    : UNSET_HORIZON
  return on === 'eventually' ? 'months' : on
}

/** When the age clock started: `growthAsk`'s — the later of the horizon's own clock (else creation) and the last keep. */
export function agedClockStart(
  task: Pick<AgedOutFields, 'created_at' | 'horizon_set_at' | 'growth_kept_at'>,
): number {
  const onSince = Date.parse(task.horizon_set_at ?? task.created_at)
  const kept = task.growth_kept_at ? Date.parse(task.growth_kept_at) : 0
  return Math.max(onSince, kept)
}

/**
 * Aged out's order: by group (Days, Weeks, Months), then the oldest first —
 * the clock that started longest ago — then id. It was priority, then id,
 * every horizon segment's order, until the groups (2026-10-29).
 */
export function compareAgedOut(
  a: Pick<AgedOutFields, 'id' | 'horizon' | 'created_at' | 'horizon_set_at' | 'growth_kept_at'>,
  b: Pick<AgedOutFields, 'id' | 'horizon' | 'created_at' | 'horizon_set_at' | 'growth_kept_at'>,
): number {
  const rank = (t: typeof a) => HORIZON_ORDER.indexOf(agedOutGroup(t.horizon))
  return rank(a) - rank(b) || agedClockStart(a) - agedClockStart(b) || a.id - b.id
}
