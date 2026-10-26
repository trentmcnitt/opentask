'use client'

import { Check, CheckCheck, ChevronLeft, ChevronRight, Forward } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The dashboard's two pager cards share these (2026-10-11): the Reminders card
 * (slots) and, beneath it, the Tasks card (task segments) — the same header,
 * sweep, row cap and "Show more", so the two read as one family.
 */

/**
 * How many rows a slot shows before "Show more" (Trent, 2026-09-21).
 *
 * ONE number per width, serving as both the cap and the threshold: at or under
 * it every row shows, past it you get exactly this many and a button. An
 * earlier cut tried two numbers — show all up to 13, then drop to 9 — and
 * Trent rejected it for the discontinuity that creates ("I don't like how it
 * jumps around"): a slot of 14 showed FEWER rows than a slot of 13. With one
 * number, adding a reminder never subtracts a visible row.
 *
 * Narrow gets the smaller cap because that is where the panel competes: it
 * sits inline above Track and the day, so 9 rows of thoughts put the first
 * task a full screen down (measured: 657px of panel, first task at 1.28
 * screens). Wide has its own column beside the day and costs it nothing —
 * so its cap went from 9 to 20 (Trent, 2026-09-28: "let's try to get rid of
 * the 'Show more' and 'Less' for the desktop version … show up to 20 items on
 * the desktop before it shows 'Show more'").
 */
export const WIDE_CAP = 20
export const NARROW_CAP = 5

/**
 * Prev chevron / page name + time (a task segment: its hint) / count /
 * (Considered all or Defer all, expanded only) / next chevron — one row, mirroring the widget's own `ChevronPager` header
 * except for the readout: the widget says "N left", this says the mockup's
 * "<considered> of <total>" so the number reads the same way the real
 * Reminders page's slot counter does (climbs, never counts down).
 */
export function SlotPagerHeader({
  label,
  accent,
  time,
  considered,
  total,
  expanded,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
  prevLabel = 'Previous time slot',
  nextLabel = 'Next time slot',
  sweep,
  onToggleExpanded,
  showConsidered,
  onToggleConsidered,
  emptyDone = false,
  doneAccent,
}: {
  label: string
  /** A colour for the label — a task segment's teal. */
  accent?: string
  /** The finished check's colour in place of green: the deadlines page's
   *  teal (`segmentDoneColor`). */
  doneAccent?: string
  time: string | null
  considered: number
  total: number
  expanded: boolean
  canGoPrev: boolean
  canGoNext: boolean
  onPrev: () => void
  onNext: () => void
  /** The chevrons' names: time slots, or task segments on the Tasks card. */
  prevLabel?: string
  nextLabel?: string
  /** "Considered all" on a slot, "Defer all" on a task segment (`PagerSweep`). */
  sweep: React.ReactNode
  /** Tapping the bar between the chevrons opens and shuts the slot. */
  onToggleExpanded: () => void
  showConsidered: boolean
  onToggleConsidered: () => void
  /**
   * An empty page is DONE (a task segment, Trent 2026-10-24: every segment
   * shows every day, an empty one finished from the start): "0 of 0 ✓".
   */
  emptyDone?: boolean
}) {
  // Same numbers the slot bar fills with — no parallel notion of "finished".
  // `total > 0` matters here: an empty slot reading "0 of 0" is not complete,
  // it's empty, and gets no check mark (no chrome for something that isn't
  // there). An empty task segment is the exception (`emptyDone`).
  const complete = total > 0 ? considered >= total : emptyDone
  const doneCheck = complete && (
    <Check
      data-done-check
      className={cn('size-3.5', !doneAccent && 'text-green-700 dark:text-green-400')}
      style={doneAccent ? { color: doneAccent } : undefined}
      strokeWidth={2.5}
      aria-hidden="true"
    />
  )
  return (
    <div className="flex min-h-11 items-center gap-1.5 px-2 py-1.5">
      <button
        type="button"
        onClick={onPrev}
        disabled={!canGoPrev}
        aria-label={prevLabel}
        title={prevLabel}
        className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronLeft className="size-4" strokeWidth={2} />
      </button>

      {/* The whole bar between the chevrons toggles the slot open and shut.
          Trent, 2026-09-21: "If you tap anywhere in there that's not on one of
          the carrots, it'd be nice if that expanded and collapsed the
          section." The chevrons page between slots and keep their own hit
          areas; everything between them is one target.

          It toggles even when no rows are held back, and that is deliberate:
          a slot under the cap has no "Show more" button at all, so before this
          there was no way to unclamp its titles or reach "Considered all". */}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        data-slot-header-toggle
        className="hover:bg-foreground/5 flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors"
      >
        {/* The name may wrap, never truncate: "TASK QUEUE · PREVIOUSLY
            STAGED" (2026-10-20) is wider than a phone's header and read
            "TASK QUEUE · PREVI…". A period's name and time fit as before. */}
        <span className="min-w-0 flex-1 text-xs text-balance">
          <span
            className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
            // A task segment's title wears its horizon's teal (2026-10-11).
            style={accent ? { color: accent } : undefined}
          >
            {label}
          </span>
          {/* A slot's start time (a task segment has none, only its title):
              ~#8a8a8a light, ~#8f8f8f dark (2026-10-11 visual QA; /50
              measured 1.9:1 and 2.9:1). */}
          {time && (
            <span className="text-muted-foreground/80 dark:text-muted-foreground/90 text-xs whitespace-nowrap">
              {' '}
              &middot; {time}
            </span>
          )}
        </span>
      </button>

      {/* The count IS the considered count, so tapping it is how you see what
          those were (Trent, 2026-09-21, choosing this over a second full-width
          bar in the footer: "Show Considered stacked on Show More looks like a
          big UX no-no"). A button only when there is something behind it —
          otherwise it is a plain readout and must not look pressable. */}
      {considered > 0 ? (
        <button
          type="button"
          onClick={onToggleConsidered}
          aria-expanded={showConsidered}
          data-considered-toggle
          aria-label={`${considered} of ${total} considered — show what was considered`}
          className={cn(
            'hover:bg-foreground/5 flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs whitespace-nowrap tabular-nums transition-colors',
            // THE BOX IS THE WHOLE SIGNAL. Trent, 2026-09-21: "when you
            // highlight it there's a little box around the text. When the
            // considered stuff is open there should still be a gray box
            // around the X of Y text." A bolding was tried alongside it and
            // cut the same day — "Don't bold the text... I like the box
            // around it though" — so the text never changes weight and the
            // held box says everything. It reuses the affordance the pointer
            // already reveals rather than adding a new one.
            showConsidered && 'bg-foreground/5',
          )}
        >
          {/* ONE COLOUR ACROSS THE WHOLE COUNT, AND NO WEIGHT CHANGE. The
              considered number sat a shade darker than "of N" for no reason
              anyone could name — Trent, 2026-09-21: "Why is 1 darker than the
              19?" It also briefly went bold while open, which he cut the same
              day: "Don't bold the text... I like the box around it though."
              So the box is the state and the text merely lifts out of muted. */}
          <span className={cn(showConsidered ? 'text-foreground' : 'text-muted-foreground')}>
            {considered} of {total}
          </span>
          {/* THE CHECK REPORTS STATUS, NOT AN AFFORDANCE — unlike the caret
              and the bolding cut from this same element (2026-09-21), this
              earns its place: it is the only thing on the panel that answers
              "is this slot actually finished?" without asking the reader to
              compare a fill's length to the end of its track. Small, quiet,
              and only ever present when true — never a greyed-out
              placeholder for "not yet". */}
          {doneCheck}
        </button>
      ) : (
        <span
          className="flex shrink-0 items-center gap-1 px-1.5 text-xs whitespace-nowrap tabular-nums"
          aria-label={`${considered} of ${total} considered`}
        >
          <span className="text-muted-foreground">
            {considered} of {total}
          </span>
          {doneCheck}
        </span>
      )}

      {sweep}

      <button
        type="button"
        onClick={onNext}
        disabled={!canGoNext}
        aria-label={nextLabel}
        title={nextLabel}
        className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronRight className="size-4" strokeWidth={2} />
      </button>
    </div>
  )
}

/**
 * "Show more (N more)" / "Show less" below the row list.
 *
 * Two counts, because the cap is per-width and the width is not known here
 * (see the block comment on `visible`). Both are rendered and a media query
 * picks one, so the number is right in the first paint. The button ITSELF is
 * hidden below nothing and above `xl` when the wide cap hides nothing — a slot
 * of 7 has two rows held back on a phone but is complete on a desktop, so
 * there is nothing to press for there.
 */
export function RowCountToggle({
  expanded,
  hiddenWhenNarrow,
  hiddenWhenWide,
  onToggle,
}: {
  expanded: boolean
  hiddenWhenNarrow: number
  hiddenWhenWide: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'text-muted-foreground hover:bg-foreground/5 hover:text-foreground w-full border-t px-3 py-2 text-center text-xs font-semibold transition-colors',
        !expanded && hiddenWhenWide <= 0 && 'xl:hidden',
      )}
    >
      {expanded ? (
        'Show less'
      ) : (
        <>
          <span className="xl:hidden">Show more ({hiddenWhenNarrow} more)</span>
          <span className="hidden xl:inline">
            Show more{hiddenWhenWide > 0 ? ` (${hiddenWhenWide} more)` : ''}
          </span>
        </>
      )}
    </button>
  )
}

/**
 * The header's sweep, in the place a slot has always had it: "Considered all"
 * on a slot, "Defer all" on a task segment (2026-10-11) — the segment's way to
 * clear today's list without considering each row. Only while the page is
 * expanded, like the slot's.
 */
export function PagerSweep({
  kind,
  ariaLabel,
  onClick,
}: {
  kind: 'consider' | 'defer'
  ariaLabel: string
  onClick: () => void
}) {
  const consider = kind === 'consider'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={consider ? undefined : "Take the rest off today's list; they come back tomorrow"}
      className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium transition-colors"
    >
      {consider ? (
        <CheckCheck className="size-3.5" strokeWidth={2.5} />
      ) : (
        <Forward className="size-3.5" strokeWidth={2.5} />
      )}
      <span className="hidden sm:inline">{consider ? 'Considered all' : 'Defer all'}</span>
    </button>
  )
}
