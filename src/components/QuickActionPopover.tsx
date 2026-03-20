'use client'

import { useCallback, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickActionPanel, QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { cn } from '@/lib/utils'
import type { Task, Project } from '@/types'

interface QuickActionPopoverProps {
  /** The focused task (from onMouseEnter) */
  focusedTask: Task | null
  /** Whether the popover/sheet is open */
  open: boolean
  /** Close handler */
  onClose: () => void
  /** Batched save callback - all changes are sent in a single call */
  onSaveAll: (taskId: number, changes: QuickActionPanelChanges) => void
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

  // Batched save handler - wraps onSaveAll with taskId and closes the popover
  const handleSaveAll = useCallback(
    (changes: QuickActionPanelChanges) => {
      if (!focusedTask) return
      onSaveAll(focusedTask.id, changes)
      onClose()
    },
    [focusedTask, onSaveAll, onClose],
  )

  // Track dirty state from QuickActionPanel for visual indicator
  const [isPanelDirty, setIsPanelDirty] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)

  // Handle dialog/sheet close — intercept when dirty to show confirmation
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        if (isPanelDirty) {
          setShowCloseConfirm(true)
        } else {
          onClose()
        }
      }
    },
    [onClose, isPanelDirty],
  )

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    onClose()
  }, [onClose])

  const handleSaveAndClose = useCallback(async () => {
    try {
      await saveRef.current?.()
      // saveRef triggers QuickActionPanel's handleSave, which calls onSave (= onClose)
    } catch {
      setShowCloseConfirm(false)
      return
    }
    setShowCloseConfirm(false)
  }, [])

  if (!focusedTask) return null

  const panel = (
    <div
      className={cn(
        'rounded-lg border p-3',
        isPanelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
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
        onDirtyChange={setIsPanelDirty}
        saveRef={saveRef}
        projects={projects}
        annotation={annotation}
        insightsCommentary={insightsCommentary}
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
