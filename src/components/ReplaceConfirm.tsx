'use client'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

/**
 * THE REPLACE WARNING (the deadlines page, 2026-10-22, plan §5 web): a task
 * carries a picked target OR a deck, never both (rule 1) — so On deck on a
 * targeted row drops its target, and Today on a decked row takes it off
 * deck. Those buttons are drawn FADED, and a tap asks first, in a small
 * popover at the button: "Replaces target Fri 6 PM" — [Deck] [Cancel]. (The
 * app's rule elsewhere is Undo over confirm; this one is the approved plan's,
 * because the faded button's job is to say what will be lost.)
 *
 * Controlled: the caller holds what is pending (`open`) and acts on
 * `onConfirm`. The trigger is rendered as-is inside an anchoring span — the
 * caller's own tap/hold keeps working. Callers wrap only a FADED button, so
 * the ordinary rows' layout never changes. Clicks and keys inside are stopped,
 * so they never reach the row (whose click considers or opens it).
 */
export function ReplaceConfirm({
  open,
  onOpenChange,
  message,
  confirmLabel,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Replaces target Fri 6 PM", "Replaces On deck Sat". */
  message: string
  /** "Deck", "Today". */
  confirmLabel: string
  onConfirm: () => void
  children: React.ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex shrink-0">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-auto max-w-[16rem] p-3"
        data-replace-confirm
        // Never the row's press (the dashboard row's long-press selection
        // skips it). Its pointerdown is NOT stopped: the dashboard row's swipe
        // swallows a click whose pointerdown it never saw (`TargetTimeText`).
        data-no-row-press
        role="alertdialog"
        aria-label={message}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <p className="text-sm">{message}</p>
        <div className="mt-2.5 flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-replace-cancel
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-replace-ok
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
