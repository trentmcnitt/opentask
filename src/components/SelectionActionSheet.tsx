'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Check, X, FileText, Trash2 } from 'lucide-react'
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
import { UnsavedChangesDialog } from '@/components/UnsavedChangesDialog'
import { QuickActionPanel, type QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import { formatTimeInTimezone } from '@/lib/format-date'
import { cn, taskWord } from '@/lib/utils'
import type { Task, Project } from '@/types'

interface SnoozeCategories {
  overdue: Task[]
  notYetDue: Task[] // relative snooze only (no target time to split on)
  dueBeforeTarget: Task[] // absolute: due between now and target (auto-included)
  dueAfterTarget: Task[] // absolute: due at or after target (opt-in checkbox)
  noDueDate: Task[]
}

/**
 * Partition tasks into categories for snooze confirmation.
 * Pre-filters only done tasks. P4/Urgent tasks ARE included — the server
 * respects explicit selections (via `include_task_ids`), and the user
 * deliberately picked these tasks, so hiding urgent ones from the confirmation
 * dialog would be misleading.
 *
 * For absolute snooze (targetTime provided), splits not-yet-due tasks into
 * "due before target" (auto-included — snooze pushes them later) and
 * "due after target" (opt-in — snooze would pull them earlier).
 * For relative snooze, all not-yet-due tasks go into notYetDue.
 */
function categorizeTasksForSnooze(tasks: Task[], targetTime?: string): SnoozeCategories {
  const now = new Date()
  const target = targetTime ? new Date(targetTime) : null
  const overdue: Task[] = []
  const notYetDue: Task[] = []
  const dueBeforeTarget: Task[] = []
  const dueAfterTarget: Task[] = []
  const noDueDate: Task[] = []

  for (const task of tasks) {
    if (task.done) continue
    if (!task.due_at) {
      noDueDate.push(task)
    } else if (new Date(task.due_at) < now) {
      overdue.push(task)
    } else if (target && new Date(task.due_at) >= target) {
      dueAfterTarget.push(task)
    } else if (target) {
      dueBeforeTarget.push(task)
    } else {
      notYetDue.push(task)
    }
  }

  return { overdue, notYetDue, dueBeforeTarget, dueAfterTarget, noDueDate }
}

interface SelectionActionSheetProps {
  selectedCount: number
  /** The actual selected tasks (for showing their due dates in QuickActionPanel) */
  selectedTasks: Task[]
  /** Complete selection (bulk done via the floating action bar) */
  onDone: () => void
  /** Delete the full selection (floating action bar + panel trash button) */
  onDelete: () => void
  /**
   * Persist a batch of changes from the QuickActionPanel.
   *
   * The shape matches `QuickActionPanelChanges` from the panel. For multi-task
   * selections, the panel emits additive label diffs and optional
   * `delta_minutes` for relative snoozes; for single-task selections, it emits
   * an absolute `due_at` and a full `labels` list. The parent is responsible
   * for routing this through `saveQuickPanelChanges` (or an equivalent shared
   * utility) and showing the success toast / bumping undo / refreshing tasks.
   *
   * `dateTaskIds`, when provided, scopes the date portion of the change to a
   * subset of the selection (used when the confirmation dialog opts some tasks
   * out of the snooze). Non-date fields always apply to every selected task.
   */
  onSaveAll: (changes: QuickActionPanelChanges, dateTaskIds?: number[]) => Promise<void> | void
  onMoveToProject?: () => void
  onClear: () => void
  /** Called when user wants to navigate to task detail (single task only) */
  onNavigateToDetail?: (taskId: number) => void
  /** Available projects for project picker (enables inline project selection) */
  projects?: Project[]
  /** Ref populated with openSheet function for external triggering (e.g., Cmd+S shortcut) */
  sheetOpenRef?: React.MutableRefObject<(() => void) | null>
}

export function SelectionActionSheet({
  selectedCount,
  selectedTasks,
  onDone,
  onDelete,
  onSaveAll,
  onMoveToProject,
  onClear,
  onNavigateToDetail,
  projects,
  sheetOpenRef,
}: SelectionActionSheetProps) {
  const timezone = useTimezone()
  const [sheetOpen, setSheetOpen] = useState(false)
  const isMobile = useIsMobile()

  // Staged changes from the most recent QuickActionPanel.onSaveAll call. The
  // panel collects and emits the full change set in a single callback; we hold
  // onto it here only long enough to run the multi-task snooze confirmation
  // dialog before forwarding to the parent.
  const pendingChangesRef = useRef<QuickActionPanelChanges | null>(null)

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
  const [includeDueAfterTarget, setIncludeDueAfterTarget] = useState(false)
  const [snoozeCategories, setSnoozeCategories] = useState<SnoozeCategories | null>(null)
  const [isAbsoluteSnooze, setIsAbsoluteSnooze] = useState(false)
  const [snoozeTargetTime, setSnoozeTargetTime] = useState<string | null>(null)

  const clearPendingState = useCallback(() => {
    pendingChangesRef.current = null
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

  // Execute save: forward the staged changes to the parent, close the sheet,
  // exit selection mode.
  //
  // `dateTaskIds` scopes the date portion of the change to a subset of the
  // selection — used when the confirmation dialog opts some tasks out of the
  // snooze. Non-date changes always apply to the full selection.
  const executeSave = useCallback(
    async (dateTaskIds?: number[]) => {
      const changes = pendingChangesRef.current
      pendingChangesRef.current = null
      setSheetOpen(false)
      onClear() // Exit selection mode
      if (!changes) return
      // If the user opted all tasks out of a date-only change, strip the date
      // fields and save the rest (if anything remains).
      const hasDateField = 'due_at' in changes || 'delta_minutes' in changes
      if (hasDateField && dateTaskIds && dateTaskIds.length === 0) {
        const { due_at: _d, delta_minutes: _dm, ...rest } = changes
        void _d
        void _dm
        if (Object.keys(rest).length > 0) {
          await onSaveAll(rest)
        }
        return
      }
      await onSaveAll(changes, dateTaskIds)
    },
    [onSaveAll, onClear],
  )

  // The QuickActionPanel collects and emits the full change set in a single
  // `onSaveAll` callback. For multi-task selections with edge-case tasks
  // (not-yet-due, no due date, due after target) we intercept and show a
  // confirmation dialog before forwarding.
  const handlePanelSaveAll = useCallback(
    async (changes: QuickActionPanelChanges) => {
      pendingChangesRef.current = changes

      const hasAbsoluteDate = changes.due_at !== undefined && changes.due_at !== null
      const hasRelativeDate = changes.delta_minutes !== undefined
      const hasDateChange = hasAbsoluteDate || hasRelativeDate

      // Single-task selections skip the dialog — there's no edge case to
      // confirm when there's only one task. The user's explicit tap on "+1h"
      // or a preset is unambiguous.
      if (!hasDateChange || selectedCount <= 1) {
        await executeSave()
        return
      }

      const isAbsolute = hasAbsoluteDate
      const targetTime = isAbsolute ? (changes.due_at ?? undefined) : undefined
      const categories = categorizeTasksForSnooze(selectedTasks, targetTime ?? undefined)

      const hasEdgeCase = isAbsolute
        ? categories.dueAfterTarget.length > 0 || categories.noDueDate.length > 0
        : categories.notYetDue.length > 0

      if (hasEdgeCase) {
        setSnoozeCategories(categories)
        setIsAbsoluteSnooze(isAbsolute)
        setSnoozeTargetTime(targetTime ?? null)
        setIncludeNoDueDate(false)
        setIncludeNotYetDue(false)
        setIncludeDueAfterTarget(false)
        return
      }

      await executeSave()
    },
    [selectedCount, selectedTasks, executeSave],
  )

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

  // Ref to the panel's internal handleSave, populated via QuickActionPanel.saveRef.
  // Used by the unsaved-changes "Save" button on the dismiss-confirmation dialog so
  // we can trigger the panel's save without duplicating its change-collection logic.
  const panelSaveRef = useRef<(() => Promise<void> | void) | null>(null)

  const handleSaveAndClose = useCallback(async () => {
    try {
      await panelSaveRef.current?.()
    } finally {
      setShowCloseConfirm(false)
    }
  }, [])

  // Snooze confirmation: compute filtered IDs from checkbox state and proceed with save.
  // Absolute: overdue + dueBeforeTarget are auto-included; dueAfterTarget and noDueDate are opt-in.
  // Relative: overdue are auto-included; notYetDue is opt-in.
  const handleSnoozeConfirm = useCallback(() => {
    const categories = snoozeCategories
    if (!categories) return

    const snoozeIds = categories.overdue.map((t) => t.id)
    if (isAbsoluteSnooze) {
      snoozeIds.push(...categories.dueBeforeTarget.map((t) => t.id))
      if (includeDueAfterTarget) {
        snoozeIds.push(...categories.dueAfterTarget.map((t) => t.id))
      }
    } else {
      if (includeNotYetDue) {
        snoozeIds.push(...categories.notYetDue.map((t) => t.id))
      }
    }
    if (includeNoDueDate) {
      snoozeIds.push(...categories.noDueDate.map((t) => t.id))
    }

    setSnoozeCategories(null)
    executeSave(snoozeIds)
  }, [
    snoozeCategories,
    isAbsoluteSnooze,
    includeNoDueDate,
    includeNotYetDue,
    includeDueAfterTarget,
    executeSave,
  ])

  const handleSnoozeCancelConfirm = useCallback(() => {
    setSnoozeCategories(null)
    pendingChangesRef.current = null
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
        onSaveAll={handlePanelSaveAll}
        onSave={() => {
          /* handlePanelSaveAll already closed the sheet (or opened the
             confirmation dialog); no further work needed here. */
        }}
        onCancel={handleCancel}
        saveRef={panelSaveRef}
        recurrenceSummary={recurrenceSummary}
        onDelete={handleDelete}
        onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
        onNavigateToDetail={
          selectedCount === 1 && onNavigateToDetail ? handleNavigateToDetail : undefined
        }
        projects={projects}
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
            size="sm"
            variant="secondary"
            onClick={handleDelete}
            aria-label={`Delete ${selectedCount} ${taskWord(selectedCount)}`}
          >
            <Trash2 className="size-4" />
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

      <UnsavedChangesDialog
        open={showCloseConfirm}
        onOpenChange={setShowCloseConfirm}
        onDiscard={handleDiscardAndClose}
        onSave={handleSaveAndClose}
      />

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
                (() => {
                  const autoCount = isAbsoluteSnooze
                    ? snoozeCategories.overdue.length + snoozeCategories.dueBeforeTarget.length
                    : snoozeCategories.overdue.length
                  return `${autoCount} ${taskWord(autoCount)} will be snoozed.`
                })()}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            {/* Absolute snooze: checkbox for tasks due after the target time */}
            {snoozeCategories && isAbsoluteSnooze && snoozeCategories.dueAfterTarget.length > 0 && (
              <label className="flex cursor-pointer items-center gap-3">
                <Checkbox
                  checked={includeDueAfterTarget}
                  onCheckedChange={(checked) => setIncludeDueAfterTarget(checked === true)}
                />
                <span className="text-sm">
                  Include {snoozeCategories.dueAfterTarget.length}{' '}
                  {taskWord(snoozeCategories.dueAfterTarget.length)} due after{' '}
                  {snoozeTargetTime && formatTimeInTimezone(snoozeTargetTime, timezone)}
                </span>
              </label>
            )}

            {/* Absolute snooze: checkbox for tasks with no due date */}
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

            {/* Relative snooze: checkbox for tasks not yet due */}
            {snoozeCategories && !isAbsoluteSnooze && snoozeCategories.notYetDue.length > 0 && (
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
                if (isAbsoluteSnooze) {
                  count += cats.dueBeforeTarget.length
                  if (includeDueAfterTarget) count += cats.dueAfterTarget.length
                } else {
                  if (includeNotYetDue) count += cats.notYetDue.length
                }
                if (includeNoDueDate) count += cats.noDueDate.length
                return `Apply to ${count} ${taskWord(count)}`
              })()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
