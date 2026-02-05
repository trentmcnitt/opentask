import type { Task } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'

export interface SaveTaskResult {
  task: Task
  description?: string
}

/**
 * Shared utility for saving QuickActionPanel changes via PATCH.
 * Used by both the dashboard (page.tsx) and task detail page (tasks/[id]/page.tsx)
 * to ensure identical payloads and error handling.
 *
 * Returns the updated task and the server-generated description for use in toasts.
 */
export async function saveTaskChanges(
  taskId: number | string,
  changes: QuickActionPanelChanges,
): Promise<SaveTaskResult> {
  const res = await fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  })
  if (!res.ok) throw new Error('Failed to update task')
  const data = await res.json()
  return {
    task: data.data as Task,
    description: data.data.description as string | undefined,
  }
}
