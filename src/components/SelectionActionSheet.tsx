'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Check, FileText, Trash2 } from 'lucide-react'
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
import { useEditorHost } from '@/hooks/useEditorHost'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import { formatTimeInTimezone } from '@/lib/format-date'
import { taskWord } from '@/lib/utils'
import { DirtyCard } from '@/components/DirtyCard'
import { SelectionBarShell } from '@/components/SelectionBarShell'
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
 * Pre-filters only done tasks. P3/P4 (High/Urgent) tasks ARE included — the
 * server respects explicit selections (via `include_task_ids`), and the user
 * deliberately picked these tasks, so hiding high/urgent ones from the
 * confirmation dialog would be misleading.
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
   *
   * Rejects (after reporting the failure) when the save fails: the sheet then
   * stays open with the staged edits and the selection is kept.
   */
  onSaveAll: (changes: QuickActionPanelChanges, dateTaskIds?: number[]) => Promise<void>
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

  // Dirty state from QuickActionPanel: `isDirty` paints the stripe and locks
  // the sheet's drag; the dismiss guard reads `dirtyRef`, which is current the
  // moment the panel reports (see useEditorHost for why state is not enough).
  // `saveRef`/`commit` let the unsaved-changes dialog's Save run the panel's
  // own save without duplicating its change-collection logic.
  const {
    isDirty: isPanelDirty,
    dirtyRef,
    onDirtyChange,
    saveRef: panelSaveRef,
    commit,
  } = useEditorHost()
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

  // Execute save: forward the staged changes to the parent, then close the
  // sheet and exit selection mode.
  //
  // The close and clear wait for the save: a save the parent refuses rejects
  // (the parent has already toasted the reason), which leaves the sheet open,
  // the selection intact and — on the panel's own Save — the staged edits in
  // place for a retry. Closing first used to drop all three on a failure.
  //
  // `dateTaskIds` scopes the date portion of the change to a subset of the
  // selection — used when the confirmation dialog opts some tasks out of the
  // snooze. Non-date changes always apply to the full selection.
  const executeSave = useCallback(
    async (dateTaskIds?: number[]) => {
      const changes = pendingChangesRef.current
      pendingChangesRef.current = null
      if (changes) {
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
        } else {
          await onSaveAll(changes, dateTaskIds)
        }
      }
      setSheetOpen(false)
      onClear() // Exit selection mode
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

  // On dismiss without explicit save/cancel: intercept when dirty to show confirmation
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && dirtyRef.current) {
        setShowCloseConfirm(true)
      } else {
        if (!open) clearPendingState()
        setSheetOpen(open)
      }
    },
    [clearPendingState, dirtyRef],
  )

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false)
    clearPendingState()
    setSheetOpen(false)
    // Keep selection mode active (matches Cancel behavior)
  }, [clearPendingState])

  // The unsaved-changes dialog's Save runs the panel's save (published through
  // `panelSaveRef`). It does not reject: a failed save keeps the sheet open
  // with its edits, and either way the confirmation closes.
  const handleSaveAndClose = useCallback(async () => {
    await commit()
    setShowCloseConfirm(false)
  }, [commit])

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
    // The panel already handed its changes over (and reset) before this dialog
    // opened; a failure here is toasted by the parent, and the sheet and
    // selection stay so the user can try again.
    executeSave(snoozeIds).catch(() => {})
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

  // Details (the bar's button, the panel's link, a double-click on the bar)
  // exists only for a single selection.
  const openDetails = selectedCount === 1 && onNavigateToDetail ? handleNavigateToDetail : undefined

  // Modal title: show task title for single task, count for multiple
  const modalTitle =
    selectedCount === 1 && selectedTasks[0]
      ? selectedTasks[0].title
      : `${selectedCount} tasks selected`

  const panelContent = (
    <DirtyCard dirty={isPanelDirty} className="space-y-3">
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
        onNavigateToDetail={openDetails}
        projects={projects}
        onDirtyChange={onDirtyChange}
      />
    </DirtyCard>
  )

  return (
    <>
      {/* The floating action bar. The shell owns the pill, the count, Clear and
          the double-click guard, the same object as Reminders' and Quotas' bars
          (it was a hand copy of it). A double-click that lands on the bar — the
          second click of a double-click on a row near the bottom, whose first
          click summoned the bar over it — opens Details when one task is
          selected, instead of pressing whichever verb it hit. */}
      <SelectionBarShell count={selectedCount} onClear={onClear} onDoubleClickIntent={openDetails}>
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
        {openDetails && (
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
      </SelectionBarShell>

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
              {/* `pr-6` keeps a long title's ellipsis clear of the close (X) button. */}
              <DialogTitle className="truncate pr-6">{modalTitle}</DialogTitle>
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
