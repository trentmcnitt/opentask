'use client'

import { useCallback, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickActionPanel, QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useEditorHost } from '@/hooks/useEditorHost'
import { DirtyCard } from '@/components/DirtyCard'
import type { Task, Project } from '@/types'

interface QuickActionPopoverProps {
  /** The focused task (from onMouseEnter) */
  focusedTask: Task | null
  /** Whether the popover/sheet is open */
  open: boolean
  /** Close handler */
  onClose: () => void
  /**
   * Batched save callback - all changes are sent in a single call. Rejects
   * (after reporting the failure) when the save fails, so the panel keeps the
   * staged edits and the popover stays open.
   */
  onSaveAll: (taskId: number, changes: QuickActionPanelChanges) => Promise<void>
  /** Called to delete task */
  onDelete?: (taskId: number) => void
  /** Called to mark task as done */
  onMarkDone?: (taskId: number) => void
  /** Called to navigate to task detail page */
  onNavigateToDetail?: (taskId: number) => void
  /** Available projects for project picker in the quick panel */
  projects?: Project[]
  /** AI annotation text to display in the panel */
  annotation?: string
  /** AI Insights commentary text to display in the panel */
  insightsCommentary?: string
}

export function QuickActionPopover({
  focusedTask,
  open,
  onClose,
  onSaveAll,
  onDelete,
  onMarkDone,
  onNavigateToDetail,
  projects,
  annotation,
  insightsCommentary,
}: QuickActionPopoverProps) {
  const timezone = useTimezone()
  const isMobile = useIsMobile()

  const handleNavigateToDetail = useCallback(() => {
    if (!focusedTask || !onNavigateToDetail) return
    onNavigateToDetail(focusedTask.id)
    onClose()
  }, [focusedTask, onNavigateToDetail, onClose])

  const handleDelete = useCallback(() => {
    if (focusedTask && onDelete) {
      onDelete(focusedTask.id)
      onClose()
    }
  }, [focusedTask, onDelete, onClose])

  const handleMarkDone = useCallback(() => {
    if (focusedTask && onMarkDone) {
      onMarkDone(focusedTask.id)
      onClose()
    }
  }, [focusedTask, onMarkDone, onClose])

  // Batched save handler - wraps onSaveAll with taskId. It does not close the
  // popover itself: the panel calls onSave (= onClose) once the save resolves,
  // and on a rejection (already reported by the host) it keeps the staged
  // edits and the popover stays open, so a refused save loses nothing.
  const handleSaveAll = useCallback(
    async (changes: QuickActionPanelChanges) => {
      if (!focusedTask) return
      await onSaveAll(focusedTask.id, changes)
    },
    [focusedTask, onSaveAll],
  )

  // Dirty state from QuickActionPanel: `isDirty` paints the stripe and locks
  // the sheet's drag; the dismiss guard reads `dirtyRef`, which is current the
  // moment the panel reports (see useEditorHost for why state is not enough).
  const { isDirty: isPanelDirty, dirtyRef, onDirtyChange, saveRef, commit } = useEditorHost()
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  // Handle dialog/sheet close — intercept when dirty to show confirmation
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        if (dirtyRef.current) {
          setShowCloseConfirm(true)
        } else {
          onClose()
        }
      }
    },
    [onClose, dirtyRef],
  )

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    onClose()
  }, [onClose])

  const handleSaveAndClose = useCallback(async () => {
    // commit() runs QuickActionPanel's save, which calls onSave (= onClose) on
    // success and keeps the popover open with its edits on failure. It does
    // not reject; either way the confirmation closes.
    await commit()
    setShowCloseConfirm(false)
  }, [commit])

  if (!focusedTask) return null

  const panel = (
    <DirtyCard dirty={isPanelDirty}>
      <QuickActionPanel
        key={focusedTask.id}
        task={focusedTask}
        timezone={timezone}
        mode={isMobile ? 'sheet' : 'popover'}
        titleVariant="prominent"
        onSaveAll={handleSaveAll}
        onDelete={onDelete ? handleDelete : undefined}
        onMarkDone={onMarkDone ? handleMarkDone : undefined}
        onNavigateToDetail={onNavigateToDetail ? handleNavigateToDetail : undefined}
        onSave={onClose}
        onCancel={onClose}
        onDirtyChange={onDirtyChange}
        saveRef={saveRef}
        projects={projects}
        annotation={annotation}
        insightsCommentary={insightsCommentary}
      />
    </DirtyCard>
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
            className="rounded-t-2xl"
            showCloseButton={false}
            draggable={!isPanelDirty}
          >
            {/* Accessibility: Radix Dialog requires a title — hide it visually */}
            <VisuallyHidden>
              <SheetTitle>Quick Actions</SheetTitle>
              <SheetDescription>Adjust date, priority, and other task settings</SheetDescription>
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
        <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4" showCloseButton={false}>
          <VisuallyHidden>
            <DialogTitle>Quick Actions</DialogTitle>
            <DialogDescription>Adjust date, priority, and other task settings</DialogDescription>
          </VisuallyHidden>
          <div className="min-w-0">{panel}</div>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  )
}
