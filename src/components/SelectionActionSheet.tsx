'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
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
import { useIsMobile } from '@/hooks/useIsMobile'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import { computeCommonLabels } from '@/lib/bulk-utils'
import { cn } from '@/lib/utils'
import type { Task, Project } from '@/types'

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
  /** Called when recurrence changes for selected tasks */
  onRecurrenceChange?: (
    rrule: string | null,
    recurrenceMode?: 'from_due' | 'from_completion',
  ) => void
  /** Available projects for project picker (enables inline project selection) */
  projects?: Project[]
  /** Called when labels are added (bulk add) */
  onLabelsAdd?: (labels: string[]) => void
  /** Called when labels are removed (bulk remove) */
  onLabelsRemove?: (labels: string[]) => void
  /** Called when project is changed via inline picker */
  onProjectChange?: (projectId: number) => void
  /** Ref populated with openSheet function for external triggering (e.g., Cmd+S shortcut) */
  sheetOpenRef?: React.MutableRefObject<(() => void) | null>
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
  onRecurrenceChange,
  projects,
  onLabelsAdd,
  onLabelsRemove,
  onProjectChange,
  sheetOpenRef,
}: SelectionActionSheetProps) {
  const timezone = useTimezone()
  const [sheetOpen, setSheetOpen] = useState(false)
  const isMobile = useIsMobile()

  // Pending state for priority, labels, project (staged until Save)
  // These use refs instead of state because they're only read synchronously in handleSave.
  // Using useState caused a bug: React batches state updates, so when QuickActionPanel's
  // individual-callbacks path called setPendingX then onSave in sequence, handleSave
  // would read the stale (pre-update) values and silently drop the changes.
  const pendingPriorityRef = useRef<number | null>(null)
  const pendingLabelsAddRef = useRef<string[]>([])
  const pendingLabelsRemoveRef = useRef<string[]>([])
  const pendingProjectRef = useRef<number | null>(null)

  // Track pending date change
  const pendingDateRef = useRef<
    { type: 'absolute'; until: string } | { type: 'relative'; deltaMinutes: number } | null
  >(null)

  // Compute bulk recurrence summary for display
  const recurrenceSummary = useMemo(() => {
    return formatBulkRecurrence(selectedTasks)
  }, [selectedTasks])

  const clearPendingState = useCallback(() => {
    pendingDateRef.current = null
    pendingPriorityRef.current = null
    pendingLabelsAddRef.current = []
    pendingLabelsRemoveRef.current = []
    pendingProjectRef.current = null
  }, [])

  const openSheet = useCallback(() => {
    clearPendingState()
    setSheetOpen(true)
  }, [clearPendingState])

  // Expose openSheet to parent via ref for external triggering (e.g., Cmd+S shortcut)
  useEffect(() => {
    if (sheetOpenRef) {
      sheetOpenRef.current = openSheet
      return () => {
        sheetOpenRef.current = null
      }
    }
  }, [sheetOpenRef, openSheet])

  // Track date changes but don't apply immediately
  const handleDateChange = useCallback((isoUtc: string) => {
    pendingDateRef.current = { type: 'absolute', until: isoUtc }
  }, [])

  const handleDateChangeRelative = useCallback((deltaMinutes: number) => {
    pendingDateRef.current = { type: 'relative', deltaMinutes }
  }, [])

  // Save button: apply pending changes, close, exit selection mode
  // Note: recurrence changes are handled by QuickActionPanel via onRruleChange
  const handleSave = useCallback(() => {
    if (pendingDateRef.current) {
      if (pendingDateRef.current.type === 'absolute') {
        onSnooze(pendingDateRef.current.until)
      } else {
        onSnoozeRelative(pendingDateRef.current.deltaMinutes)
      }
    }
    // Apply pending priority change
    if (pendingPriorityRef.current !== null) {
      onPriorityChange(pendingPriorityRef.current)
    }
    // Apply pending label changes (add/remove)
    if (pendingLabelsAddRef.current.length > 0 && onLabelsAdd) {
      onLabelsAdd(pendingLabelsAddRef.current)
    }
    if (pendingLabelsRemoveRef.current.length > 0 && onLabelsRemove) {
      onLabelsRemove(pendingLabelsRemoveRef.current)
    }
    // Apply pending project change
    if (pendingProjectRef.current !== null && onProjectChange) {
      onProjectChange(pendingProjectRef.current)
    }
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [
    onSnooze,
    onSnoozeRelative,
    onClear,
    onPriorityChange,
    onLabelsAdd,
    onLabelsRemove,
    onProjectChange,
  ])

  // Cancel button: discard changes, close, keep selection
  const handleCancel = useCallback(() => {
    clearPendingState()
    setSheetOpen(false)
    // Keep selection mode active (don't call onClear)
  }, [clearPendingState])

  const handleDelete = useCallback(() => {
    onDelete()
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onDelete, onClear])

  const handleMoveToProject = useCallback(() => {
    onMoveToProject?.()
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onMoveToProject, onClear])

  // On dismiss without explicit save/cancel: keep selection, don't apply changes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) clearPendingState()
      setSheetOpen(open)
    },
    [clearPendingState],
  )

  // Handle priority change from QuickActionPanel (stages change until Save)
  const handlePriorityChange = useCallback((priority: number) => {
    pendingPriorityRef.current = priority
  }, [])

  // Compute bulk common labels (intersection of labels across all selected tasks)
  // This is the baseline for computing add/remove operations
  const bulkCommonLabels = useMemo(() => computeCommonLabels(selectedTasks), [selectedTasks])

  /**
   * Label diffing architecture for bulk operations:
   *
   * QuickActionPanel displays `bulkCommonLabels` (labels shared by ALL selected tasks).
   * When the user adds/removes labels in the UI, QuickActionPanel passes the complete
   * new label set to this handler. We then compute the diff:
   *
   *   - toAdd: labels in newLabels but not in bulkCommonLabels
   *   - toRemove: labels in bulkCommonLabels but not in newLabels
   *
   * The bulk edit API uses ADDITIVE mode (labels_add/labels_remove), which preserves
   * each task's existing labels while applying the add/remove operations. This means:
   *
   *   - Adding "Work" adds it to all selected tasks (even if some already have it)
   *   - Removing "Work" removes it from all selected tasks (preserving other labels)
   *
   * Example: Tasks A has ["Work", "Personal"], Task B has ["Work"]
   *   - bulkCommonLabels = ["Work"]
   *   - User adds "Urgent": toAdd=["Urgent"], toRemove=[]
   *     -> A becomes ["Work", "Personal", "Urgent"], B becomes ["Work", "Urgent"]
   *   - User removes "Work": toAdd=[], toRemove=["Work"]
   *     -> A becomes ["Personal"], B becomes []
   *
   * Note: Labels not in the intersection cannot be removed via this UI (they only
   * appear on some tasks, not all). This is intentional - it prevents accidentally
   * removing labels the user can't see in the bulk view.
   */
  const handleLabelsChange = useCallback(
    (newLabels: string[]) => {
      // Labels to add: in newLabels but not in bulkCommonLabels
      const toAdd = newLabels.filter((l) => !bulkCommonLabels.includes(l))
      // Labels to remove: in bulkCommonLabels but not in newLabels
      const toRemove = bulkCommonLabels.filter((l) => !newLabels.includes(l))
      pendingLabelsAddRef.current = toAdd
      pendingLabelsRemoveRef.current = toRemove
    },
    [bulkCommonLabels],
  )

  // Handle project change from QuickActionPanel (stages change until Save)
  const handleProjectChange = useCallback((projectId: number) => {
    pendingProjectRef.current = projectId
  }, [])

  // Track dirty state from QuickActionPanel for visual indicator
  const [isPanelDirty, setIsPanelDirty] = useState(false)

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
    <div
      className={cn(
        'space-y-3 rounded-lg border p-3',
        isPanelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <QuickActionPanel
        task={null}
        selectedTasks={selectedTasks}
        selectedCount={selectedCount}
        timezone={timezone}
        mode="sheet"
        onDateChange={handleDateChange}
        onDateChangeRelative={handleDateChangeRelative}
        onSave={handleSave}
        onCancel={handleCancel}
        recurrenceSummary={recurrenceSummary}
        onPriorityChange={handlePriorityChange}
        onLabelsChange={handleLabelsChange}
        onRruleChange={onRecurrenceChange}
        onDelete={handleDelete}
        onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
        onNavigateToDetail={
          selectedCount === 1 && onNavigateToDetail ? handleNavigateToDetail : undefined
        }
        projects={projects}
        onProjectChange={handleProjectChange}
        onDirtyChange={setIsPanelDirty}
      />
    </div>
  )

  return (
    <>
      {/* Floating trigger button */}
      <div
        data-selection-sheet
        className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6"
      >
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
            onClick={onDone}
            className="bg-green-600 text-white hover:bg-green-700 active:bg-green-700"
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
            className="text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10 active:bg-primary-foreground/10 ml-2"
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
              <SheetTitle className="truncate">{modalTitle}</SheetTitle>
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
              <DialogTitle className="truncate">{modalTitle}</DialogTitle>
              <DialogDescription className="sr-only">
                Adjust date, priority, and other settings for selected tasks
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0">{panelContent}</div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
