/**
 * Shared field labels and description formatters for toast messages.
 *
 * Produces a single description string used for BOTH the action toast AND the
 * undo log. When a user sees "Snoozed to Mon 9:00 AM (+2d) — "Buy groceries""
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
import { formatRRuleCompact } from '@/lib/format-rrule'
import { getPriorityOption } from '@/lib/priority'

/** Maps DB column names to human-readable labels */
export const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  labels: 'labels',
  rrule: 'recurrence',
  project_id: 'project',
  due_at: 'due date',
  notes: 'notes',
  recurrence_mode: 'recurrence mode',
  auto_snooze_minutes: 'auto-snooze',
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
  const labels = fieldsChanged
    .map((f) => FIELD_LABELS[f])
    .filter((label): label is string => label !== undefined)

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
export function formatSnoozeTarget(isoUtc: string, timezone: string): string {
  const target = new Date(isoUtc)
  const time = formatTimeInTimezone(isoUtc, timezone)
  const { todayStart, tomorrowStart, dayAfterTomorrowStart, nextWeekStart } =
    getTimezoneDayBoundaries(timezone)

  if (target >= todayStart && target < tomorrowStart) {
    return time
  }

  if (target >= tomorrowStart && target < dayAfterTomorrowStart) {
    return `tomorrow ${time}`
  }

  if (target >= dayAfterTomorrowStart && target < nextWeekStart) {
    const dayName = target.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short',
    })
    return `${dayName} ${time}`
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
  /** Project name when project_id changed (looked up by caller) */
  projectName?: string
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

  // Get user-facing fields only
  const userFields = fieldsChanged.filter((f) => FIELD_LABELS[f])

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
        ? buildSnoozeFragment(beforeState, afterState, userTimezone)
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
    case 'auto_snooze_minutes':
      return buildAutoSnoozeFragment(beforeState, afterState)
    default:
      return null
  }
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
 * Snooze fragment: "Snoozed to Mon 9:00 AM (+2d)"
 * Includes duration delta from the old due_at to the new due_at.
 */
function buildSnoozeFragment(
  beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
  userTimezone: string,
): string | null {
  const newDueAt = afterState.due_at
  if (typeof newDueAt !== 'string') return null

  const target = formatSnoozeTarget(newDueAt, userTimezone)
  const oldDueAt = beforeState.due_at

  if (typeof oldDueAt === 'string') {
    const delta = formatDurationDelta(new Date(oldDueAt).getTime(), new Date(newDueAt).getTime())
    return `Snoozed to ${target} (${delta})`
  }

  return `Snoozed to ${target}`
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
 * Auto-snooze fragment:
 * - null (default): "Auto-snooze set to default"
 * - 0 (off): "Auto-snooze turned off"
 * - positive: "Auto-snooze set to 15m" / "Auto-snooze set to 1h"
 */
function buildAutoSnoozeFragment(
  _beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
): string {
  const after = afterState.auto_snooze_minutes
  if (after === null || after === undefined) return 'Auto-snooze set to default'
  if (after === 0) return 'Auto-snooze turned off'
  if (typeof after === 'number') {
    const label = after >= 60 ? `${after / 60}h` : `${after}m`
    return `Auto-snooze set to ${label}`
  }
  return 'Auto-snooze updated'
}
