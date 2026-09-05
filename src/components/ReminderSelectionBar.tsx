'use client'

import { CheckCheck, FileText, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The floating action bar for a selection on the Reminders surface.
 *
 * Deliberately the same object as the dashboard's bar (`SelectionActionSheet`):
 * same position, same black pill, same button shapes — the user asked for the
 * reminders screen to behave like the dashboard, not like a second app. What
 * differs is the verb set. A reminder has no due date to move and no priority
 * ladder worth editing in bulk, and the server refuses to snooze one (RM-006),
 * so the task bar's Snooze / More would be dead or misleading here. What
 * remains: consider the selection, open a single item's details, move the
 * selection to Trash (Trent, 2026-09-05: "why doesn't it have a trash can?"),
 * clear.
 */
interface ReminderSelectionBarProps {
  selectedCount: number
  /** Mark every selected reminder as considered — one bulk call, one Undo. */
  onConsidered: () => void
  /** Open the selected item; only offered for a single selection. */
  onDetails?: () => void
  /** Move every selected reminder to Trash — a soft delete, one Undo. */
  onDelete: () => void
  onClear: () => void
}

export function ReminderSelectionBar({
  selectedCount,
  onConsidered,
  onDetails,
  onDelete,
  onClear,
}: ReminderSelectionBarProps) {
  if (selectedCount === 0) return null

  return (
    <div
      data-selection-sheet
      className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6"
    >
      <div
        className="bg-primary text-primary-foreground flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
        aria-live="polite"
      >
        {selectedCount > 1 && (
          <span className="mr-2 text-sm font-medium">{selectedCount} selected</span>
        )}

        <Button
          size="sm"
          variant="secondary"
          onClick={onConsidered}
          className="bg-green-600 text-white hover:bg-green-700 active:bg-green-700"
        >
          <CheckCheck className="mr-1 size-4" />
          Considered
        </Button>

        {selectedCount === 1 && onDetails && (
          <Button size="sm" variant="secondary" onClick={onDetails}>
            <FileText className="mr-1 size-4" />
            Details
          </Button>
        )}

        <Button
          size="sm"
          variant="secondary"
          onClick={onDelete}
          aria-label={selectedCount === 1 ? 'Move to Trash' : `Move ${selectedCount} to Trash`}
          className="bg-primary-foreground/10 text-primary-foreground hover:bg-destructive active:bg-destructive hover:text-white"
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
  )
}
