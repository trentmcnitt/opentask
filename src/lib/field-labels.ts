/**
 * Shared field labels and description formatters for undo/redo toast messages.
 *
 * Used by:
 * - logAction() call sites (update.ts, bulk.ts) to produce rich descriptions
 * - format-toast.ts for client-side toast messages
 *
 * Only user-facing fields are included — internal/derived fields like anchor_*,
 * snooze_count, original_due_at are filtered out of descriptions.
 */

import { getTimezoneDayBoundaries, formatTimeInTimezone } from '@/lib/format-date'
import { getPriorityOption } from '@/lib/priority'

/** Maps DB column names to human-readable labels */
export const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  labels: 'labels',
  rrule: 'recurrence',
  project_id: 'project',
  due_at: 'due date',
  meta_notes: 'notes',
  recurrence_mode: 'recurrence mode',
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

export interface EditDescriptionContext {
  isSnooze: boolean
  beforeState: Partial<Record<string, unknown>> & { id: number }
  afterState: Partial<Record<string, unknown>> & { id: number }
  userTimezone: string
}

/**
 * Build a rich description for a single-task edit.
 *
 * Examples:
 * - Snoozed "Buy groceries" to Mon 9:00 AM
 * - Snoozed "Buy groceries" to Mon 9:00 AM, priority Medium → High
 * - Priority Medium → High on "Buy groceries"
 * - Updated recurrence on "Buy groceries"
 * - Updated recurrence and notes on "Buy groceries"
 * - Updated 3 fields on "Buy groceries"
 * - Edited "Buy groceries" (fallback when no user-facing fields)
 */
export function formatEditDescription(
  title: string,
  fieldsChanged: string[],
  context: EditDescriptionContext,
): string {
  const { isSnooze, beforeState, afterState, userTimezone } = context

  // Build priority change fragment if priority changed
  const priorityFragment = buildPriorityFragment(fieldsChanged, beforeState, afterState)

  if (isSnooze && afterState.due_at && typeof afterState.due_at === 'string') {
    const target = formatSnoozeTarget(afterState.due_at, userTimezone)
    const base = `Snoozed "${title}" to ${target}`
    if (priorityFragment) {
      return `${base}, ${priorityFragment}`
    }
    return base
  }

  // Priority-only change
  if (priorityFragment && fieldsChanged.filter((f) => FIELD_LABELS[f]).length === 1) {
    return `${priorityFragment} on "${title}"`
  }

  // Priority + other fields
  if (priorityFragment) {
    const otherFields = fieldsChanged.filter((f) => FIELD_LABELS[f] && f !== 'priority')
    const otherSummary = formatFieldSummary(otherFields)
    if (otherSummary) {
      return `${priorityFragment}, updated ${otherSummary} on "${title}"`
    }
    return `${priorityFragment} on "${title}"`
  }

  // No priority change — use field summary
  const summary = formatFieldSummary(fieldsChanged)
  if (summary) {
    return `Updated ${summary} on "${title}"`
  }

  // Fallback: only internal fields changed
  return `Edited "${title}"`
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
 * Build a "Priority Medium → High" string if priority changed.
 * Returns null if priority didn't change.
 */
function buildPriorityFragment(
  fieldsChanged: string[],
  beforeState: Partial<Record<string, unknown>>,
  afterState: Partial<Record<string, unknown>>,
): string | null {
  if (!fieldsChanged.includes('priority')) return null

  const before = beforeState.priority
  const after = afterState.priority
  if (typeof before !== 'number' || typeof after !== 'number') return null

  const fromLabel = getPriorityOption(before).label
  const toLabel = getPriorityOption(after).label
  // Capitalize "Priority" for sentence-start usage
  return `Priority ${fromLabel} \u2192 ${toLabel}`
}
