'use client'

import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/** The hint line's id, for the `aria-describedby` of the verb it explains. */
export const SELECTION_BAR_HINT_ID = 'selection-bar-hint'

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
 * verbs are what `children` is for. The dashboard's own bar
 * (`SelectionActionSheet`) moved onto this shell too, so it gained the
 * double-click guard and took the shell's spacing (a 4px count margin and
 * Clear gap, where it had 8px).
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
  hint,
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
  /**
   * One short line under the verbs, saying why one of them is unavailable for
   * this selection (e.g. Reminders' "Details: pick only reminders or only
   * quotas"). Muted, inside the pill, so the bar stays one object. A verb it
   * explains points at it with `aria-describedby={SELECTION_BAR_HINT_ID}`.
   */
  hint?: string
  /** The surface's verbs. Clear is supplied here and always sits last. */
  children: ReactNode
}) {
  if (count === 0) return null

  const attrs = testAttr ? { [testAttr]: '' } : {}

  return (
    <div
      data-selection-sheet
      {...attrs}
      className="animate-slide-up fixed inset-x-0 bottom-20 z-50 mx-auto w-fit max-w-[calc(100vw-32px)] md:bottom-6"
      onClickCapture={(e) => {
        if (e.detail < 2) return
        e.preventDefault()
        e.stopPropagation()
        onDoubleClickIntent?.()
      }}
    >
      <div
        className="bg-primary text-primary-foreground relative rounded-xl px-2 py-3 shadow-xl sm:px-4"
        aria-live="polite"
      >
        {/* Wraps rather than overflowing: the bar is capped at the screen's
            width, and a verb pushed past it was cut off with Clear out of
            reach (iPhone at a larger text size, 2026-10-14). Centred with
            `inset-x-0 mx-auto w-fit`, not `left-1/2 -translate-x-1/2`: a
            fixed box at `left: 50%` may only grow to half the screen, so a
            row allowed to wrap would wrap at half width.
            CLEAR SITS ON THE CORNER (2026-10-26), out of the row: as the last
            item of a wrapping row it was the one that fell to a line of its
            own — an X alone under "Considered · Details · trash" on Trent's
            phone at 119% text, a whole extra row of bar for one small button.
            On the pill's top-right corner it costs the verbs no width at all,
            so at that size the three fit on one line, and when a screen is too
            narrow even for them, only a verb wraps and Clear stays put. Its
            hit area is larger than the disc (the `after:` inset).
            TIGHTER ON A PHONE (2026-10-26): `px-2 gap-1.5` below `sm`. At a
            375 screen and the app's 119% text, "3 selected · Done · More ·
            trash" was 11px too wide for one row (Reminders' "Considered ·
            Details · trash" 3px), so the trash fell to a row of its own; the
            tighter padding gives back ~16px. The bar's cap keeps a 16px
            margin in px, not 1rem: a rem margin grew with the text too (19px
            a side at 119%) and took 6px of that back, leaving the dashboard's
            verbs half a pixel short of one row. */}
        <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          {count > 1 && (
            <span className="mr-1 text-sm font-medium tabular-nums">{count} selected</span>
          )}

          {children}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          aria-label="Clear selection"
          data-selection-clear
          className="bg-primary text-primary-foreground/70 hover:bg-primary hover:text-primary-foreground active:bg-primary ring-background absolute -top-2.5 -right-2.5 size-7 rounded-full shadow-md ring-2 after:absolute after:-inset-2 after:content-['']"
        >
          <X className="size-3.5" />
        </Button>
        {hint && (
          <p
            id={SELECTION_BAR_HINT_ID}
            data-selection-hint
            className="text-primary-foreground/60 mt-1.5 text-xs"
          >
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}
