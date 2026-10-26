/**
 * Shared field labels and description formatters for toast messages.
 *
 * Produces a single description string used for BOTH the action toast AND the
 * undo log. When a user sees "Deferred to Mon 9:00 AM (+2d) — "Buy groceries""
 * after saving, and later undoes it, they see
 * "Undid: Snoozed to Mon 9:00 AM (+2d) — "Buy groceries"" — identical text.
 *
 * Only user-facing fields are included — internal/derived fields like anchor_*,
 * snooze_count, original_due_at are filtered out of descriptions.
 */

import {
  getTimezoneDayBoundaries,
  formatTimeInTimezone,
  formatDurationDelta,
} from '@/lib/format-date'
import { DateTime } from 'luxon'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { parseDeckDay } from '@/lib/task-segments'
import { nightDay, nightDayWords, nightWeekday } from '@/lib/night-day'
import { getPriorityOption } from '@/lib/priority'

/** Maps DB column names to human-readable labels */
export const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  short_title: 'short name',
  priority: 'priority',
  labels: 'labels',
  rrule: 'recurrence',
  project_id: 'project',
  due_at: 'due date',
  notes: 'notes',
  recurrence_mode: 'recurrence mode',
  auto_snooze_minutes: 'nag',
  // §6: moving an item on/off the Reminders surface changes what KIND of thing
  // it is, so it belongs in the user-facing summary rather than being filtered
  // out as internal bookkeeping.
  is_reminder: 'reminder',
  // On deck (2026-10-20): putting a task on deck, or a pick that takes it off.
  on_deck_day: 'on deck',
  // Repeat ends (2026-10-22): "After N times" / "On date".
  repeat_count: 'repeat end',
  repeat_until: 'repeat end',
  // Every-time mode (2026-10-22, editor PR 4c): what a repeat walks, and a
  // deadline-anchored target's place before its deadline (one setting).
  repeat_anchor: 'what repeats',
  target_days_before: 'target',
  target_time: 'target',
  // Relative targets (2026-10-24): the period the target's time follows.
  target_slot_id: 'target',
}

/**
 * Summarize changed fields as a human-readable string.
 *
 * Filters to user-facing fields only (excludes anchor_*, snooze_count, etc.)
 *
 * - 1 field:  "priority"
 * - 2 fields: "priority and due date"
 * - 3+ fields: "3 fields"
 * - No user-facing fields: null
 */
export function formatFieldSummary(fieldsChanged: string[]): string | null {
  // Deduplicated: two columns can share a label (the repeat end's count and date).
  const labels = [
    ...new Set(
      fieldsChanged
        .map((f) => FIELD_LABELS[f])
        .filter((label): label is string => label !== undefined),
    ),
  ]

  if (labels.length === 0) return null
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.length} fields`
}

/**
 * Format a snooze target time relative to now in the user's timezone.
 *
 * - Same day:       "5:00 PM"
 * - Tomorrow:       "tomorrow 9:00 AM"
 * - Within 7 days:  "Mon 9:00 AM"
 * - Beyond:         "Jan 15 9:00 AM"
 */
export function formatSnoozeTarget(
  isoUtc: string,
  timezone: string,
  /** The user's day boundary: "tomorrow" is the next OpenTask day. */
  dayStart: string,
  now: Date = new Date(),
): string {
  const target = new Date(isoUtc)
  const time = formatTimeInTimezone(isoUtc, timezone)
  const { todayStart, tomorrowStart, nextWeekStart } = getTimezoneDayBoundaries(
    timezone,
    dayStart,
    now,
  )

  if (target >= todayStart && target < tomorrowStart) {
    return time
  }

  // Tomorrow, then the weekday within 7 days — L9's night rule (`nightDay`):
  // "tomorrow night 1:00 AM", "Thu night 1:00 AM"; and the moment's own
  // weekday where "tomorrow" would contradict its date (`nightDayWords`).
  if (target >= tomorrowStart && target < nextWeekStart) {
    return `${nightDayWords(nightDay(target, timezone, dayStart, now), false)} ${time}`
  }

  const dateStr = target.toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  })
  return `${dateStr} ${time}`
}

/**
 * Truncate a task title for display in descriptions.
 * Titles longer than maxLen get first (maxLen-3) chars + "...".
 */
export function truncateTitle(title: string, maxLen: number = 20): string {
  if (title.length <= maxLen) return title
  return title.slice(0, maxLen - 3) + '...'
}

export interface EditDescriptionContext {
  isSnooze: boolean
  beforeState: Partial<Record<string, unknown>> & { id: number }
  afterState: Partial<Record<string, unknown>> & { id: number }
  userTimezone: string
  /** The user's day boundary (`dayBoundaryForUser`): "tomorrow 9:00 AM" by OpenTask day. */
  dayStart: string
  /** Project name when project_id changed (looked up by caller) */
  projectName?: string
  /** A3 (2026-10-11): the snooze stopped AT the deadline — "Deferred to deadline …". */
  cappedAtDeadline?: boolean
  /**
   * Relative targets (2026-10-24): the label of the period the target's time
   * follows (`target_slot_id`, looked up by the caller) — "Target the day
   * before at Evening (8:30 PM)".
   */
  targetSlotLabel?: string
}

/**
 * Build a rich description for a single-task edit.
 *
 * Uses em dash (—) to separate action from task title.
 * Title is the direct object for rename; otherwise appended after em dash.
 *
 * 1-2 fields: per-field value fragments joined with comma
 * 3+ fields: field names listed with "and"
 *
 * Examples:
 * - Snoozed to Mon 9:00 AM (+2d) — "Buy groceries"
 * - Priority Medium → High — "Buy groceries"
 * - Priority set to High — "Buy groceries"
 * - Snoozed to Mon 9 AM (+2d), priority → High — "Buy groceries"
 * - Recurrence set to Daily at 9 AM — "Buy groceries"
 * - Renamed "Old title..." → "New title..."
 * - Updated priority, due date, and recurrence — "Buy groceries"
 * - Edited "Buy groceries" (fallback when no user-facing fields)
 */
export function formatEditDescription(
  title: string,
  fieldsChanged: string[],
  context: EditDescriptionContext,
): string {
  const { beforeState, afterState, userTimezone } = context

  // Get user-facing fields only. The repeat end's two columns are one setting
  // (setting one clears the other): one fragment, from `repeat_count`'s case.
  // The relative target's columns, likewise (from `target_days_before`'s);
  // the target they move (`due_at`) is derived from them, so it isn't its own.
  // A FIXED pick that clears them (relative targets, 2026-10-24) is the
  // reverse: the date said is the pick, and the cleared offsets say nothing.
  const offsetColumns = ['target_days_before', 'target_time', 'target_slot_id']
  const relative = [...offsetColumns, 'repeat_anchor']
  const cleared = relativeCleared(fieldsChanged, afterState)
  const derivedTarget = !cleared && fieldsChanged.some((f) => relative.includes(f))
  const userFields = fieldsChanged
    .filter((f) => FIELD_LABELS[f])
    .filter((f) => !cleared || !offsetColumns.includes(f))
    .filter((f) => f !== 'repeat_until' || !fieldsChanged.includes('repeat_count'))
    .filter((f) => f !== 'target_time' || !fieldsChanged.includes('target_days_before'))
    .filter((f) => f !== 'target_slot_id' || !fieldsChanged.includes('target_days_before'))
    .filter((f) => f !== 'due_at' || !derivedTarget)

  if (userFields.length === 0) {
    return `Edited "${truncateTitle(title)}"`
  }

  // 3+ user-facing fields: list field names, no values
  if (userFields.length >= 3) {
    const labels = userFields.map((f) => FIELD_LABELS[f])
    const list = labels.slice(0, -1).join(', ') + ', and ' + labels[labels.length - 1]
    return `Updated ${list} \u2014 "${truncateTitle(title)}"`
  }

  // 1-2 fields: build per-field fragments with values
  const fragments: string[] = []
  for (const field of userFields) {
    const fragment = buildFieldFragment(field, beforeState, afterState, userTimezone, context)
    if (fragment) fragments.push(fragment)
  }

  if (fragments.length === 0) {
    return `Edited "${truncateTitle(title)}"`
  }

  // Title rename is self-contained (includes both old and new title)
  if (userFields.length === 1 && userFields[0] === 'title') {
    return fragments[0]
  }

  // For rename + another field, the rename fragment already has the title info
  // but we still use em dash format with the current title for consistency
  return `${fragments.join(', ')} \u2014 "${truncateTitle(title)}"`
}

/**
 * Whether a write CLEARED a relative target while the target itself was
 * written (a pick, a defer — relative targets, 2026-10-24): the offsets went
 * to null beside a `due_at` change, with no anchor switch.
 */
function relativeCleared(
  fieldsChanged: string[],
  afterState: Partial<Record<string, unknown>>,
): boolean {
  return (
    fieldsChanged.includes('target_days_before') &&
    afterState.target_days_before === null &&
    afterState.target_time === null &&
    fieldsChanged.includes('due_at') &&
    !fieldsChanged.includes('repeat_anchor')
  )
}

/**
 * Build a rich description for a bulk edit.
 *
 * Simpler than single-task: no from/to values since different tasks have different
 * before states.
 *
 * Examples:
 * - Updated priority on 3 tasks
 * - Updated priority and project on 5 tasks
 * - Edited 2 tasks (fallback)
 */
export function formatBulkEditDescription(count: number, fieldsChanged: string[]): string {
  const summary = formatFieldSummary(fieldsChanged)
  if (summary) {
    return `Updated ${summary} on ${count} tasks`
  }
  return `Edited ${count} tasks`
}

/**
 * Build a description fragment for a single field change.
 * Returns null if no meaningful fragment can be built.
 */
function buildFieldFragment(
  field: string,
  beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
  userTimezone: string,
  context: EditDescriptionContext,
): string | null {
  switch (field) {
    case 'priority':
      return buildPriorityFragment(beforeState, afterState)
    case 'due_at':
      return context.isSnooze
        ? buildSnoozeFragment(beforeState, afterState, userTimezone, context)
        : buildDueDateFragment(afterState)
    case 'rrule':
      return buildRecurrenceFragment(afterState)
    case 'project_id':
      return buildProjectFragment(context)
    case 'title':
      return buildTitleFragment(beforeState, afterState)
    case 'labels':
      return 'Labels updated'
    case 'notes':
      return 'Notes updated'
    case 'short_title':
      return 'Changed short name'
    case 'auto_snooze_minutes':
      return buildAutoSnoozeFragment(beforeState, afterState)
    case 'is_reminder':
      return afterState.is_reminder ? 'Moved to Reminders' : 'Removed from Reminders'
    case 'on_deck_day':
      return buildDeckFragment(afterState, userTimezone, context.dayStart)
    case 'repeat_count':
    case 'repeat_until':
      return buildRepeatEndFragment(afterState)
    case 'repeat_anchor':
      return afterState.repeat_anchor === 'deadline'
        ? 'Repeats on its deadline'
        : 'Repeats on its target'
    case 'target_days_before':
    case 'target_time':
      return buildRelativeTargetFragment(afterState, context.targetSlotLabel)
    default:
      return null
  }
}

/**
 * Repeat ends (2026-10-22): "Ends after 6 times", "Ends on Dec 31, 2026" or
 * "Ends never" — the end the write leaves.
 */
function buildRepeatEndFragment(afterState: Partial<Record<string, unknown>>): string {
  const count = afterState.repeat_count
  const until = afterState.repeat_until
  if (typeof count === 'number') return `Ends after ${count} ${count === 1 ? 'time' : 'times'}`
  if (typeof until === 'string') {
    const day = DateTime.fromISO(until, { zone: 'utc' })
    return `Ends on ${day.isValid ? day.toFormat('LLL d, yyyy') : until}`
  }
  return 'Ends never'
}

/**
 * A relative target (a deadline-anchored repeat's, 2026-10-22; a one-off's,
 * 2026-10-24): "Target the day before at 6:00 PM" — the pair the write leaves
 * (either may be the one that changed) — or, linked to a period, "Target the
 * day before at Evening (8:30 PM)". Cleared: "Target fixed".
 */
function buildRelativeTargetFragment(
  afterState: Partial<Record<string, unknown>>,
  slotLabel?: string,
): string {
  if (
    'target_days_before' in afterState &&
    afterState.target_days_before === null &&
    afterState.target_time === null
  ) {
    return 'Target fixed'
  }
  // Only the changed column is in `afterState`: say what is known.
  const days = afterState.target_days_before
  const time = afterState.target_time
  const when =
    typeof days !== 'number'
      ? null
      : days === 0
        ? 'the deadline day'
        : days === 1
          ? 'the day before'
          : `${days} days before`
  const at =
    typeof time === 'string'
      ? DateTime.fromFormat(time, 'HH:mm', { zone: 'utc' }).toFormat('h:mm a')
      : null
  if (when && at && slotLabel) return `Target ${when} at ${slotLabel} (${at})`
  if (when && at) return `Target ${when} at ${at}`
  if (when) return `Target ${when}`
  return at ? `Target at ${at}` : 'Target updated'
}

/**
 * On deck fragment (2026-10-20): "On deck for Sat Oct 24", or "Taken off
 * deck" (an un-deck, or a pick that cleared the deck). When a deadline added
 * or moved in the same write took it off (A1: the deadline wins), it says
 * why: "Taken off deck: the deadline is Fri".
 */
function buildDeckFragment(
  afterState: Partial<Record<string, unknown>>,
  userTimezone: string,
  dayStart: string,
): string {
  const day = afterState.on_deck_day
  if (typeof day !== 'string') {
    if (afterState.deadline_at === undefined) return 'Taken off deck'
    // The deadlines page (2026-10-22): the deadline that won is before the
    // deck day, or has passed (A1) — said by the deadline itself.
    const deadline = afterState.deadline_at
    if (typeof deadline !== 'string' || Date.parse(deadline) <= Date.now()) {
      return 'Taken off deck: the deadline has passed'
    }
    // The deadline's OpenTask day, "night" in its night (L9: "Thu night") —
    // a day with no time, like the deadline chip's "Deadline Wed".
    const on = nightWeekday(nightDay(new Date(deadline), userTimezone, dayStart, new Date()))
    return `Taken off deck: the deadline is ${on}`
  }
  const parsed = parseDeckDay(day, 'utc')
  return `On deck for ${parsed ? parsed.toFormat('ccc LLL d') : day}`
}

/**
 * Priority fragment:
 * - None → High: "Priority set to High"
 * - Medium → High: "Priority Medium → High"
 * - High → None: "Priority cleared"
 */
function buildPriorityFragment(
  beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
): string | null {
  const before = beforeState.priority
  const after = afterState.priority
  if (typeof before !== 'number' || typeof after !== 'number') return null

  const fromLabel = getPriorityOption(before).label
  const toLabel = getPriorityOption(after).label

  if (before === 0) return `Priority set to ${toLabel}`
  if (after === 0) return 'Priority cleared'
  return `Priority ${fromLabel} \u2192 ${toLabel}`
}

/**
 * Snooze fragment: "Deferred to Mon 9:00 AM (+2d)"
 * Includes duration delta from the old due_at to the new due_at.
 */
function buildSnoozeFragment(
  beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
  userTimezone: string,
  context: Pick<EditDescriptionContext, 'cappedAtDeadline' | 'dayStart'>,
): string | null {
  const newDueAt = afterState.due_at
  if (typeof newDueAt !== 'string') return null

  // A snooze that stopped at the deadline says so (ruling A3): "Deferred to
  // deadline 6:00 PM (+9h)" — the toast, the activity log and the undo entry.
  const when = formatSnoozeTarget(newDueAt, userTimezone, context.dayStart)
  const target = `${context.cappedAtDeadline ? 'deadline ' : ''}${when}`
  const oldDueAt = beforeState.due_at

  if (typeof oldDueAt === 'string') {
    const delta = formatDurationDelta(new Date(oldDueAt).getTime(), new Date(newDueAt).getTime())
    return `Deferred to ${target} (${delta})`
  }

  return `Deferred to ${target}`
}

/**
 * Due date (non-snooze) fragment:
 * - Set: "Due date set to Mon 9 AM"
 * - Cleared: "Due date cleared"
 */
function buildDueDateFragment(afterState: Partial<Record<string, unknown>>): string {
  const newDueAt = afterState.due_at
  if (newDueAt === null || newDueAt === undefined) return 'Due date cleared'
  return 'Due date set'
}

/**
 * Recurrence fragment:
 * - Set/changed: "Recurrence set to Daily at 9 AM"
 * - Cleared: "Recurrence cleared"
 */
function buildRecurrenceFragment(afterState: Partial<Record<string, unknown>>): string {
  const rrule = afterState.rrule
  if (rrule === null || rrule === undefined) return 'Recurrence cleared'
  if (typeof rrule !== 'string') return 'Recurrence updated'

  const anchorTime = typeof afterState.anchor_time === 'string' ? afterState.anchor_time : undefined
  const compact = formatRRuleCompact(rrule, anchorTime)
  return `Recurrence set to ${compact}`
}

/**
 * Project fragment: "Moved to Work"
 */
function buildProjectFragment(context: EditDescriptionContext): string {
  if (context.projectName) {
    return `Moved to ${context.projectName}`
  }
  return 'Project updated'
}

/**
 * Title rename fragment: 'Renamed "Old Ti..." → "New Ti..."'
 * Uses shorter truncation (maxLen=16) since both old and new are shown.
 */
function buildTitleFragment(
  beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
): string {
  const oldTitle = typeof beforeState.title === 'string' ? beforeState.title : '?'
  const newTitle = typeof afterState.title === 'string' ? afterState.title : '?'
  return `Renamed "${truncateTitle(oldTitle, 16)}" \u2192 "${truncateTitle(newTitle, 16)}"`
}

/**
 * Nag fragment:
 * - null (default): "Nag set to default"
 * - 0 (off): "Nag turned off"
 * - positive: "Nag set to every 15m" / "Nag set to every 1h"
 */
function buildAutoSnoozeFragment(
  _beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
): string {
  const after = afterState.auto_snooze_minutes
  if (after === null || after === undefined) return 'Nag set to default'
  if (after === 0) return 'Nag turned off'
  if (typeof after === 'number') {
    const label = after >= 60 ? `${after / 60}h` : `${after}m`
    return `Nag set to every ${label}`
  }
  return 'Nag updated'
}
