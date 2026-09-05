'use client'

import { useCallback, useRef, useState } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { ReminderDetail, type ReminderRuleChange } from '@/components/ReminderDetail'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useIsMobile } from '@/hooks/useIsMobile'
import { cn } from '@/lib/utils'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

/**
 * The Reminders surface's Details: `ReminderDetail` in a dialog on a wide
 * screen and a bottom sheet on a phone — the same split, the same dirty
 * guard, as the dashboard's quick-action popover, so the two surfaces feel
 * like one app. The host page renders the very same component at full size.
 * One selected reminder gets the full editor; several get their schedule
 * edited together.
 *
 * `tasks` is a SNAPSHOT taken when the modal opened, not rows looked up in
 * the live groups: the surface refreshes on every sync event, and a task
 * identity that changed under the editor would either reset the staged edits
 * or vanish when the row left today's list.
 */
interface ReminderDetailModalProps {
  tasks: Task[]
  open: boolean
  timeSlots: TimeSlot[]
  onClose: () => void
  /** One reminder: saves and reports; rejects on failure so the modal stays open with the edits. */
  onSaveAll: (taskId: number, changes: QuickActionPanelChanges) => Promise<void>
  /** Several: one request, one Undo; same contract. */
  onSaveMany: (changes: ReminderRuleChange[]) => Promise<void>
  onConsidered: (tasks: Task[]) => void
  onDelete: (tasks: Task[]) => void
  onOpenPage: (taskId: number) => void
}

export function ReminderDetailModal({
  tasks,
  open,
  timeSlots,
  onClose,
  onSaveAll,
  onSaveMany,
  onConsidered,
  onDelete,
  onOpenPage,
}: ReminderDetailModalProps) {
  const isMobile = useIsMobile()
  const [isDirty, setIsDirty] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)
  const single = tasks.length === 1 ? tasks[0] : null

  // The dismiss guard reads dirtiness through a ref, not the state. Radix
  // hands a dismissal (Escape, a click outside) to whichever `onOpenChange`
  // it last captured, and a callback that closes over state trails the
  // editor's report by a render — under load, an Escape that follows a chip
  // tap closely reached a guard that still believed the editor was clean, and
  // the staged edit was dropped without asking (seen in the full E2E run).
  // The ref is current the moment the editor reports; the state only paints
  // the stripe.
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
    async (changes: ReminderRuleChange[]) => {
      await onSaveMany(changes)
      onClose()
    },
    [onSaveMany, onClose],
  )

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return
      if (isDirtyRef.current) setShowCloseConfirm(true)
      else onClose()
    },
    [onClose],
  )

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    onClose()
  }, [onClose])

  const handleSaveAndClose = useCallback(async () => {
    await saveRef.current?.()
    // A successful save closes the modal itself; a failed one leaves it open
    // with the edits, and the confirmation has served its purpose either way.
    setShowCloseConfirm(false)
  }, [])

  if (tasks.length === 0) return null

  const name = single ? 'Reminder' : 'Reminders'
  const panel = (
    <div
      className={cn(
        'rounded-lg border p-3',
        isDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <ReminderDetail
        key={tasks.map((t) => t.id).join(',')}
        tasks={tasks}
        timeSlots={timeSlots}
        showKind
        onSaveAll={handleSaveAll}
        onSaveMany={handleSaveMany}
        onConsidered={() => {
          onConsidered(tasks)
          onClose()
        }}
        onDelete={() => {
          onDelete(tasks)
          onClose()
        }}
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

  const confirmDialog = (
    <UnsavedChangesDialog
      open={showCloseConfirm}
      onOpenChange={setShowCloseConfirm}
      onDiscard={handleDiscardAndClose}
      onSave={handleSaveAndClose}
    />
  )

  if (isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent
            side="bottom"
            className="max-h-[92dvh] overflow-y-auto rounded-t-2xl"
            showCloseButton={false}
            draggable={!isDirty}
          >
            <VisuallyHidden>
              <SheetTitle>{name}</SheetTitle>
              <SheetDescription>Change when this comes up</SheetDescription>
            </VisuallyHidden>
            <div className="px-4 pb-2">{panel}</div>
          </SheetContent>
        </Sheet>
        {confirmDialog}
      </>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-h-[90vh] w-[32rem] max-w-[calc(100%-2rem)] overflow-y-auto p-4"
          showCloseButton={false}
        >
          <VisuallyHidden>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>Change when this comes up</DialogDescription>
          </VisuallyHidden>
          <div className="min-w-0">{panel}</div>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  )
}
