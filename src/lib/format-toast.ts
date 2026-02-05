/**
 * Toast message formatting utilities
 *
 * These helpers format toast messages based on the changes made to tasks,
 * providing clear, human-readable feedback about what was updated.
 */

import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  labels: 'labels',
  rrule: 'recurrence',
  project_id: 'project',
  due_at: 'due date',
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Format a toast message based on the changes being saved.
 *
 * - Single field: "Priority updated" or "Recurrence removed"
 * - Two fields: "Updated priority and due date"
 * - Three+ fields: "Updated 3 fields"
 */
export function formatChangesToast(changes: QuickActionPanelChanges): string {
  // Filter out internal fields that shouldn't be counted for user-facing messages
  const fields = Object.keys(changes).filter((k) => k !== 'recurrence_mode')

  if (fields.length === 0) return 'No changes'

  if (fields.length === 1) {
    const field = fields[0]
    if (field === 'rrule') {
      return changes.rrule ? 'Recurrence updated' : 'Recurrence removed'
    }
    if (field === 'due_at') return 'Task snoozed'
    return `${capitalize(FIELD_LABELS[field] || field)} updated`
  }

  if (fields.length === 2) {
    const labels = fields.map((f) => FIELD_LABELS[f] || f)
    return `Updated ${labels.join(' and ')}`
  }

  return `Updated ${fields.length} fields`
}
