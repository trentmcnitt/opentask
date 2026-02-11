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
  original_due: { default: 'Oldest Original Due', reversed: 'Newest Original Due' },
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
 * Order: project name (in brackets), then parenthetical with due date, recurrence, priority, labels.
 * Empty parts are omitted. Returns empty string if no metadata is present.
 */
function formatTaskMeta(task: Task, timezone: string, projectName?: string): string {
  const prefix = projectName ? ` [${projectName}]` : ''
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

  const parens = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `${prefix}${parens}`
}

/**
 * Format the first line of task notes for clipboard, truncated to ~100 chars.
 * Returns null if notes is empty/null.
 */
function formatNotesLine(notes: string | null): string | null {
  if (!notes) return null
  const firstLine = notes.split('\n')[0].trim()
  if (!firstLine) return null
  if (firstLine.length > 100) return firstLine.slice(0, 97) + '...'
  return firstLine
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
export function formatTasksForClipboard(
  groups: ClipboardGroup[],
  timezone: string,
  projectMap?: Map<number, string>,
): string {
  const sections: string[] = []

  for (const group of groups) {
    if (group.tasks.length === 0) continue

    const sortLabel = CLIPBOARD_SORT_LABELS[group.sort]
    const annotation = group.reversed ? sortLabel.reversed : sortLabel.default
    const lines: string[] = [`${group.label} (${annotation}):`]

    const bullet = group.tasks.length > 1 ? '- ' : ''
    for (const task of group.tasks) {
      const projectName = projectMap?.get(task.project_id)
      lines.push(`${bullet}${task.title}${formatTaskMeta(task, timezone, projectName)}`)
      const notesLine = formatNotesLine(task.notes)
      if (notesLine) {
        lines.push(`    ${notesLine}`)
      }
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}
