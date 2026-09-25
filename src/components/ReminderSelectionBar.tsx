'use client'

import { CheckCheck, FileText, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SELECTION_BAR_HINT_ID, SelectionBarShell } from '@/components/SelectionBarShell'

/**
 * The floating action bar for a selection on the Reminders surface.
 *
 * Deliberately the same object as the dashboard's bar (`SelectionActionSheet`):
 * same position, same black pill, same button shapes — the user asked for the
 * reminders screen to behave like the dashboard, not like a second app. What
 * differs is the verb set. A reminder has no due date to move and no priority
 * ladder worth editing in bulk, and the server refuses to snooze one (RM-006),
 * so the task bar's Snooze / More would be dead or misleading here. What
 * remains: consider the selection, open its details (one reminder's editor,
 * or several reminders' schedule edited together — Trent, 2026-09-05: "we
 * need that"), move the selection to Trash ("why doesn't it have a trash
 * can?"), clear.
 *
 * QUOTA PROMPTS in the selection (2026-09-25). A prompt is a quota's row, not
 * a reminder, so the verbs narrow to what is safe for it:
 * - Considered covers everything selected, prompts as "considered" (never +1).
 * - Details opens ONE kind of editor: the reminders' when only reminders are
 *   selected, the quota editor (deduped to the quotas behind the prompts) when
 *   only prompts are. A mix has no single editor, so Details is disabled and
 *   the bar says why, in one line.
 * - Trash is not offered at all while any prompt is selected: a prompt row
 *   must never be the way a quota gets deleted, and a bin that only half
 *   applies is worse than none. The quota editor keeps its own Delete.
 */
interface ReminderSelectionBarProps {
  selectedCount: number
  /** How many of the selection are reminders, and how many quota prompts. */
  reminderCount: number
  promptCount: number
  /** Mark everything selected as considered — one bulk call, one Undo. */
  onConsidered: () => void
  /** Open the selection's details — reminders' editor, or the prompts' quotas. */
  onDetails: () => void
  /** Move every selected reminder to Trash — a soft delete, one Undo. */
  onDelete: () => void
  onClear: () => void
}

/** Why Details is off for a mixed selection — the bar's hint line. */
export const MIXED_DETAILS_HINT = 'Details: pick only reminders or only quotas'

export function ReminderSelectionBar({
  selectedCount,
  reminderCount,
  promptCount,
  onConsidered,
  onDetails,
  onDelete,
  onClear,
}: ReminderSelectionBarProps) {
  const mixed = reminderCount > 0 && promptCount > 0
  const canDetails = !mixed && reminderCount + promptCount > 0
  return (
    <SelectionBarShell
      count={selectedCount}
      onClear={onClear}
      onDoubleClickIntent={canDetails ? onDetails : undefined}
      hint={mixed ? MIXED_DETAILS_HINT : undefined}
    >
      <Button
        size="sm"
        variant="secondary"
        onClick={onConsidered}
        className="bg-green-600 text-white hover:bg-green-700 active:bg-green-700"
      >
        <CheckCheck className="mr-1 size-4" />
        Considered
      </Button>

      <Button
        size="sm"
        variant="secondary"
        onClick={onDetails}
        disabled={!canDetails}
        aria-describedby={mixed ? SELECTION_BAR_HINT_ID : undefined}
      >
        <FileText className="mr-1 size-4" />
        Details
      </Button>

      {promptCount === 0 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={onDelete}
          aria-label={selectedCount === 1 ? 'Move to Trash' : `Move ${selectedCount} to Trash`}
          className="bg-primary-foreground/10 text-primary-foreground hover:bg-destructive active:bg-destructive hover:text-white"
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </SelectionBarShell>
  )
}
