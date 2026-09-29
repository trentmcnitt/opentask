'use client'

import { useCallback } from 'react'
import { DetailModalShell } from '@/components/DetailModalShell'
import { DirtyCard } from '@/components/DirtyCard'
import { QuotaDetail, type QuotaChanges, type QuotaCreateDraft } from '@/components/QuotaDetail'
import { useEditorHost } from '@/hooks/useEditorHost'
import type { Task } from '@/types'

/**
 * The Quotas surface's Details: `QuotaDetail` in a dialog on a wide screen and
 * a bottom sheet on a phone — the same split, the same dirty guard, as
 * `ReminderDetailModal`. Editing happens here; the full page exists for deep
 * links and for "Open full page", exactly as Trent settled for reminders on
 * 2026-09-05 and as this should have followed from the start.
 *
 * `tasks` is a SNAPSHOT taken when the modal opened, not rows looked up live:
 * the surface refreshes on its own, and an identity changing under the editor
 * would reset the staged edits.
 */
export function QuotaDetailModal({
  tasks,
  create,
  open,
  onClose,
  onSave,
  onCreate,
  onDelete,
  onOpenPage,
}: {
  tasks: Task[]
  create?: QuotaCreateDraft | null
  open: boolean
  onClose: () => void
  onSave: (ids: number[], changes: QuotaChanges) => Promise<void>
  onCreate: (changes: QuotaChanges) => Promise<void>
  onDelete: (tasks: Task[]) => void
  onOpenPage: (taskId: number) => void
}) {
  // Dirtiness lives in a ref for the dismiss guard and in state for the
  // stripe — see useEditorHost for why both.
  const { isDirty, dirtyRef, onDirtyChange, saveRef, commit } = useEditorHost()
  const single = tasks.length === 1 ? tasks[0] : null
  const creating = tasks.length === 0 && !!create

  const handleSave = useCallback(
    async (changes: QuotaChanges) => {
      await onSave(
        tasks.map((t) => t.id),
        changes,
      )
      onClose()
    },
    [tasks, onSave, onClose],
  )

  const handleCreate = useCallback(
    async (changes: QuotaChanges) => {
      await onCreate(changes)
      onClose()
    },
    [onCreate, onClose],
  )

  if (tasks.length === 0 && !creating) return null

  const name = creating ? 'New quota' : single ? 'Quota' : 'Quotas'
  const panel = (
    <DirtyCard dirty={isDirty}>
      <QuotaDetail
        key={creating ? 'new' : tasks.map((t) => t.id).join(',')}
        tasks={tasks}
        create={creating ? create : undefined}
        showKind
        onSave={handleSave}
        onCreate={handleCreate}
        onDelete={
          creating
            ? undefined
            : () => {
                onDelete(tasks)
                onClose()
              }
        }
        onCancel={onClose}
        onOpenPage={
          single
            ? () => {
                onOpenPage(single.id)
                onClose()
              }
            : undefined
        }
        onDirtyChange={onDirtyChange}
        saveRef={saveRef}
      />
    </DirtyCard>
  )

  return (
    <DetailModalShell
      open={open}
      title={name}
      description="Change how often this is counted"
      isDirty={isDirty}
      dirtyRef={dirtyRef}
      onClose={onClose}
      onSave={commit}
    >
      {panel}
    </DetailModalShell>
  )
}
