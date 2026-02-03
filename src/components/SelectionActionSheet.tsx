'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Check, X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import type { Task } from '@/types'

interface SelectionActionSheetProps {
  selectedCount: number
  /** The actual selected tasks (for showing their due dates in QuickActionPanel) */
  selectedTasks: Task[]
  onDone: () => void
  /** Called with absolute UTC time for preset operations */
  onSnooze: (until: string) => void
  /** Called with delta minutes for increment operations */
  onSnoozeRelative: (deltaMinutes: number) => void
  onDelete: () => void
  /** Called with absolute priority value (0-4) */
  onPriorityChange: (priority: number) => void
  onMoveToProject?: () => void
  onClear: () => void
  /** Called when user wants to navigate to task detail (single task only) */
  onNavigateToDetail?: (taskId: number) => void
}

export function SelectionActionSheet({
  selectedCount,
  selectedTasks,
  onDone,
  onSnooze,
  onSnoozeRelative,
  onDelete,
  onPriorityChange,
  onMoveToProject,
  onClear,
  onNavigateToDetail,
}: SelectionActionSheetProps) {
  const timezone = useTimezone()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(true)

  // Track pending date change
  const pendingDateRef = useRef<
    { type: 'absolute'; until: string } | { type: 'relative'; deltaMinutes: number } | null
  >(null)

  // Detect mobile vs desktop
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const openSheet = useCallback(() => {
    pendingDateRef.current = null
    setSheetOpen(true)
  }, [])

  // Track date changes but don't apply immediately
  const handleDateChange = useCallback((isoUtc: string) => {
    pendingDateRef.current = { type: 'absolute', until: isoUtc }
  }, [])

  const handleDateChangeRelative = useCallback((deltaMinutes: number) => {
    pendingDateRef.current = { type: 'relative', deltaMinutes }
  }, [])

  // Save button: apply pending changes, close, exit selection mode
  const handleSave = useCallback(() => {
    if (pendingDateRef.current) {
      if (pendingDateRef.current.type === 'absolute') {
        onSnooze(pendingDateRef.current.until)
      } else {
        onSnoozeRelative(pendingDateRef.current.deltaMinutes)
      }
    }
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onSnooze, onSnoozeRelative, onClear])

  // Cancel button: discard changes, close, keep selection
  const handleCancel = useCallback(() => {
    pendingDateRef.current = null
    setSheetOpen(false)
    // Keep selection mode active (don't call onClear)
  }, [])

  const handleDelete = useCallback(() => {
    onDelete()
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onDelete, onClear])

  // Done button on floating bar (outside sheet)
  const handleFloatingDone = useCallback(() => {
    onDone()
  }, [onDone])

  const handleMoveToProject = useCallback(() => {
    onMoveToProject?.()
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onMoveToProject, onClear])

  // On dismiss without explicit save/cancel: keep selection, don't apply changes
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      pendingDateRef.current = null
    }
    setSheetOpen(open)
  }, [])

  // Navigate to task detail (single task only)
  const handleNavigateToDetail = useCallback(() => {
    if (selectedCount === 1 && selectedTasks[0] && onNavigateToDetail) {
      onNavigateToDetail(selectedTasks[0].id)
    }
  }, [selectedCount, selectedTasks, onNavigateToDetail])

  if (selectedCount === 0) return null

  // Modal title: show task title for single task, count for multiple
  const modalTitle =
    selectedCount === 1 && selectedTasks[0]
      ? selectedTasks[0].title
      : `${selectedCount} tasks selected`

  const panelContent = (
    <QuickActionPanel
      task={null}
      selectedTasks={selectedTasks}
      selectedCount={selectedCount}
      timezone={timezone}
      mode="sheet"
      onDateChange={handleDateChange}
      onDateChangeRelative={handleDateChangeRelative}
      onPriorityChange={onPriorityChange}
      onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
      onDelete={handleDelete}
      onSave={handleSave}
      onCancel={handleCancel}
      hideRecurrence
    />
  )

  return (
    <>
      {/* Floating trigger button */}
      <div className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6">
        <div
          className="bg-primary text-primary-foreground flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
          aria-live="polite"
        >
          {/* Show count only when multiple tasks selected */}
          {selectedCount > 1 && (
            <span className="mr-2 text-sm font-medium">{selectedCount} selected</span>
          )}

          <Button
            size="sm"
            variant="secondary"
            onClick={handleFloatingDone}
            className="bg-green-600 text-white hover:bg-green-700"
          >
            <Check className="mr-1 size-4" />
            Done
          </Button>

          {/* Details button - only show for single task selection */}
          {selectedCount === 1 && onNavigateToDetail && (
            <Button size="sm" variant="secondary" onClick={handleNavigateToDetail}>
              <FileText className="mr-1 size-4" />
              Details
            </Button>
          )}

          <Button size="sm" variant="secondary" onClick={openSheet}>
            More
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            aria-label="Clear selection"
            className="text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10 ml-2"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Mobile: bottom sheet */}
      {isMobile ? (
        <Sheet open={sheetOpen} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton>
            <SheetHeader>
              <SheetTitle>{modalTitle}</SheetTitle>
              <SheetDescription className="sr-only">
                Adjust date, priority, and other settings for selected tasks
              </SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">{panelContent}</div>
            <div className="h-6 sm:hidden" />
          </SheetContent>
        </Sheet>
      ) : (
        /* Desktop: centered dialog */
        <Dialog open={sheetOpen} onOpenChange={handleOpenChange}>
          <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4">
            <DialogHeader>
              <DialogTitle>{modalTitle}</DialogTitle>
              <DialogDescription className="sr-only">
                Adjust date, priority, and other settings for selected tasks
              </DialogDescription>
            </DialogHeader>
            {panelContent}
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
