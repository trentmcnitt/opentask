'use client'

import { useState } from 'react'
import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackedItems } from '@/lib/slot-view'
import { periodSuffix, trackStream, type TrackStreamItem } from '@/lib/track'
import { LABEL_COLORS } from '@/lib/label-colors'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useLongPress } from '@/hooks/useLongPress'
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe'
import { TrackChipPopover } from '@/components/TrackChipPopover'
import { GuardedLink } from '@/components/GuardedLink'
import { useLabelConfig, useTrackPanelPreference } from '@/components/PreferencesProvider'
import type { LabelColor, Task } from '@/types'

/**
 * Track (REDESIGN-V03 §5): the quotas' home on the Tasks page.
 *
 * Trent, on the first cut (quotas as full task rows at the top of "Anytime
 * today"): "the alignment is all weird and the things just look sloppy…
 * wherever they go, it can't be buried on the Tasks page." So the quotas are
 * an instrument panel above the day, not rows inside it:
 *
 * - One line per quota, every line the same shape: title · bar · count · − · +1.
 *   The control cluster has fixed widths and sits flush right, so the lines
 *   align as one object. No circle, no AI commentary, no recurrence glyph —
 *   none of that is what a counter is about.
 * - The panel is a plain group header ("TRACK") over ONE card. Two states,
 *   remembered as a user preference like the filter section. FOLDED (the
 *   default) the card holds its quotas as tight CHIPS with their full titles,
 *   wrapping wherever the width runs out (Trent, 2026-09-05: eight open rows
 *   pushed the first task of the day below the fold on his phone; a folded
 *   one-liner hid the quotas; chips with truncated titles were rejected, so
 *   nothing here is ever cut). Tap a chip: +1. Hold it, or shift-click: −1.
 *   The chip's background fills as the count climbs and turns green at the
 *   target, so each chip is its own bar. OPEN, it is the full rows.
 * - Order is by label then title, and never changes on a tap — the widget's
 *   "order jumps under your finger" complaint applied verbatim here.
 * - "Met" is a state, not an exit: green check, count keeps going (3/2).
 *
 * GROUPED BY LABEL, AS ONE STREAM (Trent, 2026-09-09, picking variation G of
 * the `track-by-label` mockup, with D's stripe). It used to be one card per
 * period — DAY / WEEK / MONTH, each with a summed progress bar. The label is
 * the question a quota answers to ("there's a bunch of stuff for the kids and
 * there are other things"), and the period is answered by two letters on the
 * chip, so:
 *
 * - ONE card, holding ONE wrapping row. A cluster opens with its label in the
 *   panel's own small uppercase run, which is a plain flex item: it attaches
 *   after the previous cluster's last chip and wraps with everything else, so
 *   it can never force a line break. That is what makes this the shortest of
 *   the seven layouts drawn — 656px at 375px wide against the runner-up's 773.
 * - NO summed bar. A bar across a group that mixes days, weeks and months is
 *   "2 a day + 3 a week + 1 a month = 7", a number nobody can act on. The
 *   Quotas page dropped it for the same reason when it moved to labels.
 * - The period lives on the chip instead, as a muted suffix: 0/2·d, 0/3·wk.
 * - A 3px stripe down the chip's left edge in the label's colour, and the same
 *   colour as a dot on the title (variation D). The chip's radius drops from a
 *   full pill to 10px so the stripe reads as a stripe rather than a crescent.
 *   Colour comes from `label_config`, the same place every other label colour
 *   in the app comes from; a label nobody has coloured, and the unlabelled
 *   cluster, get a neutral one rather than a palette invented in code. Green is
 *   reserved for "met" and is not spent on a label here.
 *
 * OPEN, the same clusters in the same order become headings over the full
 * rows. Not drawn in the mockup — that was about the folded state, which is how
 * the panel ships — but the alternative was for the grouping to vanish the
 * moment the panel is expanded, and for the rows to be a flat list of 19 with
 * no organising idea at all. The stripe stays on the chips only: a row already
 * carries its own bar down that side of the panel.
 *
 * This panel and the Quotas page are the ONLY places a quota appears (Trent,
 * 2026-09-08: "a quota is not a task"). It used to be a plain row in the All
 * and Projects lists too, wearing a "0 / 4" chip and no controls; the
 * dashboard now filters tracked rows out of every list, which is why this
 * panel is handed the unfiltered corpus rather than the list's own array.
 */
export function TrackPanel({ tasks }: { tasks: Task[] }) {
  const { trackExpanded: open, setTrackExpanded: setOpen } = useTrackPanelPreference()
  const { labelConfig } = useLabelConfig()
  // The quota whose detail sheet is showing. Held by id rather than by object
  // so a sync refresh replaces the rendered task underneath an open sheet.
  const [detailId, setDetailId] = useState<number | null>(null)
  const quotas = trackedItems(tasks)
  const items = trackStream(quotas, labelConfig)
  if (quotas.length === 0) return null

  return (
    <section aria-label="Track" data-track-panel className="mb-6">
      {/* A plain group header, built exactly like "Early morning" below —
          same padding, chevron size and negative margin — so the carets and
          labels line up. The caret switches the card between chips and the
          full rows. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Collapse Track' : 'Expand Track'}
        className="hover:text-foreground mb-2 flex min-h-7 w-full items-center gap-2 px-1 text-left transition-colors"
      >
        <span className="-mr-1.5 flex items-center justify-center p-0.5">
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
              !open && '-rotate-90',
            )}
          />
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Track
        </span>
      </button>

      <div className="bg-muted/30 rounded-2xl p-2">
        {open ? (
          <ul aria-label="Quotas">
            {items.map((item) =>
              item.kind === 'title' ? (
                <ClusterTitle
                  key={`title-${item.label ?? 'unlabelled'}`}
                  item={item}
                  className="flex items-center gap-1.5 px-2 pt-3 pb-1 first:pt-1"
                />
              ) : (
                <TrackRow key={item.task.id} task={item.task} />
              ),
            )}
          </ul>
        ) : (
          // One wrapping row for the whole panel: titles and chips are peers in
          // it, which is the entire trick — see the block comment above.
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Quotas">
            {items.map((item) =>
              item.kind === 'title' ? (
                <ClusterTitle
                  key={`title-${item.label ?? 'unlabelled'}`}
                  item={item}
                  className="ml-2 flex items-center gap-1.5 whitespace-nowrap first:ml-0"
                />
              ) : (
                <TrackChip
                  key={item.task.id}
                  task={item.task}
                  color={item.color}
                  detailOpen={detailId === item.task.id}
                  onOpenDetail={(t) => setDetailId(t.id)}
                  onCloseDetail={() => setDetailId(null)}
                />
              ),
            )}
          </ul>
        )}
      </div>
    </section>
  )
}

/** A label with no colour configured, and the unlabelled cluster, get this. */
const NEUTRAL = 'bg-muted-foreground/60'

/** The flat colour a stripe or a swatch is painted in. */
function colorClass(color: LabelColor | null): string {
  return color ? LABEL_COLORS[color].dot : NEUTRAL
}

/**
 * A cluster's heading. `whitespace-nowrap` on the whole run, so "job-hunt"
 * never breaks at its hyphen when it lands at the end of a line.
 */
function ClusterTitle({
  item,
  className,
}: {
  item: Extract<TrackStreamItem, { kind: 'title' }>
  className: string
}) {
  return (
    <li data-track-cluster={item.label ?? 'unlabelled'} className={className}>
      <span
        aria-hidden="true"
        className={cn('size-2 shrink-0 rounded-full', colorClass(item.color))}
      />
      <span className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
        {item.name}
      </span>
    </li>
  )
}

/**
 * One quota as a chip.
 *
 * The gestures, and why each one (Trent, 2026-09-06):
 *   tap / click        +1
 *   swipe left         −1   "I think I want to try swiping left to reduce them"
 *   click-drag left    −1   the same handler; pointer events cover both
 *   right-click        −1   "or it could be maybe right-click to subtract one"
 *   shift-click        −1   kept, the pre-existing desktop path
 *   press and hold     open the detail sheet — this REPLACED hold-to-subtract,
 *                      which is why swipe had to take over −1 first
 *
 * The fill behind the text is the count over the target. Long titles wrap the
 * row, never the chip's text.
 */
function TrackChip({
  task,
  color,
  detailOpen,
  onOpenDetail,
  onCloseDetail,
}: {
  task: Task
  /** The cluster's colour; null paints the neutral stripe. */
  color: LabelColor | null
  detailOpen: boolean
  onOpenDetail: (task: Task) => void
  onCloseDetail: () => void
}) {
  const { state, period, log } = useTrackProgress(task)
  const press = useLongPress({ onLongPress: () => onOpenDetail(task) })
  const swipe = useHorizontalSwipe({ onSwipeLeft: () => void log(-1) })
  const suffix = period ? periodSuffix(period) : null

  return (
    <li className="max-w-full">
      <TrackChipPopover
        task={task}
        state={state}
        open={detailOpen}
        onOpenChange={(next) => {
          if (!next) onCloseDetail()
        }}
      >
        <button
          type="button"
          data-track-chip={task.id}
          onPointerDown={(e) => {
            press.onPointerDown(e)
            swipe.onPointerDown(e)
          }}
          onPointerUp={(e) => {
            press.onPointerUp()
            swipe.onPointerUp(e)
          }}
          onPointerMove={(e) => {
            press.onPointerMove(e)
            swipe.onPointerMove(e)
          }}
          onPointerLeave={press.onPointerLeave}
          onPointerCancel={swipe.onPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault()
            // Mouse only. A long-press on iOS can raise a contextmenu of its own,
            // and that must not silently subtract when the user meant to open
            // the sheet.
            if (!press.wasTouch()) void log(-1)
          }}
          onClick={(e) => {
            // A hold opened the sheet and a swipe already logged its −1; the
            // click that trails either one is not a tap.
            if (press.didFire() || swipe.didSwipe()) return
            void log(e.shiftKey ? -1 : 1)
          }}
          aria-label={`Log one more for "${task.title}"`}
          title="Tap: +1 · Swipe left, right-click or shift-click: −1 · Hold: details"
          className={cn(
            // leading-5, not leading-none: with the chip clipping its fill, a tight line
            // box cut the descenders off "Eggs" and "Grinding" (Trent, 2026-09-05).
            // touch-action pan-y, NOT touch-manipulation: the page must keep
            // scrolling vertically while the horizontal drag belongs to us.
            // rounded-[10px] rather than a full pill, and an extra 2px of left
            // padding: at pill radius the 3px stripe is clipped into a crescent
            // and stops reading as a stripe.
            'relative flex h-7 max-w-full touch-pan-y items-center gap-1.5 overflow-hidden rounded-[10px] border pr-2.5 pl-3 text-[13px] leading-5 transition-colors select-none',
            'border-foreground/15 bg-background hover:border-foreground/40 active:scale-[0.98]',
            state.met && 'border-green-600/30',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 left-0 transition-[width] duration-300 ease-out',
              state.met ? 'bg-green-600/15' : 'bg-foreground/10',
            )}
            style={{ width: `${state.fraction * 100}%` }}
          />
          {/* After the fill, not before it: a met chip's fill runs the whole
              width, and underneath it the stripe would be tinted green. */}
          <span
            aria-hidden="true"
            className={cn('absolute inset-y-0 left-0 w-[3px]', colorClass(color))}
          />
          <span className="relative truncate">{task.title}</span>
          <span
            data-track-count
            className={cn(
              'relative text-xs whitespace-nowrap tabular-nums',
              state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
            )}
          >
            <span className="text-foreground font-medium">{state.current}</span>/{state.target}
            {/* The period, two letters, always muted — even on a met chip,
                where the count beside it goes green. It is which clock this
                counts against, not part of the score. Hidden from a screen
                reader, which gets the full period from the sr-only run. */}
            {suffix && (
              <span aria-hidden="true" className="text-muted-foreground">
                ·{suffix}
              </span>
            )}
          </span>
          {period && <span className="sr-only"> {period}</span>}
        </button>
      </TrackChipPopover>
    </li>
  )
}

function TrackRow({ task }: { task: Task }) {
  const { state, period, log } = useTrackProgress(task)

  return (
    <li
      data-track-row={task.id}
      className="hover:bg-background flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors"
    >
      {/* The rows view is the keyboard-reachable route into a quota. The chips'
          press-and-hold has no keyboard equivalent, and the popover it opens is
          anchored to a chip that does not exist here — so this goes straight to
          the editor, which is the fuller thing and where a row has the room to
          send you. */}
      <GuardedLink
        href={`/tasks/${task.id}`}
        title={`${task.title} — open`}
        className={cn(
          'hover:text-foreground basis-full truncate rounded text-left text-[15px] underline-offset-4 hover:underline sm:flex-1 sm:basis-0',
          state.met ? 'text-foreground/70' : 'text-foreground',
        )}
      >
        {task.title}
      </GuardedLink>

      {/* Fixed-width cluster, flush right: the same columns on every line. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div
          className="bg-muted relative h-1.5 w-24 overflow-hidden rounded-full sm:w-28"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.target}
          aria-valuenow={state.current}
          aria-label={`${state.current} of ${state.target}${period ? ` ${period}` : ''}`}
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300 ease-out',
              state.met ? 'bg-green-600' : 'bg-foreground/60',
            )}
            style={{ width: `${state.fraction * 100}%` }}
          />
        </div>

        <span
          data-track-count
          className={cn(
            'flex w-16 items-center justify-end gap-1 text-sm whitespace-nowrap tabular-nums',
            state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          {state.met && <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
          <span>
            <span className="text-foreground font-medium">{state.current}</span> / {state.target}
          </span>
          {period && <span className="sr-only"> {period}</span>}
        </span>

        <button
          type="button"
          onClick={() => void log(-1)}
          disabled={state.current === 0}
          aria-label={`Remove one from "${task.title}"`}
          title="Remove one"
          className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus className="size-3.5" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={() => void log(1)}
          aria-label={`Log one more for "${task.title}"`}
          title="Log one more"
          className="text-foreground hover:bg-foreground/5 flex h-7 w-14 items-center justify-center gap-1 rounded-full border text-xs font-medium transition-colors"
        >
          <Plus className="size-3.5" strokeWidth={2.5} />1
        </button>
      </div>
    </li>
  )
}
