'use client'

import { useCallback, useRef, useState } from 'react'
import { DetailModalShell } from '@/components/DetailModalShell'
import { QuotaDetail, type QuotaChanges, type QuotaCreateDraft } from '@/components/QuotaDetail'
import { cn } from '@/lib/utils'
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
  const [isDirty, setIsDirty] = useState(false)
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)
  const single = tasks.length === 1 ? tasks[0] : null
  const creating = tasks.length === 0 && !!create

  // The ref is written synchronously here, the state drives rendering. The
  // dismissal guard reads the ref: a callback closing over state trails the
  // editor's report by a render, and an Escape right after an edit used to
  // reach a guard that still believed the editor was clean.
  const isDirtyRef = useRef(false)
  const handleDirtyChange = useCallback((dirty: boolean) => {
    isDirtyRef.current = dirty
    setIsDirty(dirty)
  }, [])

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

  /** Commit whatever the editor has staged — used by the unsaved-changes guard. */
  const handleCommit = useCallback(() => saveRef.current?.(), [])

  if (tasks.length === 0 && !creating) return null

  const name = creating ? 'New quota' : single ? 'Quota' : 'Quotas'
  const panel = (
    <div
      className={cn(
        'rounded-lg border p-3',
        isDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
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
        onDirtyChange={handleDirtyChange}
        saveRef={saveRef}
      />
    </div>
  )

  return (
    <DetailModalShell
      open={open}
      title={name}
      description="Change how often this is counted"
      isDirty={isDirty}
      dirtyRef={isDirtyRef}
      onClose={onClose}
      onSave={handleCommit}
    >
      {panel}
    </DetailModalShell>
  )
}
