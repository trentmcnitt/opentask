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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import { computeCommonLabels } from '@/lib/bulk-utils'
import { URGENT_PRIORITY } from '@/lib/priority'
import { cn, taskWord } from '@/lib/utils'
import type { Task, Project } from '@/types'

interface SnoozeCategories {
  overdue: Task[]
  notYetDue: Task[]
  noDueDate: Task[]
}

/**
 * Partition tasks into categories for snooze confirmation.
 * Pre-filters done tasks and P4/urgent (server skips these anyway).
 */
function categorizeTasksForSnooze(tasks: Task[]): SnoozeCategories {
  const now = new Date()
  const overdue: Task[] = []
  const notYetDue: Task[] = []
  const noDueDate: Task[] = []

  for (const task of tasks) {
    if (task.done || (task.priority ?? 0) >= URGENT_PRIORITY) continue
    if (!task.due_at) {
      noDueDate.push(task)
    } else if (new Date(task.due_at) >= now) {
      notYetDue.push(task)
    } else {
      overdue.push(task)
    }
  }

  return { overdue, notYetDue, noDueDate }
}

interface SelectionActionSheetProps {
  selectedCount: number
  /** The actual selected tasks (for showing their due dates in QuickActionPanel) */
  selectedTasks: Task[]
  onDone: () => void
  /** Called with absolute UTC time for preset operations. Optional taskIds filters which tasks are affected. */
  onSnooze: (until: string, taskIds?: number[]) => void
  /** Called with delta minutes for increment operations. Optional taskIds filters which tasks are affected. */
  onSnoozeRelative: (deltaMinutes: number, taskIds?: number[]) => void
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

  // Track dirty state from QuickActionPanel for visual indicator and dismiss protection
  const [isPanelDirty, setIsPanelDirty] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  // Snooze confirmation dialog state.
  // Dialog is open when snoozeCategories is non-null (no separate boolean needed).
  // isAbsoluteSnooze is stored separately so we don't read pendingDateRef during render.
  const [includeNoDueDate, setIncludeNoDueDate] = useState(false)
  const [includeNotYetDue, setIncludeNotYetDue] = useState(false)
  const [snoozeCategories, setSnoozeCategories] = useState<SnoozeCategories | null>(null)
  const [isAbsoluteSnooze, setIsAbsoluteSnooze] = useState(false)

  const clearPendingState = useCallback(() => {
    pendingDateRef.current = null
    pendingPriorityRef.current = null
    pendingLabelsAddRef.current = []
    pendingLabelsRemoveRef.current = []
    pendingProjectRef.current = null
  }, [])

  const openSheet = useCallback(() => {
    clearPendingState()
    setShowCloseConfirm(false)
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

  // Execute save: apply pending changes, close, exit selection mode.
  // snoozeTaskIds optionally filters which tasks the date operation affects.
  // Non-date changes (priority, labels, project) always apply to ALL selected tasks.
  const executeSave = useCallback(
    (snoozeTaskIds?: number[]) => {
      if (pendingDateRef.current) {
        // Skip the snooze call if filtering left no tasks
        if (!snoozeTaskIds || snoozeTaskIds.length > 0) {
          if (pendingDateRef.current.type === 'absolute') {
            onSnooze(pendingDateRef.current.until, snoozeTaskIds)
          } else {
            onSnoozeRelative(pendingDateRef.current.deltaMinutes, snoozeTaskIds)
          }
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
    },
    [
      onSnooze,
      onSnoozeRelative,
      onClear,
      onPriorityChange,
      onLabelsAdd,
      onLabelsRemove,
      onProjectChange,
    ],
  )

  // Save button: check for edge-case tasks before applying date changes.
  // If the selection includes tasks with no due date (absolute mode) or tasks not yet due,
  // show a confirmation dialog so the user can choose whether to include them.
  const handleSave = useCallback(() => {
    if (pendingDateRef.current) {
      const isAbsolute = pendingDateRef.current.type === 'absolute'
      const categories = categorizeTasksForSnooze(selectedTasks)

      const hasNoDueDateEdgeCase = isAbsolute && categories.noDueDate.length > 0
      const hasNotYetDueEdgeCase = categories.notYetDue.length > 0

      if (hasNoDueDateEdgeCase || hasNotYetDueEdgeCase) {
        setSnoozeCategories(categories)
        setIsAbsoluteSnooze(isAbsolute)
        setIncludeNoDueDate(false)
        setIncludeNotYetDue(false)
        return
      }
    }

    executeSave()
  }, [selectedTasks, executeSave])

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

  // On dismiss without explicit save/cancel: intercept when dirty to show confirmation
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && isPanelDirty) {
        setShowCloseConfirm(true)
      } else {
        if (!open) clearPendingState()
        setSheetOpen(open)
      }
    },
    [clearPendingState, isPanelDirty],
  )

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    clearPendingState()
    setSheetOpen(false)
    // Keep selection mode active (matches Cancel behavior)
  }, [clearPendingState])

  const handleSaveAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    handleSave()
  }, [handleSave])

  // Snooze confirmation: compute filtered IDs from checkbox state and proceed with save
  const handleSnoozeConfirm = useCallback(() => {
    const categories = snoozeCategories
    if (!categories) return

    const snoozeIds = categories.overdue.map((t) => t.id)
    if (includeNoDueDate) {
      snoozeIds.push(...categories.noDueDate.map((t) => t.id))
    }
    if (includeNotYetDue) {
      snoozeIds.push(...categories.notYetDue.map((t) => t.id))
    }

    setSnoozeCategories(null)
    executeSave(snoozeIds)
  }, [snoozeCategories, includeNoDueDate, includeNotYetDue, executeSave])

  const handleSnoozeCancelConfirm = useCallback(() => {
    setSnoozeCategories(null)
  }, [])

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
          <SheetContent
            side="bottom"
            className="rounded-t-2xl"
            showCloseButton
            draggable={!isPanelDirty}
          >
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

      <AlertDialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. What would you like to do?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="outline" onClick={handleDiscardAndClose}>
              Don&apos;t Save
            </AlertDialogAction>
            <AlertDialogAction onClick={handleSaveAndClose}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={snoozeCategories !== null}
        onOpenChange={(open) => {
          if (!open) setSnoozeCategories(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm date change</AlertDialogTitle>
            <AlertDialogDescription>
              {snoozeCategories &&
                `${snoozeCategories.overdue.length} ${taskWord(snoozeCategories.overdue.length)} will be snoozed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            {snoozeCategories && isAbsoluteSnooze && snoozeCategories.noDueDate.length > 0 && (
              <label className="flex cursor-pointer items-center gap-3">
                <Checkbox
                  checked={includeNoDueDate}
                  onCheckedChange={(checked) => setIncludeNoDueDate(checked === true)}
                />
                <span className="text-sm">
                  Include {snoozeCategories.noDueDate.length}{' '}
                  {taskWord(snoozeCategories.noDueDate.length)} with no due date
                </span>
              </label>
            )}

            {snoozeCategories && snoozeCategories.notYetDue.length > 0 && (
              <label className="flex cursor-pointer items-center gap-3">
                <Checkbox
                  checked={includeNotYetDue}
                  onCheckedChange={(checked) => setIncludeNotYetDue(checked === true)}
                />
                <span className="text-sm">
                  Include {snoozeCategories.notYetDue.length}{' '}
                  {taskWord(snoozeCategories.notYetDue.length)} not yet due
                </span>
              </label>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleSnoozeCancelConfirm}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSnoozeConfirm}>
              {(() => {
                const cats = snoozeCategories
                if (!cats) return 'Apply'
                let count = cats.overdue.length
                if (includeNoDueDate) count += cats.noDueDate.length
                if (includeNotYetDue) count += cats.notYetDue.length
                return `Apply to ${count} ${taskWord(count)}`
              })()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
