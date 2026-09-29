import type { Task } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'

export interface SaveTaskResult {
  task: Task
  description?: string
}

/**
 * The changes with `ai-failed` added to `labels_remove` when `task` carries it.
 *
 * A schedule set by hand makes an earlier AI failure moot: the mark says
 * "until you edit it", so editing it takes the mark off. Applied by the
 * reminder editors (`saveReminderDetail`); the task page does not apply it.
 * `task` may be undefined (the editor no longer holds it) — the changes then
 * go out unchanged.
 */
export function withAiFailedCleared(
  task: Pick<Task, 'labels'> | undefined,
  changes: QuickActionPanelChanges,
): QuickActionPanelChanges {
  if (!task?.labels.includes('ai-failed')) return changes
  return { ...changes, labels_remove: [...(changes.labels_remove ?? []), 'ai-failed'] }
}

/**
 * Shared utility for saving QuickActionPanel changes to ONE task via PATCH, so
 * every single-task editor sends identical payloads and handles errors the
 * same way. Callers:
 * - `useTaskActions` — the dashboard's quick-action popover and the task
 *   detail page (tasks/[id]/page.tsx)
 * - `saveReminderDetail` — the reminder detail editor in `RemindersView` and
 *   `DashboardRemindersPanel`
 * - `saveQuickPanelChanges` — a single-task save from the selection action bar
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
  if (!res.ok) {
    // Surface the server's reason rather than a generic failure. Some refusals
    // are rules the user can act on — e.g. §5/§6's "a task cannot be both
    // tracked and a reminder" — and silently swallowing them makes the toggle
    // look broken instead of refused.
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || 'Failed to update task')
  }
  const data = await res.json()
  return {
    task: data.data as Task,
    description: data.data.description as string | undefined,
  }
}
