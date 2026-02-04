/**
 * Task response formatting helper
 *
 * Adds computed fields (is_recurring, is_snoozed) to task responses.
 */

import type { Task } from '@/types'

export interface FormattedTask extends Task {
  is_recurring: boolean
  is_snoozed: boolean
}

/**
 * Format a task for API response by adding computed fields
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
