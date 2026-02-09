/**
 * Task response formatting helper
 *
 * Adds computed fields (is_recurring, is_snoozed) to task responses.
 * Also provides clipboard formatting for selected tasks.
 */

import type { Task } from '@/types'
import type { SortOption } from '@/hooks/useGroupSort'
import { formatDueTimeParts } from '@/lib/format-date'
import { formatRRule } from '@/lib/format-rrule'
import { getPriorityOption } from '@/lib/priority'

export interface ClipboardGroup {
  label: string
  tasks: Task[]
  sort: SortOption
  reversed: boolean
}

const CLIPBOARD_SORT_LABELS: Record<SortOption, { default: string; reversed: string }> = {
  due_date: { default: 'Soonest First', reversed: 'Latest First' },
  priority: { default: 'Highest Priority', reversed: 'Lowest Priority' },
  title: { default: 'A-Z', reversed: 'Z-A' },
  age: { default: 'Newest First', reversed: 'Oldest First' },
  modified: { default: 'Recently Modified', reversed: 'Least Recently Modified' },
}

export interface FormattedTask extends Task {
  is_recurring: boolean
  is_snoozed: boolean
}

/**
 * Format a task for API response by adding computed fields.
 */
export function formatTaskResponse(task: Task): FormattedTask {
  return {
    ...task,
    is_recurring: task.rrule !== null,
    is_snoozed: task.original_due_at !== null,
  }
}

/**
 * Format multiple tasks for API response
 */
export function formatTasksResponse(tasks: Task[]): FormattedTask[] {
  return tasks.map(formatTaskResponse)
}

/**
 * Build the parenthetical metadata string for a single task.
 * Order: due date, recurrence, priority, labels. Empty parts are omitted.
 * Returns empty string if no metadata is present.
 */
function formatTaskMeta(task: Task, timezone: string): string {
  const parts: string[] = []

  if (task.due_at) {
    parts.push(formatDueTimeParts(task.due_at, timezone).relative)
  }

  if (task.rrule) {
    parts.push(formatRRule(task.rrule, task.anchor_time))
  }

  if (task.priority > 0) {
    parts.push(getPriorityOption(task.priority).label)
  }

  if (task.labels.length > 0) {
    parts.push(...task.labels)
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/**
 * Format selected tasks as human-readable clipboard text, grouped to match the screen.
 *
 * Output rules:
 * - Groups match the current screen grouping (time buckets or projects)
 * - Each header includes the active sort annotation, e.g. "Today (Soonest First):"
 * - Empty groups are skipped
 * - Single task in a group: no bullet prefix
 * - Multiple tasks in a group: bullet prefix ("- ") for each task
 * - Multiple groups: separated by blank lines
 * - Metadata (due, recurrence, priority, labels) in parentheses after title
 */
export function formatTasksForClipboard(groups: ClipboardGroup[], timezone: string): string {
  const sections: string[] = []

  for (const group of groups) {
    if (group.tasks.length === 0) continue

    const sortLabel = CLIPBOARD_SORT_LABELS[group.sort]
    const annotation = group.reversed ? sortLabel.reversed : sortLabel.default
    const lines: string[] = [`${group.label} (${annotation}):`]

    if (group.tasks.length === 1) {
      const task = group.tasks[0]
      lines.push(`${task.title}${formatTaskMeta(task, timezone)}`)
    } else {
      for (const task of group.tasks) {
        lines.push(`- ${task.title}${formatTaskMeta(task, timezone)}`)
      }
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}
