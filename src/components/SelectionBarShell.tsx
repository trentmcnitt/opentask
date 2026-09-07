'use client'

import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The floating bar that appears while rows are selected, on every surface that
 * has a selection.
 *
 * Position, the black pill, the count, Clear, and the double-click guard are
 * the same object everywhere by construction — the dashboard's bar is the
 * original and the others are meant to BE it, not to resemble it (Trent,
 * 2026-09-06: "why are we deviating from the other panels?"). Reminders and
 * Quotas had each rebuilt it, and had already drifted apart in small ways
 * nobody chose: one right-margined its count and the other made it tabular,
 * one nudged Clear by 4px more than the other. Only the verbs differ, and the
 * verbs are what `children` is for.
 *
 * `data-selection-sheet` is load-bearing beyond styling: the toast system
 * watches for it and lifts toasts clear of the bar, so a surface that hand-rolls
 * its own bar silently loses that.
 */
export function SelectionBarShell({
  count,
  onClear,
  onDoubleClickIntent,
  testAttr,
  children,
}: {
  count: number
  onClear: () => void
  /**
   * What a double-click landing on the bar should finish — normally "open the
   * details". A double-click on a row near the bottom selects with the first
   * click, which summons this bar OVER the row, so the second click lands here.
   * The browser still counts it as the second click of one gesture, so it must
   * not press whichever button it fell on (on Reminders that was the green
   * "Considered") — it completes what the user meant instead.
   */
  onDoubleClickIntent?: () => void
  /** Marks a specific surface's bar for tests, e.g. `data-quota-selection-bar`. */
  testAttr?: string
  /** The surface's verbs. Clear is supplied here and always sits last. */
  children: ReactNode
}) {
  if (count === 0) return null

  const attrs = testAttr ? { [testAttr]: '' } : {}

  return (
    <div
      data-selection-sheet
      {...attrs}
      className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6"
      onClickCapture={(e) => {
        if (e.detail < 2) return
        e.preventDefault()
        e.stopPropagation()
        onDoubleClickIntent?.()
      }}
    >
      <div
        className="bg-primary text-primary-foreground flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
        aria-live="polite"
      >
        {count > 1 && (
          <span className="mr-1 text-sm font-medium tabular-nums">{count} selected</span>
        )}

        {children}

        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          aria-label="Clear selection"
          className="text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10 active:bg-primary-foreground/10 ml-1"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
