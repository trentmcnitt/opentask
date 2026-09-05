'use client'

import { useCallback, useRef, useState } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { ReminderDetail } from '@/components/ReminderDetail'
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
 *
 * `task` is a SNAPSHOT taken when the modal opened, not a row looked up in
 * the live groups: the surface refreshes on every sync event, and a task
 * identity that changed under the editor would either reset the staged edits
 * or vanish when the row left today's list.
 */
interface ReminderDetailModalProps {
  task: Task | null
  open: boolean
  timeSlots: TimeSlot[]
  onClose: () => void
  /** Saves and reports; rejects on failure so the modal stays open with the edits. */
  onSaveAll: (taskId: number, changes: QuickActionPanelChanges) => Promise<void>
  onConsidered: (task: Task) => void
  onDelete: (task: Task) => void
  onOpenPage: (taskId: number) => void
}

export function ReminderDetailModal({
  task,
  open,
  timeSlots,
  onClose,
  onSaveAll,
  onConsidered,
  onDelete,
  onOpenPage,
}: ReminderDetailModalProps) {
  const isMobile = useIsMobile()
  const [isDirty, setIsDirty] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)

  const handleSaveAll = useCallback(
    async (changes: QuickActionPanelChanges) => {
      if (!task) return
      await onSaveAll(task.id, changes)
      onClose()
    },
    [task, onSaveAll, onClose],
  )

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return
      if (isDirty) setShowCloseConfirm(true)
      else onClose()
    },
    [isDirty, onClose],
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

  if (!task) return null

  const panel = (
    <div
      className={cn(
        'rounded-lg border p-3',
        isDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <ReminderDetail
        key={task.id}
        task={task}
        timeSlots={timeSlots}
        showKind
        onSaveAll={handleSaveAll}
        onConsidered={() => {
          onConsidered(task)
          onClose()
        }}
        onDelete={() => {
          onDelete(task)
          onClose()
        }}
        onCancel={onClose}
        onOpenPage={() => {
          onOpenPage(task.id)
          onClose()
        }}
        onDirtyChange={setIsDirty}
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
              <SheetTitle>Reminder</SheetTitle>
              <SheetDescription>Change when this reminder comes up</SheetDescription>
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
            <DialogTitle>Reminder</DialogTitle>
            <DialogDescription>Change when this reminder comes up</DialogDescription>
          </VisuallyHidden>
          <div className="min-w-0">{panel}</div>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  )
}
