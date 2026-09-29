import type { Task } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveTaskChanges, withAiFailedCleared } from '@/lib/save-task-changes'
import { showToast } from '@/lib/toast'

/**
 * Save ONE reminder from `ReminderDetailModal`'s editor — the write both
 * reminder surfaces share (`RemindersView`'s Details editor and the dashboard
 * panel's press-and-hold editor), so they send the same PATCH and show the
 * same toast with the same Undo.
 *
 * - `source` is the reminders the editor was opened with; the one being saved
 *   is looked up there to decide whether its `ai-failed` mark comes off (see
 *   `withAiFailedCleared`).
 * - On success: the server's description (or "Reminder updated") with Undo,
 *   then `onCompleted` and a background `refresh`.
 * - On failure: an error toast with the server's reason, and the error is
 *   rethrown so the editor stays open with the user's edits.
 */
export async function saveReminderDetail(
  taskId: number,
  changes: QuickActionPanelChanges,
  {
    source,
    onUndo,
    onCompleted,
    refresh,
  }: {
    source: readonly Task[]
    onUndo: () => void
    onCompleted?: () => void
    refresh: () => Promise<void> | void
  },
): Promise<void> {
  try {
    const task = source.find((t) => t.id === taskId)
    const { description } = await saveTaskChanges(taskId, withAiFailedCleared(task, changes))
    showToast({
      message: description || 'Reminder updated',
      type: 'success',
      action: { label: 'Undo', onClick: onUndo },
    })
    onCompleted?.()
    void refresh()
  } catch (err) {
    showToast({
      message: err instanceof Error && err.message ? err.message : 'Save failed',
      type: 'error',
    })
    throw err
  }
}
