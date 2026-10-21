'use client'

import { useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useProjects } from '@/components/ProjectsProvider'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveTaskChanges } from '@/lib/save-task-changes'
import { showToast } from '@/lib/toast'
import { runSkipUntil } from '@/lib/skip-until'
import type { TaskSegmentActions } from '@/hooks/useTaskSegments'

// The dashboard loads its popover the same way (`DashboardClient`): the panel
// is large and only needed once a row's peek bubble's Open is pressed.
const QuickActionPopover = dynamic(() =>
  import('@/components/QuickActionPopover').then((mod) => ({ default: mod.QuickActionPopover })),
)

/**
 * A task-segment row's editor (task queue PR 3, resolution 10), reached since
 * 2026-10-20 from the row's peek bubble's Open (it was the details icon's):
 * the dashboard's own Quick panel (`QuickActionPopover` —
 * a dialog on a wide screen, a sheet on a phone) for one task, with
 * priority, target, horizon and the rest. Copied from the dashboard's wiring,
 * not reinvented: the save is the shared `saveTaskChanges` PATCH with the
 * server's description on an Undo toast, Done is the row's own done, and
 * delete is the dashboard's soft delete with Undo. "Open" goes to the task
 * page, as on the dashboard. Skip until (PR 4) is the panel's own, with the
 * same request and toast as on the dashboard (`runSkipUntil`).
 *
 * A new target from here goes through the same PATCH as every editor, which
 * clears `queued_at` (`stampTargetSet`): a queued task that gets a target
 * leaves the queue (spec rule 8). Which task is open lives in
 * `useTaskSegments` (`detailsTask` / `openDetails`), so a row opens it through
 * its actions; each surface renders one of these beside its segments (the
 * /reminders page and the dashboard panel), the way `useRowEditor` puts the
 * reminder editor in `DashboardRemindersPanel`.
 */
export function SegmentDetailsModal({
  actions,
  onUndo,
  onCompleted,
}: {
  actions: TaskSegmentActions
  onUndo: () => void
  onCompleted?: () => void
}) {
  const router = useRouter()
  const { projects } = useProjects()
  const { detailsTask: task, closeDetails: close, refresh, done } = actions

  const saveAll = useCallback(
    async (taskId: number, changes: QuickActionPanelChanges) => {
      try {
        const { description } = await saveTaskChanges(taskId, changes)
        showToast({
          message: description || 'Changes saved',
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
        })
        onCompleted?.()
      } catch (err) {
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Failed to save',
          type: 'error',
        })
        // Rethrown so the popover keeps the staged edits and stays open
        // (`QuickActionPopover`'s contract, as on the dashboard).
        throw err
      } finally {
        void refresh()
      }
    },
    [onUndo, onCompleted, refresh],
  )

  const remove = useCallback(
    async (taskId: number) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Delete failed')
        showToast({
          message: 'Task moved to trash',
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
        })
        onCompleted?.()
      } catch (err) {
        showToast({ message: err instanceof Error ? err.message : 'Delete failed', type: 'error' })
      } finally {
        void refresh()
      }
    },
    [onUndo, onCompleted, refresh],
  )

  const skipUntil = useCallback(
    async (taskId: number, until: string | null) => {
      await runSkipUntil([taskId], until, {
        onUndo,
        afterSkip: (result) => {
          // `onCompleted` bumps the host's undo count: only when an entry was written.
          if (result.tasks_affected > 0) onCompleted?.()
          void refresh()
        },
      })
    },
    [onUndo, onCompleted, refresh],
  )

  return (
    <QuickActionPopover
      focusedTask={task}
      open={task !== null}
      onClose={close}
      onSaveAll={saveAll}
      onDelete={(id) => void remove(id)}
      onMarkDone={() => {
        if (task) void done(task)
      }}
      onNavigateToDetail={(id) => router.push(`/tasks/${id}`)}
      onSkipUntil={skipUntil}
      projects={projects}
    />
  )
}
