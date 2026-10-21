'use client'

import { Trash2 } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

/**
 * THE ROW PEEK BUBBLE: what a row is, in a bubble anchored to the row itself,
 * opened by holding the row — read-only, with Open (the full editor) and a
 * trash can. The shell both bubbles share: the dashboard panel's reminder rows
 * (`ReminderRowPopover`, 2026-09-21) and, since 2026-10-20, the task-segment
 * and queue rows (`TaskSegmentRow`'s peek, which replaced their pencil). One
 * shape, so the two can never drift apart: the title, a muted meta line, the
 * note (or the line saying there is none), then `PopoverFooter`.
 *
 * `PopoverAnchor` rather than `PopoverTrigger`: the row already owns this
 * pointer (a long press), and a trigger would fight that gesture for it.
 * It wraps the row (the row is its anchor), so the bubble is the row's
 * SIBLING in the React tree, never inside it: the content is portalled, but
 * React events still bubble through the tree, and a bubble inside the row
 * would hand Open's and the trash can's clicks to the row's own click.
 *
 * Deliberately NOT on hover. Trent, 2026-09-21: "if you hover for a while on
 * an item, it'll show the notes in a little popover. It might be a little
 * messy though. Let's not do that just yet."
 */
export function RowPeekPopover({
  open,
  onOpenChange,
  autoFocus = false,
  contentProps,
  content,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Move focus into the bubble on open — for one opened from the keyboard
   * (a task row's Cmd/Ctrl+Enter). A pointer-opened bubble must not take it:
   * see `onOpenAutoFocus` below.
   */
  autoFocus?: boolean
  /** Data attributes for the bubble (`data-reminder-popover`, `data-task-peek`). */
  contentProps?: Record<`data-${string}`, string | number>
  /** The bubble's body (`RowPeekBody`); null = nothing to show. */
  content: React.ReactNode
  /** The row this bubble points at. */
  children: React.ReactNode
}) {
  const shown = content !== null && content !== undefined && content !== false
  return (
    <Popover open={open && shown} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {shown && (
        <PopoverContent
          align="start"
          sideOffset={8}
          // Never wider than the phone it is on, and never wider than it needs.
          className="w-[min(20rem,calc(100vw-2rem))] p-0"
          {...contentProps}
          // The row owns the pointer that opened this. Without this, the long
          // press's own pointerup lands on the popover's outside-press handler
          // and closes it in the same gesture that opened it.
          onOpenAutoFocus={autoFocus ? undefined : (e) => e.preventDefault()}
        >
          {content}
        </PopoverContent>
      )}
    </Popover>
  )
}

/**
 * The bubble's body: title, meta line, note, Open + trash. The meta is the
 * caller's (a reminder's cadence and period; a task row's own meta line).
 *
 * NOTES ARE THE POINT (Trent, 2026-09-21: "I feel like there are some times
 * I'm going to want notes"): before the bubble the only way to read a note
 * was to open the full editor and close it again. It reads and does not
 * edit; Open is the way through, and this neither knows nor decides what
 * "open" means.
 */
export function RowPeekBody({
  title,
  meta,
  notes,
  onOpen,
  onDelete,
  deleteLabel,
}: {
  title: string
  meta: React.ReactNode
  notes: string | null | undefined
  onOpen: () => void
  onDelete: () => void
  deleteLabel: string
}) {
  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="text-sm leading-snug font-medium">{title}</p>
        {meta}
      </div>

      <div className="border-t pt-2.5">
        {notes ? (
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{notes}</p>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            No note yet — open it to say what this one is for.
          </p>
        )}
      </div>

      <PopoverFooter onOpen={onOpen} onDelete={onDelete} deleteLabel={deleteLabel} />
    </div>
  )
}

/**
 * Open plus a trash can, side by side.
 *
 * No confirmation dialog, deliberately. Trent, 2026-09-21, after testing what
 * tasks already do: "tasks do not have a confirmation but it does let you undo
 * it, which is good enough or probably better because it reduces friction."
 * Every delete behind this is a soft delete that raises an Undo toast, so the
 * cost of a mis-tap is one tap back, and the cost of a confirm dialog is a tap
 * on every single intentional delete.
 */
export function PopoverFooter({
  onOpen,
  onDelete,
  deleteLabel,
}: {
  onOpen: () => void
  onDelete: () => void
  deleteLabel: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" className="flex-1" onClick={onOpen}>
        Open
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDelete}
        aria-label={deleteLabel}
        title="Move to Trash"
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 px-2"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}
