'use client'

import { useCallback, useRef, useState } from 'react'
import { DetailModalShell } from '@/components/DetailModalShell'
import {
  ReminderDetail,
  type ReminderBulkChanges,
  type ReminderCreateDraft,
} from '@/components/ReminderDetail'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import type { ReminderCreateInput } from '@/hooks/useReminders'
import { cn } from '@/lib/utils'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

/**
 * The Reminders surface's Details: `ReminderDetail` in a dialog on a wide
 * screen and a bottom sheet on a phone — the same split, the same dirty
 * guard, as the dashboard's quick-action popover, so the two surfaces feel
 * like one app. The host page renders the very same component at full size.
 * One selected reminder gets the full editor; several get their schedule
 * edited together; with `create` set and no tasks it is the new-reminder
 * form (the sidebar's Add Reminder, the phone's plus, the quick add's plus).
 *
 * `tasks` is a SNAPSHOT taken when the modal opened, not rows looked up in
 * the live groups: the surface refreshes on every sync event, and a task
 * identity that changed under the editor would either reset the staged edits
 * or vanish when the row left today's list.
 */
interface ReminderDetailModalProps {
  tasks: Task[]
  /** New-reminder mode, with whatever was typed before the form was opened. */
  create?: ReminderCreateDraft | null
  open: boolean
  timeSlots: TimeSlot[]
  onClose: () => void
  /** One reminder: saves and reports; rejects on failure so the modal stays open with the edits. */
  onSaveAll: (taskId: number, changes: QuickActionPanelChanges) => Promise<void>
  /** Several: one request, one Undo; same contract. */
  onSaveMany: (changes: ReminderBulkChanges) => Promise<void>
  /** New: creates and reports; same contract. */
  onCreate: (input: ReminderCreateInput) => Promise<void>
  onConsidered: (tasks: Task[]) => void
  onDelete: (tasks: Task[]) => void
  onOpenPage: (taskId: number) => void
}

export function ReminderDetailModal({
  tasks,
  create,
  open,
  timeSlots,
  onClose,
  onSaveAll,
  onSaveMany,
  onCreate,
  onConsidered,
  onDelete,
  onOpenPage,
}: ReminderDetailModalProps) {
  const [isDirty, setIsDirty] = useState(false)
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)
  const single = tasks.length === 1 ? tasks[0] : null
  const creating = tasks.length === 0 && !!create

  // The dismiss guard reads dirtiness through a ref, not the state. Radix
  // hands a dismissal (Escape, a click outside) to whichever `onOpenChange`
  // it last captured, and a callback that closes over state trails the
  // editor's report by a render — under load, an Escape that follows a chip
  // tap closely reached a guard that still believed the editor was clean, and
  // the staged edit was dropped without asking (seen in the full E2E run).
  // The ref is current the moment the editor reports; the state only paints
  // the stripe.
  // The ref is written synchronously here, the state drives rendering. The
  // dismissal guard reads the ref: a callback closing over state trails the
  // editor's report by a render, and an Escape right after an edit used to
  // reach a guard that still believed the editor was clean.
  const isDirtyRef = useRef(false)
  const handleDirtyChange = useCallback((dirty: boolean) => {
    isDirtyRef.current = dirty
    setIsDirty(dirty)
  }, [])

  const handleSaveAll = useCallback(
    async (changes: QuickActionPanelChanges) => {
      if (!single) return
      await onSaveAll(single.id, changes)
      onClose()
    },
    [single, onSaveAll, onClose],
  )

  const handleSaveMany = useCallback(
    async (changes: ReminderBulkChanges) => {
      await onSaveMany(changes)
      onClose()
    },
    [onSaveMany, onClose],
  )

  const handleCreate = useCallback(
    async (input: ReminderCreateInput) => {
      await onCreate(input)
      onClose()
    },
    [onCreate, onClose],
  )

  /** Commit whatever the editor has staged — used by the unsaved-changes guard. */
  const handleCommit = useCallback(() => saveRef.current?.(), [])

  if (tasks.length === 0 && !creating) return null

  const name = creating ? 'New reminder' : single ? 'Reminder' : 'Reminders'
  const panel = (
    <div
      className={cn(
        'rounded-lg border p-3',
        isDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <ReminderDetail
        key={creating ? 'new' : tasks.map((t) => t.id).join(',')}
        tasks={tasks}
        create={creating ? create : undefined}
        timeSlots={timeSlots}
        showKind
        onSaveAll={handleSaveAll}
        onSaveMany={handleSaveMany}
        onCreate={handleCreate}
        onConsidered={
          creating
            ? undefined
            : () => {
                onConsidered(tasks)
                onClose()
              }
        }
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
      description="Change when this comes up"
      isDirty={isDirty}
      dirtyRef={isDirtyRef}
      onClose={onClose}
      onSave={handleCommit}
    >
      {panel}
    </DetailModalShell>
  )
}
