'use client'

import { FileText, Trash2 } from 'lucide-react'
import { BarAction, SelectionBarShell } from '@/components/SelectionBarShell'

/**
 * The Quotas page's verbs inside the shared selection bar (2026-10-16, Trent:
 * "Of course we need a way to have multiple selections on the quotas screen.
 * It's not possible without that.").
 *
 * Position, count, Clear and the double-click guard all live in
 * `SelectionBarShell`, so this bar is the dashboard's and the Reminders bar by
 * construction; only the verbs are its own. Revived from the Details list's
 * bar that went with that list earlier the same day, minus the list:
 *
 * - Details: ONE quota opens its chip's bubble — the same bubble a hold opens
 *   on the dashboard, with its record, its reminder period, Open and the
 *   trash can — so "hold, then Details" reaches everything a dashboard hold
 *   does (Trent's own ruling for reminders, 2026-09-11: "tap and hold and then
 *   click Details with the item checked"). SEVERAL open the quota editor's
 *   multi-edit (`QuotaDetail`: label, period and interval, target, "Remind me
 *   daily" and its period), saved through `/api/tasks/bulk/edit` — one
 *   request, one Undo.
 * - Trash: every selected quota, through `/api/tasks/bulk/delete` — a soft
 *   delete, one Undo, no confirmation (undo beats confirm).
 */
export function QuotaSelectionBar({
  count,
  onDetails,
  onDelete,
  onClear,
}: {
  count: number
  onDetails: () => void
  onDelete: () => void
  onClear: () => void
}) {
  return (
    <SelectionBarShell
      count={count}
      onClear={onClear}
      onDoubleClickIntent={onDetails}
      testAttr="data-quota-selection-bar"
    >
      <BarAction icon={<FileText />} label="Details" onClick={onDetails} />
      <BarAction
        tone="danger"
        icon={<Trash2 />}
        label="Delete"
        onClick={onDelete}
        ariaLabel={count === 1 ? 'Move to Trash' : `Move ${count} quotas to Trash`}
      />
    </SelectionBarShell>
  )
}
