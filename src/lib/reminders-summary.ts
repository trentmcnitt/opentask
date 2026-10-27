/**
 * The Reminders surface's headline numbers (REDESIGN-V03 §6), pure so the
 * page header, the nav badge and the tests all read the same arithmetic.
 *
 * "Waiting so far" is Trent's definition (2026-09-04): every reminder still
 * waiting in a slot that has already started today, plus the un-slotted
 * "Anytime" ones. Later slots do not count yet. Nothing here is debt — a
 * reminder is never overdue — it is simply what the day has put in front of
 * him up to this moment.
 */
import { DateTime } from 'luxon'
import { minutesIntoDay } from '@/lib/opentask-day'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { groupConsidered, groupWaiting, type QuotaPrompt } from '@/lib/quota-prompts'

export interface SummaryGroup {
  slot: TimeSlot | null
  reminders: { id: number }[]
  considered: number
  /**
   * Quota prompts (2026-09-24). They count exactly like reminders — waiting
   * until handled, then considered — through `groupWaiting` /
   * `groupConsidered`, so the headline, the badge and every bar agree.
   */
  prompts?: Pick<QuotaPrompt, 'considered' | 'done'>[]
}

export interface RemindersSummary<G extends SummaryGroup = SummaryGroup> {
  /** Waiting in started slots + Anytime. The badge number. */
  waitingSoFar: number
  /** Waiting in slots that have not started yet. */
  waitingLater: number
  /** Considered today, all slots. */
  consideredTotal: number
  /** Waiting + considered, all slots — the day's denominator. */
  dayTotal: number
  /** Groups that count toward "so far", in slot order (Anytime last). */
  started: G[]
  /** Groups still ahead today, in slot order. */
  later: G[]
  /** The first later slot with something waiting — "all caught up until …". */
  nextUp: { slot: TimeSlot; waiting: number } | null
}

/**
 * Has this slot's window begun today, by the user's local clock?
 *
 * "Today" is the day the server's roster is for: from `dayStart` (2026-10-23
 * — the user's "Day starts at" with the task queue on, `useDayStart`;
 * midnight otherwise). With the day starting at 3:00, at 00:30 every slot of
 * the evening's day has started — the roster is still that day's — and a
 * 1:00 AM slot starts at the end of its day (`minutesIntoDay`).
 *
 * The un-slotted "Anytime" bucket has no start time and is always available,
 * so it counts as started — it is never "coming up later". So does a slot
 * whose time can't be read (a malformed start, or an invalid timezone).
 */
export function slotHasStarted(
  slot: TimeSlot | null,
  timezone: string,
  now: Date,
  dayStart: string,
): boolean {
  if (!slot) return true
  const start = parseHHMM(slot.start_time)
  if (start === null) return true
  const local = DateTime.fromJSDate(now).setZone(timezone)
  if (!local.isValid) return true
  return minutesIntoDay(start, dayStart) <= minutesIntoDay(local.hour * 60 + local.minute, dayStart)
}

export function summarizeReminders<G extends SummaryGroup>(
  groups: G[],
  timezone: string,
  now: Date = new Date(),
  dayStart: string,
): RemindersSummary<G> {
  const started: G[] = []
  const later: G[] = []
  for (const g of groups) {
    ;(slotHasStarted(g.slot, timezone, now, dayStart) ? started : later).push(g)
  }

  const count = (gs: G[]) => gs.reduce((n, g) => n + groupWaiting(g), 0)
  const consideredTotal = groups.reduce((n, g) => n + groupConsidered(g), 0)
  const waitingSoFar = count(started)
  const waitingLater = count(later)
  const next = later.find((g) => g.slot && groupWaiting(g) > 0)

  return {
    waitingSoFar,
    waitingLater,
    consideredTotal,
    dayTotal: waitingSoFar + waitingLater + consideredTotal,
    started,
    later,
    nextUp: next && next.slot ? { slot: next.slot, waiting: groupWaiting(next) } : null,
  }
}

/**
 * REMINDERS AND TASKS, COUNTED APART (Trent, 2026-10-26, ruling "B"): the
 * Reminders headline counts "reminders and queue tasks SEPARATELY, e.g. '75
 * reminders · 84 tasks considered'", and counts everything the day bar under
 * it shows, so its sum matches the bar: every period (its reminders and quota
 * prompts — `summarizeReminders`) and every task segment the bar draws (the
 * deadlines page, the queue's two panels, Daily, Upcoming, Weekly, Monthly,
 * Quarterly), each segment through `segmentCounts` (src/lib/task-segments.ts)
 * — the very numbers its own header shows, so the headline and the headers
 * can never disagree.
 *
 * A task half exists only with the task queue on and a segment drawn
 * (`tasks: null` otherwise): then the headline reads exactly as it did before
 * the split ("14 waiting so far", "40 of 75 considered", "All 75 considered
 * today"). With one, a half that is empty is dropped rather than read "0
 * tasks". Tasks have no period, so every task waiting is waiting "so far".
 *
 * The nav badge, "Considered all so far" and the dashboard card are not this:
 * they stay reminders-only (`summarizeReminders`).
 */
export interface HeadlineHalf {
  /** Waiting now: reminders in started periods + Anytime; every task waiting. */
  waiting: number
  /** Considered (reminders, prompts) or handled (a task segment's X). */
  handled: number
  /** The day's total: a period's waiting + considered; a segment's Y. */
  total: number
}

export interface HeadlineCounts {
  reminders: HeadlineHalf
  /** null: no task half — the task queue is off, or no segment is drawn. */
  tasks: HeadlineHalf | null
  /** Both halves, for the progressbar (`aria-valuenow` / `aria-valuemax`). */
  handled: number
  total: number
  /** The day is done: every reminder AND every task handled. */
  done: boolean
}

export function headlineCounts(
  summary: Pick<RemindersSummary, 'waitingSoFar' | 'consideredTotal' | 'dayTotal'>,
  taskSegments: readonly { handled: number; total: number }[] | null,
): HeadlineCounts {
  const reminders: HeadlineHalf = {
    waiting: summary.waitingSoFar,
    handled: summary.consideredTotal,
    total: summary.dayTotal,
  }
  let tasks: HeadlineHalf | null = null
  if (taskSegments && taskSegments.length > 0) {
    const handled = taskSegments.reduce((n, s) => n + s.handled, 0)
    const total = taskSegments.reduce((n, s) => n + s.total, 0)
    tasks = { waiting: total - handled, handled, total }
  }
  const handled = reminders.handled + (tasks?.handled ?? 0)
  const total = reminders.total + (tasks?.total ?? 0)
  const halfDone = (h: HeadlineHalf) => h.handled >= h.total
  const done = total > 0 && halfDone(reminders) && (tasks === null || halfDone(tasks))
  return { reminders, tasks, handled, total, done }
}

type HalfKind = 'reminders' | 'tasks'

/**
 * "75 reminders", "1 task" — full words at every width (Trent, 2026-10-26:
 * no "rem" abbreviation anywhere; on a phone the count takes a line of its
 * own under the bar instead, so the words fit).
 */
function noun(n: number, kind: HalfKind): string {
  if (kind === 'reminders') return n === 1 ? 'reminder' : 'reminders'
  return n === 1 ? 'task' : 'tasks'
}

/**
 * The halves to show, reminders first, dropping one `pick` finds empty (no
 * "0 tasks"). Both empty: the reminders half alone, so the line still reads.
 */
function shownHalves(
  c: HeadlineCounts,
  pick: (h: HeadlineHalf) => number,
): [HalfKind, HeadlineHalf][] {
  const all: [HalfKind, HeadlineHalf][] = [['reminders', c.reminders]]
  if (c.tasks) all.push(['tasks', c.tasks])
  const shown = all.filter(([, h]) => pick(h) > 0)
  return shown.length > 0 ? shown : all.slice(0, 1)
}

const SEP = ' · '

/**
 * The line, in the runs it may wrap between (never inside one — a phone
 * broke "waiting so / far"): ["14 reminders", "3 tasks waiting so far"],
 * shown joined by " · ". With no task half, as before: ["14 waiting so far"].
 */
export function waitingSoFarRuns(c: HeadlineCounts): string[] {
  if (!c.tasks) return [`${c.reminders.waiting} waiting so far`]
  const shown = shownHalves(c, (h) => h.waiting)
  const runs = shown.map(([k, h]) => `${h.waiting} ${noun(h.waiting, k)}`)
  runs[runs.length - 1] += ' waiting so far'
  return runs
}

/** The line as one string: "14 reminders · 3 tasks waiting so far" ("14 waiting so far" with no task half). */
export function waitingSoFarText(c: HeadlineCounts): string {
  return waitingSoFarRuns(c).join(SEP)
}

/**
 * What "Caught up until Evening · 6:00 PM" gains while tasks still wait
 * (Trent, 2026-10-26: keep the caught-up phrase, append the tasks): "3 tasks
 * waiting", "1 task waiting". Tasks have no period, so they are never
 * "until" anything; the line reads "Caught up until Evening · 6:00 PM · 3
 * tasks waiting".
 */
export function tasksWaitingText(n: number): string {
  return `${n} ${noun(n, 'tasks')} waiting`
}

/** A run of text in the count; `strong` is a handled number, drawn in the foreground. */
export interface CountPart {
  text: string
  strong?: boolean
}

/**
 * The count while the day is open, one run per half (a phone may wrap
 * between the runs, never inside one): [["40", " of 75 reminders"], ["30",
 * " of 84 tasks considered"]], shown joined by " · " — "40 of 75 reminders ·
 * 30 of 84 tasks considered". With no task half, as before: "40 of 75
 * considered".
 */
export function dayCountRuns(c: HeadlineCounts): CountPart[][] {
  if (!c.tasks) {
    return [
      [
        { text: String(c.reminders.handled), strong: true },
        { text: ` of ${c.reminders.total} considered` },
      ],
    ]
  }
  const runs = shownHalves(c, (h) => h.total).map(([k, h]): CountPart[] => [
    { text: String(h.handled), strong: true },
    { text: ` of ${h.total} ${noun(h.total, k)}` },
  ])
  runs[runs.length - 1].push({ text: ' considered' })
  return runs
}

/** The open day's count as one string: "40 of 75 reminders · 30 of 84 tasks considered". */
export function dayCountText(c: HeadlineCounts): string {
  return dayCountRuns(c)
    .map((run) => run.map((p) => p.text).join(''))
    .join(SEP)
}

/**
 * The count once the day is done (green), in runs as `dayCountRuns`: ["All
 * 75 reminders", "84 tasks considered today"] — "All 75 reminders · 84 tasks
 * considered today". With no task half, as before: ["All 75 considered today"].
 */
export function dayDoneRuns(c: HeadlineCounts): string[] {
  if (!c.tasks) return [`All ${c.reminders.total} considered today`]
  const runs = shownHalves(c, (h) => h.total).map(([k, h]) => `${h.total} ${noun(h.total, k)}`)
  runs[0] = `All ${runs[0]}`
  runs[runs.length - 1] += ' considered today'
  return runs
}

/** The done count as one string: "All 75 reminders · 84 tasks considered today". */
export function dayDoneText(c: HeadlineCounts): string {
  return dayDoneRuns(c).join(SEP)
}

/**
 * The progressbar's label, both halves spelled out: "40 of 75 reminders and
 * 30 of 84 tasks considered today" ("40 of 75 considered today" with no task half).
 */
export function dayCountLabel(c: HeadlineCounts): string {
  if (!c.tasks) return `${c.reminders.handled} of ${c.reminders.total} considered today`
  const parts = shownHalves(c, (h) => h.total).map(
    ([k, h]) => `${h.handled} of ${h.total} ${noun(h.total, k)}`,
  )
  return `${parts.join(' and ')} considered today`
}
