/**
 * The editor's words for what the task model decides (2026-10-12, Trent's
 * morning QA; §8): a deadline task's lead day on the deadlines page (it
 * replaced the automatic target, 2026-10-22), and whether a recurring task's
 * deadline moves with each occurrence. Pure, so both are tested in
 * `tests/behavioral/tm-editor-labels.test.ts`; the rules themselves live in
 * `src/lib/task-segments.ts` and are only READ here, never restated.
 */

import { DateTime } from 'luxon'
import {
  deadlineDay,
  deadlineDayTarget,
  hasPickedTarget,
  leadFor,
  localDay,
  occurrenceDates,
  parseDeckDay,
  ruleWait,
  scheduleBase,
  targetMoved,
  targetSetAtOf,
  upcomingDays,
  waitDays,
  type LeadFields,
  type TargetContext,
  type UpcomingTaskFields,
} from '@/lib/task-segments'
import { DEADLINE_MORNING, UPCOMING_SECTION_TITLES } from '@/lib/task-model-words'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { addDays, openTaskDayOf, openTaskLocalDay } from '@/lib/opentask-day'
import type { RepeatAnchor } from '@/types'

/** The Lead line's facts (`leadLine`). */
export interface LeadLine {
  /** The day the task goes on the deadlines page (yyyy-MM-dd, the OpenTask day). */
  from: string
  /** Local days from `from` to the deadline's OpenTask day (0 = that day). */
  daysBefore: number
  /**
   * The stepper's value: the EFFECTIVE lead — the days before the deadline the
   * line shows (an override asking for more than is left is clamped to today:
   * `clamped`). 1–`max`.
   */
  leadDays: number
  /**
   * An override longer than the days left (Trent, 10-22): the lead day is
   * already today, "as early as it can be" — the stepper shows the effective
   * value and can't go higher.
   */
  clamped: boolean
  /** The user's override (`lead_days`), staged or stored; null = the default table. */
  override: number | null
  /**
   * The stepper's top: 90, or on a repeat one less than its rule's wait (the
   * server refuses a lead as long as the gap between deadlines, `leadDaysProblem`).
   */
  max: number
  /** THIS instance was deferred to a later day (yyyy-MM-dd), or null. */
  deferredTo: string | null
  /** A staged deadline or lead change produced it (drawn blue): a preview of Save. */
  staged: boolean
}

/** The lead stepper's bounds (the API's `lead_days`, 1–90). */
export const LEAD_DAYS_MIN = 1
export const LEAD_DAYS_MAX = 90

/**
 * THE EDITOR'S LEAD LINE (the deadlines page, 2026-10-22, plan §2): a
 * deadline task with no target goes on the deadlines page from its lead day
 * (`lead_from`) — "On the deadlines page from Tue Oct 20 (3 days before)" —
 * read with the STAGED deadline and lead override, so it previews what Save
 * would store (the server re-derives `lead_from` on either, `leadFor`, which
 * drops a deferral). Nothing staged: the STORED lead day, the truth.
 *
 * "DEFERRED": the page's Defer moves this instance's `lead_from` later. A
 * lead derived now is the LATEST day the rule could give without a defer — a
 * one-off's default lead only shrinks as its deadline nears (the lead table
 * never shrinks as the wait grows), an override's day is fixed, and both clamp
 * up to today — so a stored day AFTER the one derived now can only be a
 * defer: then the line reads from the derived day and adds "deferred to Thu".
 * (A defer to a day still before the derived one is not told apart: the line
 * shows that stored day, which is when it goes on the page.)
 *
 * Null: no deadline, or no lead at all (a reminder or a quota, a repeat with
 * a relative target, a target-anchored repeat — `leadFor`). The caller shows
 * it only with the task queue on and no target.
 */
export function leadLine(
  task: LeadFields & { lead_from?: string | null },
  staged: { deadline: string | null | undefined; leadDays: number | null | undefined },
  timezone: string,
  rolloverTime: string | null,
  now: Date = new Date(),
): LeadLine | null {
  const deadline = staged.deadline !== undefined ? staged.deadline : task.deadline_at
  if (!deadline) return null
  const override = staged.leadDays !== undefined ? staged.leadDays : (task.lead_days ?? null)
  const isStaged = leadStaged(task, staged)
  const fields: LeadFields = {
    ...task,
    deadline_at: deadline,
    lead_days: override,
    // A deadline-anchored repeat's occurrence IS its deadline: a staged one
    // reschedules this occurrence (`leadFor` reads `occurrence_at`).
    ...(task.rrule && staged.deadline !== undefined ? { occurrence_at: deadline } : {}),
  }
  const derived = leadFor(fields, timezone, { rolloverTime, now })
  if (!derived) return null
  const stored = task.lead_from ?? null
  const deferredTo = !isStaged && stored && stored > derived ? stored : null
  const from = isStaged || !stored || deferredTo ? derived : stored
  const d = DateTime.fromISO(deadlineDay(deadline, timezone, rolloverTime), { zone: timezone })
  const daysBefore = Math.max(
    0,
    Math.round(d.diff(DateTime.fromISO(from, { zone: timezone }), 'days').days),
  )
  const max = leadDaysMax(task, deadline, timezone)
  const shown = Math.min(max, Math.max(LEAD_DAYS_MIN, daysBefore))
  return {
    from,
    daysBefore,
    leadDays: shown,
    clamped: override !== null && override > shown,
    override,
    deferredTo,
    staged: isStaged,
    max,
  }
}

/** The lead stepper's top for this task (`LeadLine.max`). */
function leadDaysMax(task: LeadFields, deadline: string, timezone: string): number {
  if (!task.rrule) return LEAD_DAYS_MAX
  const wait = ruleWait(
    {
      rrule: task.rrule,
      recurrence_mode: task.recurrence_mode ?? 'from_due',
      anchor_time: task.anchor_time ?? null,
    },
    deadline,
    timezone,
  )
  return Math.max(LEAD_DAYS_MIN, Math.min(LEAD_DAYS_MAX, wait - 1))
}

/** Whether a staged deadline or lead override differs from the stored one. */
function leadStaged(
  task: { deadline_at: string | null; lead_days?: number | null },
  staged: { deadline: string | null | undefined; leadDays: number | null | undefined },
): boolean {
  if (staged.deadline !== undefined && staged.deadline !== task.deadline_at) return true
  return staged.leadDays !== undefined && staged.leadDays !== (task.lead_days ?? null)
}

/** "3 days before", "the day before", "the deadline day". */
export function leadDaysWords(daysBefore: number): string {
  if (daysBefore <= 0) return 'the deadline day'
  return daysBefore === 1 ? 'the day before' : `${daysBefore} days before`
}

/**
 * The Lead line's words: "On the deadlines page from Tue Oct 20 (3 days
 * before)" — "from today", or "since Mon Oct 19" once the day has passed.
 */
export function leadLineWords(line: LeadLine, timezone: string, today: string): string {
  const day = DateTime.fromISO(line.from, { zone: timezone }).toFormat('ccc LLL d')
  const when =
    line.from === today ? 'from today' : line.from < today ? `since ${day}` : `from ${day}`
  return `On the deadlines page ${when} (${leadDaysWords(line.daysBefore)})`
}

// ===========================================================================
// THE LEAD TIME ROW'S UPCOMING FORM (2026-10-25, the Upcoming split, PR B)
// ===========================================================================

/**
 * The Lead time row's facts for a task with a TARGET or a DECK DAY
 * (`upcomingLeadLine`): when it shows in Upcoming's two sections. Days are
 * yyyy-MM-dd OpenTask days.
 */
export interface UpcomingLeadLine {
  /** What the lead counts from: the target, or the deck day. */
  anchor: 'target' | 'deck'
  /** The Later day (`upcomingDays`), or null: none (a lead of 1, or a short wait). */
  later: string | null
  /** Local days from `later` to the anchor's day (null with no Later). */
  laterDaysBefore: number | null
  /** The Tomorrow day (the day before the anchor), or null: made today for tomorrow. */
  tomorrow: string | null
  /**
   * The stepper's value: the EFFECTIVE lead — the Later day's distance from
   * the anchor, or 1 (the day before) with no Later.
   */
  leadDays: number
  /**
   * An override longer than the wait allows (Q6): the Later day is clamped to
   * the day after the target was set, "as early as it can be".
   */
  clamped: boolean
  /** The user's override (`lead_days`), staged or stored; null = the default table. */
  override: number | null
  /** The stepper's top: 90, or on a repeat one less than its rule's wait (`leadDaysProblem`). */
  max: number
  /** A staged anchor, deadline or lead produced it (drawn blue): a preview of Save. */
  staged: boolean
}

/** The fields `upcomingLeadLine` reads. */
export type UpcomingLeadTask = Pick<
  UpcomingTaskFields,
  | 'due_at'
  | 'deadline_at'
  | 'target_auto'
  | 'rrule'
  | 'target_set_at'
  | 'created_at'
  | 'last_completed_at'
  | 'on_deck_day'
  | 'lead_days'
> & {
  occurrence_at?: string | null
  recurrence_mode?: 'from_due' | 'from_completion' | null
  anchor_time?: string | null
}

/**
 * THE EDITOR'S LEAD TIME ROW, UPCOMING FORM (2026-10-25; plan
 * `plan-upcoming-split-1024.md` § Web): for ANY task with a target the user
 * picked (a relative target and a repeat's occurrence count) or a future
 * deck day — whatever the task-queue switch says (decision 10) — the two
 * Upcoming days the rule gives it (`upcomingDays`, read here, never
 * restated), with the lead override `lead_days` as a stepper.
 *
 * `staged.anchor`: the staged target (`{ target }`, already capped at the
 * deadline) or deck day (`{ deck }`); undefined → the stored one; null → none
 * (the target is staged for removal). A staged anchor, or `staged.restamp`
 * (a staged deadline — it moves or may move the target), means Save will
 * restamp `target_set_at`, so the wait counts from TODAY; a lead change alone
 * never restamps (decision 12), so it counts from the stored set day.
 *
 * Null when there is nothing to say: no anchor, or one on or before today
 * (the task is overdue, targeted today or on deck today — not in Upcoming).
 */
export function upcomingLeadLine(
  task: UpcomingLeadTask,
  staged: {
    anchor: { target: string } | { deck: string } | null | undefined
    restamp: boolean
    leadDays: number | null | undefined
  },
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): UpcomingLeadLine | null {
  const anchor = staged.anchor === undefined ? storedUpcomingAnchor(task) : staged.anchor
  if (!anchor) return null
  const today = openTaskLocalDay(now, timezone, dayStart)
  const isDeck = 'deck' in anchor
  const day = isDeck
    ? parseDeckDay(anchor.deck, timezone)
    : localDay(anchor.target, timezone, dayStart)
  if (!day || day <= today) return null
  const override = staged.leadDays !== undefined ? staged.leadDays : (task.lead_days ?? null)
  // A staged anchor restamps on Save as surely as a staged deadline does.
  const setDay =
    staged.restamp || staged.anchor !== undefined
      ? today
      : localDay(targetSetAtOf(task as UpcomingTaskFields), timezone, dayStart)
  const { later, tomorrow } = upcomingDays(day, setDay, override)
  const laterDaysBefore = later ? waitDays(day, later) : null
  const shown = laterDaysBefore ?? 1
  const max = upcomingLeadMax(task, isDeck ? null : anchor.target, timezone)
  const iso = (d: DateTime | null) => (d ? d.toFormat('yyyy-MM-dd') : null)
  const leadStagedNow =
    staged.leadDays !== undefined && staged.leadDays !== (task.lead_days ?? null)
  return {
    anchor: isDeck ? 'deck' : 'target',
    later: iso(later),
    laterDaysBefore,
    tomorrow: iso(tomorrow),
    leadDays: Math.min(max, shown),
    clamped: override !== null && override > shown,
    override,
    max,
    staged: staged.anchor !== undefined || staged.restamp || leadStagedNow,
  }
}

/** The task's stored Upcoming anchor: a deck day, else a target the user picked. */
function storedUpcomingAnchor(
  task: UpcomingLeadTask,
): { target: string } | { deck: string } | null {
  if (task.on_deck_day) return { deck: task.on_deck_day }
  return hasPickedTarget(task) ? { target: task.due_at! } : null
}

/** The stepper's top: 90, or a repeat's rule's wait − 1 (the server's `leadDaysProblem`). */
function upcomingLeadMax(task: UpcomingLeadTask, target: string | null, timezone: string): number {
  const first = task.occurrence_at ?? target ?? task.due_at
  if (!task.rrule || !first) return LEAD_DAYS_MAX
  const wait = ruleWait(
    {
      rrule: task.rrule,
      recurrence_mode: task.recurrence_mode ?? 'from_due',
      anchor_time: task.anchor_time ?? null,
    },
    first,
    timezone,
  )
  return Math.max(LEAD_DAYS_MIN, Math.min(LEAD_DAYS_MAX, wait - 1))
}

/**
 * The row's words (Trent's, plan § Web):
 *   "Later on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22"
 *   "Later since Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22" (the Later day has passed)
 *   "Tomorrow on Thu Oct 22 (the day before)"                          (no Later)
 *   "Not in Upcoming (the target is tomorrow)"                         (made today for tomorrow)
 *   "Not in Upcoming (on deck tomorrow)"                               (the same, a deck)
 * The clamp's "(as early as it can be)" is the stepper's, as on the
 * deadline form.
 */
export function upcomingLeadWords(line: UpcomingLeadLine, timezone: string, today: string): string {
  const fmt = (day: string) => DateTime.fromISO(day, { zone: timezone }).toFormat('ccc LLL d')
  if (!line.tomorrow) {
    return line.anchor === 'deck'
      ? 'Not in Upcoming (on deck tomorrow)'
      : 'Not in Upcoming (the target is tomorrow)'
  }
  const tomorrow = `${UPCOMING_SECTION_TITLES.tomorrow} on ${fmt(line.tomorrow)}`
  if (!line.later || line.laterDaysBefore === null) return `${tomorrow} (the day before)`
  const when = line.later < today ? 'since' : 'on'
  const later = `${UPCOMING_SECTION_TITLES.later} ${when} ${fmt(line.later)}`
  return `${later} (${leadDaysWords(line.laterDaysBefore)}) · ${tomorrow}`
}

/**
 * The pickers' "Morning of the deadline" choice (ruling Q8, 2026-10-12; was
 * "Deadline day"): the user's morning on the deadline's local day, or the
 * deadline itself if earlier (`deadlineDayTarget`). Offered only while that
 * moment is still ahead; null otherwise (no deadline, or its day's morning
 * has passed). Shared by the snooze menu, the editor's target picker and a
 * task segment's Today picker.
 *
 * The label says where its time comes from (2026-10-24, Trent: "Deadline
 * day · Tue 8:30 AM" didn't say what 8:30 was): the user's Morning time, or
 * — when the deadline is earlier in the day than that — the Deadline time.
 * The weekday is dropped when the day is today or tomorrow (the words
 * already say which day: the deadline's):
 *   "Morning of the deadline · 9:00 AM (Default task time)"
 *   "Morning of the deadline · Tue 8:30 AM (Deadline time)"
 */
export function deadlineDayPick(
  deadlineAt: string | null | undefined,
  ctx: TargetContext,
  now: Date,
  /** The user's day boundary (`useDayStart`): "today or tomorrow" are OpenTask days. */
  dayStart: string,
): { label: string; at: string } | null {
  // Never once the deadline has passed (Trent's ruling, 2026-10-12).
  if (!deadlineAt || Date.parse(deadlineAt) <= now.getTime()) return null
  const at = deadlineDayTarget(deadlineAt, ctx, dayStart)
  if (Date.parse(at) <= now.getTime()) return null
  const target = DateTime.fromISO(at, { zone: 'utc' }).setZone(ctx.timezone)
  // OpenTask days (part 2, 2026-10-26): at 00:30 Monday with a 3:00 AM start
  // "tomorrow" is Monday, as at 23:30 Sunday.
  const today = openTaskDayOf(now, ctx.timezone, dayStart)
  const day = openTaskDayOf(new Date(at), ctx.timezone, dayStart)
  const near = day === today || day === addDays(today, 1)
  const when = target.toFormat(near ? 'h:mm a' : 'ccc h:mm a')
  // The deadline itself (earlier than the morning), unless the two coincide.
  const fromDeadline = Date.parse(at) === Date.parse(deadlineAt)
  const source = fromDeadline && target.toFormat('HH:mm') !== ctx.morningTime
  return {
    label: `${DEADLINE_MORNING} · ${when} (${source ? 'Deadline time' : 'Default task time'})`,
    at,
  }
}

/**
 * A DEADLINE-ANCHORED repeat's target, in words, on its deadline line
 * (2026-10-21): the deadline IS the schedule, so the line says where the
 * target sits before it — "target the day before at 6:00 PM", "target 3 days
 * before at 9:00 AM", "target the deadline day at 12:00 PM". Null for anything
 * else: a target-anchored repeat has no deadline, a one-off no rule.
 */
export function deadlineRepeatLabel(
  task: {
    rrule: string | null | undefined
    repeat_anchor?: RepeatAnchor | null
    target_days_before?: number | null
    target_time?: string | null
  },
  /**
   * The period the target follows, when it is linked (relative targets,
   * 2026-10-24): "target the day before at Evening (8:30 PM)" — the activity
   * log's words.
   */
  slotLabel: string | null = null,
): string | null {
  if (!task.rrule || task.repeat_anchor !== 'deadline') return null
  if (task.target_days_before == null || !task.target_time) return null
  if (slotLabel) {
    const at = DateTime.fromFormat(task.target_time, 'HH:mm', { zone: 'utc' }).toFormat('h:mm a')
    return `target ${relativeDaysWords(task.target_days_before)} at ${slotLabel} (${at})`
  }
  return `target ${relativeTargetWords(task.target_days_before, task.target_time)}`
}

/**
 * A relative target in words (2026-10-22, editor plan §2.1): "the deadline day at
 * 12:00 PM", "the day before at 6:00 PM", "3 days before at 9:00 AM". Shared
 * by the deadline line (`deadlineRepeatLabel`) and every-time mode's Target
 * row, so both say it the same way.
 */
export function relativeTargetWords(daysBefore: number, time: string): string {
  const at = DateTime.fromFormat(time, 'HH:mm', { zone: 'utc' }).toFormat('h:mm a')
  return `${relativeDaysWords(daysBefore)} at ${at}`
}

/** "the deadline day", "the day before", "3 days before" — the days-before select's choices. */
export function relativeDaysWords(daysBefore: number): string {
  if (daysBefore === 0) return 'the deadline day'
  return daysBefore === 1 ? 'the day before' : `${daysBefore} days before`
}

/**
 * "THIS IS THE FRI OCT 16 ONE" (2026-10-22, editor plan §7, A4): the line
 * under a repeating task's title naming WHICH occurrence the this-one rows
 * edit — shown only when the occurrence differs from what its rule alone
 * would say, i.e. when any of:
 *  (a) it is ON DECK (`on_deck_day`): its target is cleared, the deck names a day;
 *  (b) its target was MOVED this occurrence (`targetMoved`);
 *  (c) it is QUEUED (`queuedRepeatOccurrence`, with the queue switch on): the
 *      stored target has moved on to the next occurrence;
 *  (d) it was RESCHEDULED off its rule — a deadline-anchored, from_due repeat
 *      whose deadline was moved for this occurrence (`scheduleBase` differs
 *      from `occurrence_at`).
 * NOT for plain over-target debt (the Target row already says "5 days ago" in
 * red) nor an occurrence on its rule. Never for a done task or a one-off.
 *
 * Names `occurrence_at`'s local day ("Fri Oct 16") — on a deadline-anchored
 * repeat that is the DEADLINE's day, so it reads "Sat Nov 7 (deadline)" when
 * the target (moved, or derived) falls on another day.
 */
export function occurrenceDiffers(
  task: {
    rrule: string | null | undefined
    done?: boolean
    due_at: string | null
    occurrence_at?: string | null
    queued_at?: string | null
    on_deck_day?: string | null
    recurrence_mode?: 'from_due' | 'from_completion' | null
    anchor_time?: string | null
    repeat_anchor?: RepeatAnchor | null
    target_days_before?: number | null
    target_time?: string | null
  },
  timezone: string,
  queueEnabled: boolean,
): string | null {
  if (!task.rrule || task.done || !task.occurrence_at) return null
  const schedule = {
    rrule: task.rrule,
    repeat_anchor: task.repeat_anchor ?? null,
    target_days_before: task.target_days_before ?? null,
    target_time: task.target_time ?? null,
  }
  const differs =
    !!task.on_deck_day ||
    targetMoved(
      { ...schedule, due_at: task.due_at, occurrence_at: task.occurrence_at },
      timezone,
    ) ||
    (queueEnabled && queuedRepeatOccurrence(task) !== null) ||
    rescheduledOffRule(task, timezone)
  if (!differs) return null
  const occurrence = DateTime.fromISO(task.occurrence_at, { zone: 'utc' }).setZone(timezone)
  const day = occurrence.toFormat('ccc LLL d')
  if (task.repeat_anchor !== 'deadline') return day
  const target =
    task.due_at ??
    occurrenceDates(schedule, task.occurrence_at, timezone).targetAt ??
    task.occurrence_at
  const targetDay = DateTime.fromISO(target, { zone: 'utc' }).setZone(timezone)
  return targetDay.hasSame(occurrence, 'day') ? day : `${day} (deadline)`
}

/** (d): a deadline-anchored from_due occurrence moved off its rule (`scheduleBase`). */
function rescheduledOffRule(
  task: Parameters<typeof occurrenceDiffers>[0],
  timezone: string,
): boolean {
  if (task.repeat_anchor !== 'deadline' || task.recurrence_mode === 'from_completion') return false
  try {
    const base = scheduleBase(
      {
        rrule: task.rrule ?? null,
        repeat_anchor: task.repeat_anchor,
        recurrence_mode: task.recurrence_mode,
        anchor_time: task.anchor_time ?? null,
        occurrence_at: task.occurrence_at,
        due_at: task.due_at,
      },
      timezone,
    )
    return base !== null && Date.parse(base) !== Date.parse(task.occurrence_at!)
  } catch {
    // A rule with no next occurrence: nothing to compare against.
    return false
  }
}

/**
 * A repeating task WAITING in the task queue (B3, task queue PR 2): the
 * rollover moved its target (`due_at`) on to the next occurrence and kept
 * `occurrence_at` on the one it missed, which is the one the queue row stands
 * for. The row and its details show THAT date — "Oct 16 · every Fri at 4 PM",
 * not the moved target "Oct 23", and no "Target … in 3 days" / "· target
 * moved" (Trent, 2026-10-20: "What does that even mean?"). No "missed" word
 * either (his ruling): just the occurrence's date.
 *
 * The occurrence (UTC ISO) for such a task, else null. Keyed on the queue
 * state itself — `queued_at` set on a repeating task — which the rollover
 * clears when the wait ends (`release`), and a new target clears on any
 * write (`stampTargetSet`). The editor names that occurrence on its "This is
 * the Fri Oct 16 one" line (`occurrenceDiffers`, (c)).
 */
export function queuedRepeatOccurrence(task: {
  rrule: string | null | undefined
  occurrence_at?: string | null
  queued_at?: string | null
}): string | null {
  if (!task.rrule || !task.queued_at || !task.occurrence_at) return null
  return task.occurrence_at
}

/**
 * Where the Quick panel's date controls (increments, delta, pickers) start
 * for a task: its target — or, for a repeating task waiting in the task queue
 * (`queuedRepeatOccurrence`, with the queue switch on), null, i.e. now, as
 * for a task with no target. Its stored target is a moved one and its
 * occurrence is past, so "+1 day" from either would stage a date nobody
 * picked (from the missed Fri Oct 16: Sat Oct 17, already over target).
 */
export function pickerBaseDueAt(
  task: {
    rrule: string | null | undefined
    due_at: string | null
    occurrence_at?: string | null
    queued_at?: string | null
  },
  queueEnabled: boolean,
): string | null {
  if (queueEnabled && queuedRepeatOccurrence(task)) return null
  return task.due_at
}

/**
 * THE EDITOR'S RULE IN WORDS (2026-10-22, editor PR 4c): the this-one link's
 * "↻ Repeats — Fridays at 4:00 PM · edit every time ›". A deadline-anchored
 * rule's time is its deadline's, so it says so ("Monthly on the 1st Sat,
 * deadline 8:00 AM"); an end is said exactly — "6 times", "until Dec 31, 2026" (Trent's
 * ruling: never "until December").
 */
export function repeatWords(task: {
  rrule: string
  anchor_time?: string | null
  repeat_anchor?: RepeatAnchor | null
  repeat_count?: number | null
  repeat_until?: string | null
}): string {
  const compact = formatRRuleCompact(task.rrule, task.anchor_time ?? null)
  const timed = / at (\d{1,2}:\d{2} [AP]M)$/
  const base =
    task.repeat_anchor !== 'deadline'
      ? compact
      : timed.test(compact)
        ? compact.replace(timed, ', deadline $1')
        : `${compact}, deadline`
  const count = task.repeat_count ?? null
  const until = task.repeat_until ?? null
  const end =
    count !== null
      ? `, ${count} ${count === 1 ? 'time' : 'times'}`
      : until !== null
        ? `, until ${DateTime.fromISO(until, { zone: 'utc' }).toFormat('LLL d, yyyy')}`
        : ''
  return `${base}${end}`
}
