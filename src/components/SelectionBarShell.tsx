'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

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
 * THE U1 BAR (Trent, 2026-10-30, "Set B" style): one dark panel — "N selected"
 * and Cancel on a line of their own, then the verbs in one row of equal
 * buttons, each an icon over its word (`BarAction`), like an iOS toolbar. It
 * replaced the white pill (count · Done · More · trash · a ✕ on the corner),
 * and is the same object on the dashboard's list, the task queue, Reminders
 * and Quotas. Cancel leaves the selection.
 *
 * `data-selection-sheet` is load-bearing beyond styling: the toast system
 * watches for it and lifts toasts clear of the bar, so a surface that hand-rolls
 * its own bar silently loses that.
 */
/**
 * WHETHER A SELECTION BAR IS UP, whichever surface's (the list's, the task
 * queue's, Reminders', Quotas'): the bars count themselves in while mounted,
 * and `useSelectionBarUp` reads it — the dashboard's floating buttons lift
 * above any of them (`DashboardFabStack`), not only the list's.
 */
let barsUp = 0
const barListeners = new Set<() => void>()
function setBarsUp(next: number) {
  barsUp = next
  for (const listener of barListeners) listener()
}
export function useSelectionBarUp(): boolean {
  return useSyncExternalStore(
    (listener) => {
      barListeners.add(listener)
      return () => barListeners.delete(listener)
    },
    () => barsUp > 0,
    () => false,
  )
}

export function SelectionBarShell({
  count,
  onClear,
  onDoubleClickIntent,
  testAttr,
  hint,
  more,
  title,
  detail,
  aside,
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
   * quotas"). Muted, inside the panel, so the bar stays one object. A verb it
   * explains points at it with `aria-describedby={SELECTION_BAR_HINT_ID}`.
   */
  hint?: string
  /**
   * The bar's "⋯" (More), up on the count's line beside Cancel (Trent,
   * 2026-10-30): out of the verbs' row, so the queue's seven verbs keep their
   * words at full size on a phone, and in the same place on every bar.
   */
  more?: ReactNode
  /**
   * ONE TASK PICKED (2026-10-30, `SelectionDetail.tsx`): its title in place
   * of "1 selected" (one line, truncated; "1 selected" stays for screen
   * readers), and `detail` — its meta line, notes, Open · Show in list —
   * under it, above the verbs.
   */
  title?: string
  detail?: ReactNode
  /** Beside ⋯ on the count's line: the horizon control with several picked. */
  aside?: ReactNode
  /** The surface's verbs (`BarAction`s), in one row. */
  children: ReactNode
}) {
  return count === 0 ? null : (
    <BarPanel
      count={count}
      onClear={onClear}
      onDoubleClickIntent={onDoubleClickIntent}
      testAttr={testAttr}
      hint={hint}
      more={more}
      title={title}
      detail={detail}
      aside={aside}
    >
      {children}
    </BarPanel>
  )
}

/**
 * ROOM FOR THE BAR (2026-10-30): the bar floats over the page, and once it
 * showed one task's details (title, meta, notes, links) it covered the last
 * rows of a short list — the row you meant to pick next was under it, out of
 * reach. While it is up, a spacer of its own height sits at the end of
 * <body>, so every row can scroll clear of it. Measured (a ResizeObserver
 * callback), so it follows the bar as it grows and shrinks.
 */
function useBarSpacer(ref: React.RefObject<HTMLDivElement | null>): ReactNode {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return height > 0 && typeof document !== 'undefined'
    ? createPortal(<div aria-hidden data-selection-bar-space style={{ height }} />, document.body)
    : null
}

/** The bar itself, counted in while it is mounted (`useSelectionBarUp`). */
function BarPanel({
  count,
  onClear,
  onDoubleClickIntent,
  testAttr,
  hint,
  more,
  title,
  detail,
  aside,
  children,
}: {
  count: number
  onClear: () => void
  onDoubleClickIntent?: () => void
  testAttr?: string
  hint?: string
  more?: ReactNode
  title?: string
  detail?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    setBarsUp(barsUp + 1)
    return () => setBarsUp(barsUp - 1)
  }, [])
  const attrs = testAttr ? { [testAttr]: '' } : {}
  const panelRef = useRef<HTMLDivElement>(null)
  const spacer = useBarSpacer(panelRef)

  return (
    <>
      {spacer}
      <div
        ref={panelRef}
        data-selection-sheet
        {...attrs}
        // A 16px margin each side on a phone (in px: a rem margin grew with the
        // text size and took the verbs' room), at most 28rem wide on a desktop.
        className="animate-slide-up fixed inset-x-0 bottom-20 z-50 mx-auto w-[min(28rem,calc(100vw-16px))] md:bottom-6"
        onClickCapture={(e) => {
          if (e.detail < 2) return
          e.preventDefault()
          e.stopPropagation()
          onDoubleClickIntent?.()
        }}
      >
        <div
          className="rounded-2xl border border-white/10 bg-neutral-900 px-1.5 pt-2.5 pb-1.5 text-white shadow-xl"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-2 pr-0.5 pl-2">
            {title ? (
              <span data-selection-title className="min-w-0 truncate text-sm font-semibold">
                <span data-selection-count className="sr-only">
                  {count} selected:{' '}
                </span>
                {title}
              </span>
            ) : (
              <span data-selection-count className="shrink-0 text-sm font-semibold tabular-nums">
                {count} selected
              </span>
            )}
            {/* The aside (the horizon control) gives way first: its word
                truncates before ⋯ or Cancel moves (a 375 phone at a 20px root). */}
            <div className={cn('flex items-center gap-1.5', title ? 'shrink-0' : 'min-w-0')}>
              {aside && <span className="flex min-w-0">{aside}</span>}
              <span className="flex shrink-0 items-center gap-1.5">{more}</span>
              <button
                type="button"
                onClick={onClear}
                aria-label="Cancel selection"
                data-selection-clear
                className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm transition-colors hover:bg-white/20 active:bg-white/20"
              >
                Cancel
              </button>
            </div>
          </div>
          {detail}
          <div data-selection-actions className="mt-1 flex items-stretch justify-between">
            {children}
          </div>
          {hint && (
            <p
              id={SELECTION_BAR_HINT_ID}
              data-selection-hint
              className="px-2 pt-0.5 text-xs text-white/60"
            >
              {hint}
            </p>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * One verb of the bar: its icon over its word (the U1 bar, 2026-10-30). Each
 * takes its word's width plus an equal share of what is left (`flex-auto`),
 * so the words sit evenly spaced and a longer one ("Not today", 50.6px at
 * 11px) never runs into its neighbour on a 375 phone — the queue's seven fit
 * at full size where equal shares (49px) cut it. `tone`: Done's green; a destructive verb is plain
 * until hovered (red), as before.
 */
export function BarAction({
  icon,
  label,
  onClick,
  tone,
  disabled = false,
  ariaLabel,
  describedBy,
  ...data
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  tone?: 'done' | 'danger'
  disabled?: boolean
  /** A fuller name than the word ("Move 3 to Trash"). */
  ariaLabel?: string
  describedBy?: string
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      {...data}
      className={cn(
        'flex flex-auto flex-col items-center gap-1 rounded-lg px-px pt-1.5 pb-1 text-[11px] leading-none whitespace-nowrap transition-colors',
        'hover:bg-white/10 active:bg-white/10 disabled:pointer-events-none disabled:opacity-35',
        tone === 'done' && 'text-green-400',
        tone === 'danger' && 'hover:text-red-400',
        '[&_svg]:size-5 [&_svg]:shrink-0',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
