'use client'

import { Fragment, useState } from 'react'
import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackedItems } from '@/lib/slot-view'
import {
  groupByLabel,
  periodSuffix,
  quotaGroupSummary,
  quotaShortfall,
  trackStream,
  trackStripeClass,
  type TrackStreamItem,
} from '@/lib/track'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useLongPress } from '@/hooks/useLongPress'
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe'
import {
  foldClass,
  useResponsiveFold,
  useResponsiveFolds,
  FOLD_BODY_BLOCK,
  FOLD_CHEVRON,
  FOLD_SUMMARY,
  type FoldClasses,
  type FoldState,
} from '@/hooks/useResponsiveFold'
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
 *   pushed the first task of the day below the fold on his phone, and a folded
 *   one-liner hid the quotas). A chip is as wide as its title needs, up to the
 *   card; past that the title ellipsises, which on a phone the longest few do.
 *   The count never truncates — it is the thing the chip is for. Open the panel,
 *   or hold a chip, to read a title in full. Tap a chip: +1. Hold, or shift-click: −1.
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
 *   panel's own small uppercase run — a plain flex item, so its chips flow
 *   after it on the same line and wrap with everything else.
 * - A TITLE ALWAYS STARTS ITS OWN ROW (Trent, 2026-09-09, on the dev build).
 *   The mockup let a title attach after the previous cluster's last chip, which
 *   is what made variation G the shortest of the seven drawn — but "house"
 *   landing mid-row after a health chip read as confusing rather than compact.
 *   A zero-height full-width `<li>` before each title after the first forces
 *   the wrap; the title itself keeps no left margin, so it sits flush with the
 *   card's left edge and the chips follow it across. The break is layout only,
 *   which is why it lives here and not in `trackStream`.
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
 *   reserved for "met", so `trackStripeClass` declines it: a label the user
 *   coloured green gets a neutral stripe HERE, and keeps its green chips
 *   everywhere else.
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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO NEW FOLDS, BOTH SHUT ON A PHONE (Trent, 2026-09-15: "I just need a way on
 * mobile to be able to immediately see my tasks").
 *
 * The panel outgrew itself. At 22 quotas it is 350-500px tall, and on a phone —
 * under a filter chip stack that wraps to a dozen rows — it put the first task
 * of the day roughly three screens down. Neither fold changes anything a
 * desktop user sees; both default to shut below `sm` and open at or above it,
 * in CSS, so the first paint is already right (see `useResponsiveFold`).
 *
 * 1. THE SECTION FOLD hides the whole card, leaving one line: `TRACK · 8 of 22
 *    left`. It is a SECOND header button, `sm:hidden`, sitting beside the
 *    original one rather than replacing it. The original button means something
 *    else entirely — chips versus full rows — and folding that meaning into a
 *    single chevron would have made one control mean two things depending on
 *    the width it was pressed at.
 *
 *    That pair left the phone with no handle on chips-versus-rows at all, and
 *    `track_expanded` is a SERVER preference: a user who switched to rows at a
 *    desk arrived on his phone stuck in the taller view with nothing to press.
 *    So the card carries its own `sm:hidden` "Show as chips / Show as rows"
 *    link at its foot. Inside the card rather than beside the header, because
 *    it is only worth offering once there is something to look at, and a word
 *    rather than a chevron because the two folds on this panel already own
 *    every chevron in sight.
 * 2. THE GROUP FOLDS make each label cluster independently collapsible. A shut
 *    cluster shows a 30×3 meter filled to met/count and "{n} left" — or "✓ all
 *    met", at which point the whole header steps back in opacity so a finished
 *    category stops competing for attention.
 *
 * "{n} left" COUNTS QUOTAS STILL SHORT, not items and not increments remaining
 * (Trent picked it over both). It is the only one of the three that moves as he
 * logs progress, and it answers the one question a shut header has to answer:
 * is opening this worth it. `quotaGroupSummary` is the single source for it.
 */

/**
 * The card, folded away by the section fold.
 *
 * "Shut" only hides it BELOW `sm`, which is not a typo. The section fold is a
 * phone affordance and its button is `sm:hidden`; a user who shuts the panel on
 * a phone and then widens the window would otherwise be left with a hidden card
 * and no control anywhere that reopens it.
 */
const SECTION_CARD: FoldClasses = {
  open: 'block',
  shut: 'hidden sm:block',
  auto: 'hidden sm:block',
}

/** The one-line stand-in for the folded card. Mirrors `SECTION_CARD`. */
const SECTION_SUMMARY: FoldClasses = {
  open: 'hidden',
  shut: 'flex sm:hidden',
  auto: 'flex sm:hidden',
}

/**
 * A cluster heading's width in the wrapping chip row.
 *
 * Open, it is auto — the whole point of the layout is that the chips flow after
 * the heading on its line. Shut, there are no chips to flow, and the heading
 * takes the full row so its meter and count can sit flush right.
 */
const CLUSTER_BASIS: FoldClasses = {
  open: '',
  shut: 'basis-full',
  auto: 'basis-full sm:basis-auto',
}

/** A met cluster steps back — but only while it is shut and standing in for its chips. */
const CLUSTER_MET_DIM: FoldClasses = {
  open: '',
  shut: 'opacity-60',
  auto: 'opacity-60 sm:opacity-100',
}

/** A quota row in the open panel. As `FOLD_BODY_BLOCK`, for a row that is a flex line. */
const CLUSTER_ROW: FoldClasses = {
  open: 'flex',
  shut: 'hidden',
  auto: 'hidden sm:flex',
}

export function TrackPanel({ tasks }: { tasks: Task[] }) {
  const { trackExpanded: open, setTrackExpanded: setOpen } = useTrackPanelPreference()
  const { labelConfig } = useLabelConfig()
  // The quota whose detail sheet is showing. Held by id rather than by object
  // so a sync refresh replaces the rendered task underneath an open sheet.
  const [detailId, setDetailId] = useState<number | null>(null)
  const section = useResponsiveFold('track-section')
  const clusters = useResponsiveFolds('track-cluster')
  const quotas = trackedItems(tasks)
  const items = trackStream(quotas, labelConfig)

  // What each cluster's shut header says. Keyed the same way the DOM is, so a
  // heading and its summary can never be looking at different groups.
  const summaries = new Map(
    groupByLabel(quotas).map((g) => [clusterKey(g.label), quotaGroupSummary(g.tasks)]),
  )

  const stream = withClusters(items)

  if (quotas.length === 0) return null

  const total = quotaGroupSummary(quotas)
  const shortfall = quotaShortfall(total)

  return (
    <section aria-label="Track" data-track-panel className="mb-6">
      {/* Phone: the section fold. One line when shut, and the line carries the
          number that says whether opening it is worth it. */}
      <button
        type="button"
        data-track-section-toggle
        onClick={section.toggle}
        aria-expanded={section.open}
        aria-controls="track-card"
        className="hover:text-foreground mb-2 flex min-h-7 w-full items-center gap-2 px-1 text-left transition-colors sm:hidden"
      >
        <span className="-mr-1.5 flex items-center justify-center p-0.5">
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
              foldClass(section.state, FOLD_CHEVRON),
            )}
          />
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Track
        </span>
        <span
          data-track-section-summary
          className={cn(
            'ml-auto items-center gap-0.5 text-xs whitespace-nowrap tabular-nums',
            shortfall.allMet ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
            foldClass(section.state, SECTION_SUMMARY),
          )}
        >
          {shortfall.allMet && <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
          {shortfall.full}
        </span>
      </button>

      {/* A plain group header, built exactly like "Early morning" below —
          same padding, chevron size and negative margin — so the carets and
          labels line up. The caret switches the card between chips and the
          full rows. `hidden … sm:flex` rather than a bare `flex`: this is the
          desktop half of the header pair, and the two display utilities would
          otherwise fight over which one wins. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Collapse Track' : 'Expand Track'}
        className="hover:text-foreground mb-2 hidden min-h-7 w-full items-center gap-2 px-1 text-left transition-colors sm:flex"
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

      <div
        id="track-card"
        className={cn('bg-muted/30 rounded-2xl p-2', foldClass(section.state, SECTION_CARD))}
      >
        {open ? (
          <ul aria-label="Quotas">
            {stream.map(({ item, cluster }) =>
              item.kind === 'title' ? (
                <ClusterTitle
                  key={`title-${cluster}`}
                  item={item}
                  summary={summaries.get(cluster)}
                  state={clusters.stateOf(cluster)}
                  open={clusters.isOpen(cluster)}
                  onToggle={() => clusters.toggle(cluster)}
                  className="px-2 pt-3 pb-1 first:pt-1"
                />
              ) : (
                <TrackRow
                  key={item.task.id}
                  task={item.task}
                  foldClassName={foldClass(clusters.stateOf(cluster), CLUSTER_ROW)}
                />
              ),
            )}
          </ul>
        ) : (
          // One wrapping row for the whole panel: titles and chips are peers in
          // it, which is the entire trick — see the block comment above.
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Quotas">
            {stream.map(({ item, cluster }, i) =>
              item.kind === 'title' ? (
                <Fragment key={`title-${cluster}`}>
                  {/* The wrap that puts this title at the start of a row. A
                      full-basis, zero-height item fills whatever is left of the
                      line above and takes no height of its own; the row gap on
                      either side of it is the space between clusters. Not
                      before the first title, which already starts row one. */}
                  {i > 0 && <li aria-hidden="true" className="h-0 basis-full" />}
                  <ClusterTitle
                    item={item}
                    summary={summaries.get(cluster)}
                    state={clusters.stateOf(cluster)}
                    open={clusters.isOpen(cluster)}
                    onToggle={() => clusters.toggle(cluster)}
                    className={cn(
                      'max-w-full',
                      foldClass(clusters.stateOf(cluster), CLUSTER_BASIS),
                    )}
                  />
                </Fragment>
              ) : (
                <TrackChip
                  key={item.task.id}
                  task={item.task}
                  color={item.color}
                  foldClassName={foldClass(clusters.stateOf(cluster), FOLD_BODY_BLOCK)}
                  detailOpen={detailId === item.task.id}
                  onOpenDetail={(t) => setDetailId(t.id)}
                  onCloseDetail={() => setDetailId(null)}
                />
              ),
            )}
          </ul>
        )}

        {/* The phone's only route between chips and rows. See the block comment
            above: the desktop header button that does this is `sm:hidden`'s
            opposite number, and without this one a `track_expanded` pinned on a
            desktop was unreachable on a phone. Right-aligned and muted — it is
            a way out of a view, not a thing to press on the way in. */}
        <div className="mt-1 flex justify-end sm:hidden">
          <button
            type="button"
            data-track-view-toggle
            onClick={() => setOpen(!open)}
            className="text-muted-foreground hover:text-foreground px-2 py-1 text-[11px] font-medium transition-colors"
          >
            {open ? 'Show as chips' : 'Show as rows'}
          </button>
        </div>
      </div>
    </section>
  )
}

/**
 * Tag every item in the flat stream with the cluster it belongs to.
 *
 * The stream is title-then-its-chips by construction, so the last title seen
 * names the current cluster. Done here rather than in `trackStream` because the
 * cluster key is what the FOLDS are keyed by, and nothing outside this file
 * needs it — `tr-track-stream.test.ts` pins the stream's shape, and a field
 * only the panel reads has no business widening it.
 *
 * A module function, not a loop in the component: the React Compiler rejects
 * reassigning a captured variable inside a callback in a render body, and the
 * accumulator is exactly that.
 */
function withClusters(items: TrackStreamItem[]): { item: TrackStreamItem; cluster: string }[] {
  let cluster = ''
  return items.map((item) => {
    if (item.kind === 'title') cluster = clusterKey(item.label)
    return { item, cluster }
  })
}

/**
 * The grouping key a title carries in the DOM.
 *
 * The EMPTY STRING for the unlabelled cluster, not the word "unlabelled" or
 * "other": a label with either of those names is legal, and would then share a
 * key — and a selector — with the group of quotas that have no label at all.
 * A label name is validated non-empty and trimmed (`validateLabelConfig`,
 * `createLabel`), so "" is the one key no label can take.
 */
function clusterKey(label: string | null): string {
  return label ?? ''
}

/**
 * A cluster's heading, and the control that folds the cluster.
 *
 * `whitespace-nowrap` so "job-hunt" never breaks at its hyphen, with
 * `max-w-full truncate` behind it so a very long label ellipsises at the card's
 * edge instead of pushing out of it.
 *
 * The meter is `aria-hidden` and carries no `role`: it is a redraw of the "{n}
 * left" text beside it, and a second `progressbar` here would be noise to a
 * screen reader and a collision for anything counting the panel's real ones.
 */
function ClusterTitle({
  item,
  summary,
  state,
  open,
  onToggle,
  className,
}: {
  item: Extract<TrackStreamItem, { kind: 'title' }>
  summary: { count: number; met: number } | undefined
  state: FoldState
  open: boolean
  onToggle: () => void
  className: string
}) {
  const count = summary?.count ?? 0
  const met = summary?.met ?? 0
  const shortfall = quotaShortfall({ count, met })
  const allMet = shortfall.allMet

  return (
    <li data-track-cluster={clusterKey(item.label)} className={className}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'hover:text-foreground flex w-full items-center gap-1.5 text-left transition-opacity',
          allMet && foldClass(state, CLUSTER_MET_DIM),
        )}
      >
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', trackStripeClass(item.color))}
        />
        <span
          data-track-cluster-name
          className="text-muted-foreground min-w-0 truncate text-[11px] font-semibold tracking-widest uppercase"
        >
          {item.name}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
            foldClass(state, FOLD_CHEVRON),
          )}
        />

        <span
          data-track-cluster-summary
          className={cn(
            'ml-auto items-center gap-1.5 pl-2 text-[11px] whitespace-nowrap tabular-nums',
            allMet ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
            foldClass(state, FOLD_SUMMARY),
          )}
        >
          <span
            aria-hidden="true"
            className="bg-muted relative block h-[3px] w-[30px] overflow-hidden rounded-full"
          >
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300 ease-out',
                allMet ? 'bg-green-600' : 'bg-foreground/60',
              )}
              style={{ width: `${count === 0 ? 0 : (met / count) * 100}%` }}
            />
          </span>
          {shortfall.allMet ? (
            <span className="flex items-center gap-0.5">
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              {shortfall.short}
            </span>
          ) : (
            <span>{shortfall.short}</span>
          )}
        </span>
      </button>
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
  foldClassName,
  detailOpen,
  onOpenDetail,
  onCloseDetail,
}: {
  task: Task
  /** The cluster's colour; null paints the neutral stripe. */
  color: LabelColor | null
  /** Display classes from the cluster's fold — see `FOLD_BODY_BLOCK`. */
  foldClassName: string
  detailOpen: boolean
  onOpenDetail: (task: Task) => void
  onCloseDetail: () => void
}) {
  const { state, period, log } = useTrackProgress(task)
  const press = useLongPress({ onLongPress: () => onOpenDetail(task) })
  const swipe = useHorizontalSwipe({ onSwipeLeft: () => void log(-1) })
  const suffix = period ? periodSuffix(period) : null

  return (
    <li className={cn('max-w-full', foldClassName)}>
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
          // The count is IN the accessible name, not beside it. `aria-label`
          // replaces a button's contents wholesale, so the count on screen and
          // any sr-only run inside are never announced — and in the folded
          // panel this chip is now the only progress there is, the period
          // card's `progressbar` having gone with the cards.
          aria-label={`Log one more for "${task.title}" — ${state.current} of ${state.target}${
            period ? ` ${period}` : ''
          }`}
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
            className={cn('absolute inset-y-0 left-0 w-[3px]', trackStripeClass(color))}
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
                counts against, not part of the score. Sighted-only by
                construction: the button's `aria-label` spells the period out
                in full. */}
            {suffix && <span className="text-muted-foreground">·{suffix}</span>}
          </span>
        </button>
      </TrackChipPopover>
    </li>
  )
}

function TrackRow({ task, foldClassName }: { task: Task; foldClassName: string }) {
  const { state, period, log } = useTrackProgress(task)

  return (
    <li
      data-track-row={task.id}
      className={cn(
        'hover:bg-background flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors',
        foldClassName,
      )}
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
          // The count is IN the accessible name, not beside it. `aria-label`
          // replaces a button's contents wholesale, so the count on screen and
          // any sr-only run inside are never announced — and in the folded
          // panel this chip is now the only progress there is, the period
          // card's `progressbar` having gone with the cards.
          aria-label={`Log one more for "${task.title}" — ${state.current} of ${state.target}${
            period ? ` ${period}` : ''
          }`}
          title="Log one more"
          className="text-foreground hover:bg-foreground/5 flex h-7 w-14 items-center justify-center gap-1 rounded-full border text-xs font-medium transition-colors"
        >
          <Plus className="size-3.5" strokeWidth={2.5} />1
        </button>
      </div>
    </li>
  )
}
