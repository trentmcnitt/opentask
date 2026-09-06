'use client'

import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackedItems } from '@/lib/slot-view'
import { periodLabel, trackSummary } from '@/lib/track'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useLongPress } from '@/hooks/useLongPress'
import { useTrackPanelPreference } from '@/components/PreferencesProvider'
import type { Task } from '@/types'

/**
 * Track (REDESIGN-V03 §5): the quotas' home on the Tasks page.
 *
 * Trent, on the first cut (quotas as full task rows at the top of "Anytime
 * today"): "the alignment is all weird and the things just look sloppy…
 * wherever they go, it can't be buried on the Tasks page." So the quotas are
 * an instrument panel above the day, not rows inside it:
 *
 * - One line per quota, every line the same shape: title · bar · count · − · +1.
 *   The control cluster has fixed widths and sits flush right, so the eight
 *   lines align as one object. No circle, no stripes, no AI commentary, no
 *   recurrence glyph — none of that is what a counter is about.
 * - The panel is a plain group header ("TRACK") over one CARD per
 *   period — the Reminders slot card: word, count, a hairline that fills as
 *   the period goes. Two states, remembered as a user preference like the
 *   filter section. FOLDED (the default) each card holds its quotas as tight
 *   CHIPS with their full titles,
 *   wrapping wherever the width runs out (Trent, 2026-09-05: eight open rows
 *   pushed the first task of the day below the fold on his phone; a folded
 *   one-liner hid the quotas; chips with truncated titles were rejected, so
 *   nothing here is ever cut). Tap a chip: +1. Hold it, or shift-click: −1.
 *   The chip's background fills as the count climbs and turns green at the
 *   target, so each chip is its own bar. OPEN, it is the full rows below.
 *   It always comes first.
 * - Order is by title and never changes on a tap — the widget's "order jumps
 *   under your finger" complaint applied verbatim here.
 * - "Met" is a state, not an exit: green check, count keeps going (3/2).
 *
 * Tracked tasks still appear as plain rows in the All / Projects lists (with a
 * "0 / 4" chip and no controls); logging happens here.
 */
export function TrackPanel({ tasks }: { tasks: Task[] }) {
  const { trackExpanded: open, setTrackExpanded: setOpen } = useTrackPanelPreference()
  const quotas = trackedItems(tasks)
  if (quotas.length === 0) return null

  // Quotas are grouped by period. With one period the header names it; with
  // several, the header says nothing and each group sits under its own
  // labelled hairline ("this week" / "this month"). Trent (2026-09-05): a
  // period word on every chip was repetition, and still didn't tell a week
  // from a month at a glance. The word appears once, on the divider.
  // No total on the header: the cards carry their own counts, and a header
  // count sat outside the cards' right edge (Trent, 2026-09-05).
  const groups = groupByPeriod(quotas)

  return (
    <section aria-label="Track" data-track-panel className="mb-6">
      {/* A plain group header, built exactly like "Early morning" below —
          same padding, chevron size and negative margin — so the carets and
          labels line up. The caret switches every card between chips and
          the full rows. */}
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

      {/* One card per period — the Reminders slot card: word top-left, count
          top-right, a full-width hairline that fills as the period goes, then
          the quotas (Trent chose this over nested boxes, 2026-09-05). */}
      <div className="space-y-2.5">
        {groups.map((g) => (
          <PeriodCard key={g.period ?? 'none'} period={g.period} tasks={g.tasks} open={open} />
        ))}
      </div>
    </section>
  )
}

function PeriodCard({
  period,
  tasks,
  open,
}: {
  period: string | null
  tasks: Task[]
  open: boolean
}) {
  const word = period ? periodShort(period) : 'no period'
  const s = trackSummary(tasks)
  const met = s.total > 0 && s.done >= s.total
  return (
    <div className="bg-muted/30 rounded-2xl px-2 pt-2 pb-2.5" data-track-period={word}>
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
          {word}
        </span>
        <span
          className={cn(
            'ml-auto text-xs whitespace-nowrap tabular-nums',
            met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          <span className="text-foreground font-medium">{s.done}</span> of {s.total}
        </span>
      </div>
      <div
        className="bg-muted mx-1 mb-2.5 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={s.total}
        aria-valuenow={s.done}
        aria-label={`${s.done} of ${s.total} ${period ?? ''}`.trim()}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
            met ? 'bg-green-600' : 'bg-foreground/50',
          )}
          style={{ width: `${s.total > 0 ? (s.done / s.total) * 100 : 0}%` }}
        />
      </div>
      {open ? (
        <ul aria-label={word}>
          {tasks.map((task) => (
            <TrackRow key={task.id} task={task} />
          ))}
        </ul>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label={word}>
          {tasks.map((task) => (
            <TrackChip key={task.id} task={task} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** "this week" → "week", for the card's word. */
function periodShort(period: string): string {
  return period.replace(/^this /, '').replace(/^today$/, 'day')
}

/**
 * One quota as a chip. The whole chip is the +1 button; a hold (400 ms, the
 * app's long-press) or a shift-click is −1. The fill behind the text is the
 * count over the target. Long titles wrap the row, never the chip's text.
 */
function TrackChip({ task }: { task: Task }) {
  const { state, period, log } = useTrackProgress(task)
  const press = useLongPress({ onLongPress: () => void log(-1) })

  return (
    <li className="max-w-full">
      <button
        type="button"
        data-track-chip={task.id}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerMove={press.onPointerMove}
        onPointerLeave={press.onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => {
          // A hold already logged its −1; the click that follows it is not a tap.
          if (press.didFire()) return
          void log(e.shiftKey ? -1 : 1)
        }}
        aria-label={`Log one more for "${task.title}"`}
        title="Tap: +1 · Hold or shift-click: −1"
        className={cn(
          // leading-5, not leading-none: with the chip clipping its fill, a tight line
          // box cut the descenders off "Eggs" and "Grinding" (Trent, 2026-09-05).
          'relative flex h-7 max-w-full touch-manipulation items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-[13px] leading-5 transition-colors select-none',
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
        <span className="relative truncate">{task.title}</span>
        <span
          data-track-count
          className={cn(
            'relative text-xs whitespace-nowrap tabular-nums',
            state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          <span className="text-foreground font-medium">{state.current}</span>/{state.target}
        </span>
        {period && <span className="sr-only"> {period}</span>}
      </button>
    </li>
  )
}

/** Quotas by period, in day-to-year order, each group in title order (as given). */
function groupByPeriod(quotas: Task[]): { period: string | null; tasks: Task[] }[] {
  const order = ['today', 'this week', 'this month', 'this year', null]
  const by = new Map<string | null, Task[]>()
  for (const t of quotas) {
    const p = periodLabel(t.rrule)
    by.set(p, [...(by.get(p) ?? []), t])
  }
  return order.filter((p) => by.has(p)).map((p) => ({ period: p, tasks: by.get(p)! }))
}

function TrackRow({ task }: { task: Task }) {
  const { state, period, log } = useTrackProgress(task)

  return (
    <li
      data-track-row={task.id}
      className="hover:bg-background flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors"
    >
      <span
        className={cn(
          'basis-full truncate text-[15px] sm:flex-1 sm:basis-0',
          state.met ? 'text-foreground/70' : 'text-foreground',
        )}
        title={task.title}
      >
        {task.title}
      </span>

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
