'use client'

/**
 * The lean row's LEFT CONTROL, in one place so a restyle is one file: the
 * done square — or, in selection mode, the selection checkbox in its spot
 * (the card row's rule, `TaskRow`). No consider circle: the lean row has no
 * consider.
 *
 * The square's hit area reaches past its 22px box (the segment rows' done
 * square, `TaskSegmentRow`): a thumb on a phone lands on it, not on the row.
 */
import { Check } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'

export function DoneControl({
  title,
  onDone,
  isSelectionMode,
  isSelected,
  onSelect,
}: {
  title: string
  onDone: () => void
  isSelectionMode: boolean
  isSelected: boolean
  onSelect?: () => void
}) {
  if (isSelectionMode) {
    return (
      <Checkbox
        checked={isSelected}
        onCheckedChange={() => onSelect?.()}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select "${title}"`}
        className="mt-px size-[22px] shrink-0"
      />
    )
  }
  return (
    <button
      type="button"
      data-no-row-press
      data-lean-done
      aria-label={`Done: "${title}"`}
      title="Done"
      onClick={(e) => {
        e.stopPropagation()
        onDone()
      }}
      className="group/done border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 relative mt-px flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-[1.5px] transition-colors after:absolute after:-inset-x-[4px] after:-inset-y-[11px] after:content-['']"
    >
      <Check
        className="size-3.5 opacity-0 transition-opacity group-hover/done:opacity-60"
        strokeWidth={3}
        aria-hidden
      />
    </button>
  )
}
