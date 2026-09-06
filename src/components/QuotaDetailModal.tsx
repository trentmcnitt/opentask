'use client'

import { useCallback, useRef, useState } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { QuotaDetail, type QuotaChanges, type QuotaCreateDraft } from '@/components/QuotaDetail'
import { useIsMobile } from '@/hooks/useIsMobile'
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
  const isMobile = useIsMobile()
  const [isDirty, setIsDirty] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)
  const single = tasks.length === 1 ? tasks[0] : null
  const creating = tasks.length === 0 && !!create

  // Dirtiness through a ref, not state: Radix hands a dismissal to whichever
  // onOpenChange it last captured, and a callback closing over state trails the
  // editor's report by a render — an Escape right after an edit reached a guard
  // that still believed the editor was clean. Same fix as ReminderDetailModal.
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

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return
      if (isDirtyRef.current) setShowCloseConfirm(true)
      else onClose()
    },
    [onClose],
  )

  const handleSaveAndClose = useCallback(async () => {
    await saveRef.current?.()
    setShowCloseConfirm(false)
  }, [])

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

  const confirmDialog = (
    <UnsavedChangesDialog
      open={showCloseConfirm}
      onOpenChange={setShowCloseConfirm}
      onDiscard={() => {
        setShowCloseConfirm(false)
        onClose()
      }}
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
              <SheetDescription>Change how often this is counted</SheetDescription>
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
            <DialogDescription>Change how often this is counted</DialogDescription>
          </VisuallyHidden>
          <div className="min-w-0">{panel}</div>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  )
}
